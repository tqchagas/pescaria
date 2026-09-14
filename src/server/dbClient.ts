import { createClient, type Client, type InArgs, type Transaction } from '@libsql/client';
import { resolve, join } from 'path';
import { existsSync, mkdirSync } from 'fs';

/**
 * Driver de banco unificado (libSQL / Turso).
 *
 * - Produção (Vercel): usa o banco remoto Turso via TURSO_DATABASE_URL.
 *   Persistência real — o /tmp do Lambda é efêmero e apagava álbum, streak e mochila
 *   a cada cold start.
 * - Desenvolvimento: usa um arquivo SQLite local (file:) com o MESMO driver,
 *   então não existe divergência de comportamento entre dev e prod.
 */

const isServerless = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

function buildClient(): { client: Client; mode: 'turso' | 'local-file' | 'ephemeral' } {
  const remoteUrl = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();

  if (remoteUrl) {
    return {
      client: createClient({ url: remoteUrl, authToken }),
      mode: 'turso',
    };
  }

  if (isServerless) {
    // Sem Turso configurado em serverless: o app sobe, mas avisa alto que os dados morrem.
    console.warn(
      '[db] TURSO_DATABASE_URL ausente em ambiente serverless. ' +
        'Usando /tmp/pescaria.db EFÊMERO — álbum, streak e mochila serão perdidos no próximo cold start. ' +
        'Configure TURSO_DATABASE_URL e TURSO_AUTH_TOKEN.'
    );
    return {
      client: createClient({ url: 'file:/tmp/pescaria.db' }),
      mode: 'ephemeral',
    };
  }

  const dataDir = resolve(process.cwd(), 'data');
  if (!existsSync(dataDir)) {
    try {
      mkdirSync(dataDir, { recursive: true });
    } catch {
      // Ignora se já existir
    }
  }

  return {
    client: createClient({ url: `file:${join(dataDir, 'pescaria.db')}` }),
    mode: 'local-file',
  };
}

const { client, mode } = buildClient();

export const dbMode = mode;
export const isRemoteDb = mode === 'turso';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL COLLATE NOCASE,
    created_at TEXT NOT NULL,
    max_backpack_capacity INTEGER NOT NULL DEFAULT 20,
    last_catch_at INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS inventory (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    species_id TEXT NOT NULL,
    name TEXT NOT NULL,
    rarity INTEGER NOT NULL,
    weight INTEGER NOT NULL,
    formatted_weight TEXT NOT NULL,
    caught_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS trade_history (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    user_a_id TEXT NOT NULL,
    user_b_id TEXT NOT NULL,
    items_a TEXT NOT NULL,
    items_b TEXT NOT NULL,
    completed_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS fish_records (
    user_id TEXT NOT NULL,
    species_id TEXT NOT NULL,
    max_weight INTEGER NOT NULL,
    first_caught_at TEXT NOT NULL,
    last_caught_at TEXT NOT NULL,
    times_caught INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (user_id, species_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS daily_activity (
    user_id TEXT NOT NULL,
    day TEXT NOT NULL,
    catches_count INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (user_id, day),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS player_heartbeats (
    user_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    status TEXT NOT NULL,
    last_seen INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS serverless_trades (
    session_id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_inventory_user ON inventory(user_id);
  CREATE INDEX IF NOT EXISTS idx_heartbeat_seen ON player_heartbeats(last_seen);
  CREATE INDEX IF NOT EXISTS idx_trades_updated ON serverless_trades(updated_at);
`;

// Migrações para bancos criados antes de uma coluna existir.
const MIGRATIONS = [
  'ALTER TABLE users ADD COLUMN last_catch_at INTEGER NOT NULL DEFAULT 0',
];

let initPromise: Promise<void> | null = null;

async function init(): Promise<void> {
  await client.executeMultiple(SCHEMA);

  for (const migration of MIGRATIONS) {
    try {
      await client.execute(migration);
    } catch {
      // Coluna já existe — esperado em bancos já migrados.
    }
  }
}

/** Garante que o schema existe antes de qualquer query. Idempotente. */
export function ready(): Promise<void> {
  if (!initPromise) {
    initPromise = init().catch((err) => {
      // Permite nova tentativa no próximo request em vez de travar o processo pra sempre.
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

type Row = Record<string, any>;

function mapRows(columns: readonly string[], rows: readonly unknown[][]): Row[] {
  return rows.map((row) => {
    const obj: Row = {};
    columns.forEach((col, i) => {
      obj[col] = (row as any)[i];
    });
    return obj;
  });
}

export interface Queryable {
  all<T = Row>(sql: string, args?: InArgs): Promise<T[]>;
  get<T = Row>(sql: string, args?: InArgs): Promise<T | undefined>;
  run(sql: string, args?: InArgs): Promise<{ changes: number }>;
}

function makeQueryable(exec: (sql: string, args?: InArgs) => Promise<any>): Queryable {
  return {
    async all<T = Row>(sql: string, args: InArgs = []): Promise<T[]> {
      const rs = await exec(sql, args);
      return mapRows(rs.columns, rs.rows as unknown as unknown[][]) as T[];
    },
    async get<T = Row>(sql: string, args: InArgs = []): Promise<T | undefined> {
      const rs = await exec(sql, args);
      const mapped = mapRows(rs.columns, rs.rows as unknown as unknown[][]);
      return mapped[0] as T | undefined;
    },
    async run(sql: string, args: InArgs = []): Promise<{ changes: number }> {
      const rs = await exec(sql, args);
      return { changes: Number(rs.rowsAffected ?? 0) };
    },
  };
}

/** Queries fora de transação. Sempre aguarda o schema. */
export const q: Queryable = makeQueryable(async (sql, args) => {
  await ready();
  return client.execute({ sql, args: args ?? [] });
});

/**
 * Transação interativa de escrita: tudo ou nada.
 * Funciona igual no arquivo local e no Turso remoto.
 */
export async function withTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
  await ready();
  const transaction: Transaction = await client.transaction('write');
  const scoped = makeQueryable((sql, args) => transaction.execute({ sql, args: args ?? [] }));

  try {
    const result = await fn(scoped);
    await transaction.commit();
    return result;
  } catch (err) {
    try {
      await transaction.rollback();
    } catch {
      // Transação já encerrada pelo servidor.
    }
    throw err;
  }
}

export { client };
