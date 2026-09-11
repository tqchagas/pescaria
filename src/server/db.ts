import Database from 'better-sqlite3';
import { resolve, join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { FishInstance, User, UserWithInventory, OnlinePlayer, TradeSession } from '../shared/types.js';

// No Vercel/AWS Lambda, o único diretório com permissão de escrita é o /tmp
const isServerless = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const DATA_DIR = isServerless ? '/tmp' : resolve(process.cwd(), 'data');

if (!existsSync(DATA_DIR)) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
  } catch {
    // Ignora erro se já existir
  }
}

const DB_PATH = join(DATA_DIR, 'pescaria.db');
export const db = new Database(DB_PATH);

// Configurações para desempenho e integridade
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Inicialização das tabelas
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL COLLATE NOCASE,
    created_at TEXT NOT NULL,
    max_backpack_capacity INTEGER NOT NULL DEFAULT 20
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

  -- Suporte para Heartbeat de Jogadores Online no ambiente Serverless da Vercel
  CREATE TABLE IF NOT EXISTS player_heartbeats (
    user_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    status TEXT NOT NULL,
    last_seen INTEGER NOT NULL
  );

  -- Suporte para Sessões de Troca no ambiente Serverless da Vercel
  CREATE TABLE IF NOT EXISTS serverless_trades (
    session_id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_inventory_user ON inventory(user_id);
`);

/**
 * Normaliza e busca ou cria o usuário pelo e-mail
 */
export function findOrCreateUser(name: string, email: string): UserWithInventory {
  const cleanEmail = email.trim().toLowerCase();
  const cleanName = name.trim();

  const existing = db
    .prepare('SELECT id, name, email, created_at, max_backpack_capacity FROM users WHERE email = ?')
    .get(cleanEmail) as { id: string; name: string; email: string; created_at: string; max_backpack_capacity: number } | undefined;

  let user: User;

  if (existing) {
    user = {
      id: existing.id,
      name: existing.name,
      email: existing.email,
      createdAt: existing.created_at,
      maxBackpackCapacity: existing.max_backpack_capacity,
    };
    if (existing.name !== cleanName && cleanName.length > 0) {
      db.prepare('UPDATE users SET name = ? WHERE id = ?').run(cleanName, existing.id);
      user.name = cleanName;
    }
  } else {
    const userId = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `usr_${Date.now()}`;
    const createdAt = new Date().toISOString();
    db.prepare(`
      INSERT INTO users (id, name, email, created_at, max_backpack_capacity)
      VALUES (?, ?, ?, ?, 20)
    `).run(userId, cleanName, cleanEmail, createdAt);

    user = {
      id: userId,
      name: cleanName,
      email: cleanEmail,
      createdAt,
      maxBackpackCapacity: 20,
    };
  }

  const inventory = getUserInventory(user.id);
  return { ...user, inventory };
}

export function getUserById(id: string): UserWithInventory | null {
  const row = db
    .prepare('SELECT id, name, email, created_at, max_backpack_capacity FROM users WHERE id = ?')
    .get(id) as { id: string; name: string; email: string; created_at: string; max_backpack_capacity: number } | undefined;

  if (!row) return null;

  return {
    id: row.id,
    name: row.name,
    email: row.email,
    createdAt: row.created_at,
    maxBackpackCapacity: row.max_backpack_capacity,
    inventory: getUserInventory(row.id),
  };
}

export function getUserByEmail(email: string): UserWithInventory | null {
  const cleanEmail = email.trim().toLowerCase();
  const row = db
    .prepare('SELECT id, name, email, created_at, max_backpack_capacity FROM users WHERE email = ?')
    .get(cleanEmail) as { id: string; name: string; email: string; created_at: string; max_backpack_capacity: number } | undefined;

  if (!row) return null;

  return {
    id: row.id,
    name: row.name,
    email: row.email,
    createdAt: row.created_at,
    maxBackpackCapacity: row.max_backpack_capacity,
    inventory: getUserInventory(row.id),
  };
}

export function getUserInventory(userId: string): FishInstance[] {
  const rows = db
    .prepare(`
      SELECT id, species_id as speciesId, name, rarity, weight, formatted_weight as formattedWeight, caught_at as caughtAt, user_id as userId
      FROM inventory
      WHERE user_id = ?
      ORDER BY datetime(caught_at) DESC
    `)
    .all(userId) as FishInstance[];

  return rows;
}

export function addFishToInventory(
  userId: string,
  fish: FishInstance
): { success: boolean; inventory: FishInstance[]; error?: string } {
  const user = getUserById(userId);
  if (!user) {
    return { success: false, inventory: [], error: 'Jogador não encontrado.' };
  }

  const currentCount = user.inventory.length;
  if (currentCount >= user.maxBackpackCapacity) {
    return {
      success: false,
      inventory: user.inventory,
      error: `A mochila está cheia! Capacidade máxima atingida (${user.maxBackpackCapacity} peixes).`,
    };
  }

  const stmt = db.prepare(`
    INSERT INTO inventory (id, user_id, species_id, name, rarity, weight, formatted_weight, caught_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    fish.id,
    userId,
    fish.speciesId,
    fish.name,
    fish.rarity,
    fish.weight,
    fish.formattedWeight,
    fish.caughtAt
  );

  const updatedInventory = getUserInventory(userId);
  return { success: true, inventory: updatedInventory };
}

export function removeFishFromInventory(
  userId: string,
  fishId: string
): { success: boolean; inventory: FishInstance[]; error?: string } {
  const stmt = db.prepare('DELETE FROM inventory WHERE id = ? AND user_id = ?');
  const result = stmt.run(fishId, userId);

  if (result.changes === 0) {
    return {
      success: false,
      inventory: getUserInventory(userId),
      error: 'Peixe não encontrado no seu inventário.',
    };
  }

  return { success: true, inventory: getUserInventory(userId) };
}

export function executeTradeTransaction(
  userAId: string,
  userBId: string,
  itemAIds: string[],
  itemBIds: string[],
  sessionId: string = 'direct_trade'
): { success: boolean; error?: string; inventoryA?: FishInstance[]; inventoryB?: FishInstance[] } {
  const transaction = db.transaction(() => {
    const invA = getUserInventory(userAId);
    const invB = getUserInventory(userBId);

    const userA = getUserById(userAId);
    const userB = getUserById(userBId);

    if (!userA || !userB) {
      throw new Error('Um dos participantes não foi encontrado.');
    }

    const mapA = new Map(invA.map((i) => [i.id, i]));
    const mapB = new Map(invB.map((i) => [i.id, i]));

    for (const id of itemAIds) {
      if (!mapA.has(id)) {
        throw new Error(`Jogador ${userA.name} não possui o peixe ${id} no inventário.`);
      }
    }

    for (const id of itemBIds) {
      if (!mapB.has(id)) {
        throw new Error(`Jogador ${userB.name} não possui o peixe ${id} no inventário.`);
      }
    }

    const finalCountA = invA.length - itemAIds.length + itemBIds.length;
    if (finalCountA > userA.maxBackpackCapacity) {
      throw new Error(`${userA.name} excederá a capacidade da mochila (${finalCountA}/${userA.maxBackpackCapacity}).`);
    }

    const finalCountB = invB.length - itemBIds.length + itemAIds.length;
    if (finalCountB > userB.maxBackpackCapacity) {
      throw new Error(`${userB.name} excederá a capacidade da mochila (${finalCountB}/${userB.maxBackpackCapacity}).`);
    }

    const updateStmt = db.prepare('UPDATE inventory SET user_id = ? WHERE id = ?');
    for (const id of itemAIds) {
      updateStmt.run(userBId, id);
    }
    for (const id of itemBIds) {
      updateStmt.run(userAId, id);
    }

    const tradeHistoryId = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `trade_${Date.now()}`;
    const tradedItemsA = itemAIds.map((id) => mapA.get(id));
    const tradedItemsB = itemBIds.map((id) => mapB.get(id));

    db.prepare(`
      INSERT INTO trade_history (id, session_id, user_a_id, user_b_id, items_a, items_b, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      tradeHistoryId,
      sessionId,
      userAId,
      userBId,
      JSON.stringify(tradedItemsA),
      JSON.stringify(tradedItemsB),
      new Date().toISOString()
    );

    return {
      inventoryA: getUserInventory(userAId),
      inventoryB: getUserInventory(userBId),
    };
  });

  try {
    const result = transaction();
    return {
      success: true,
      inventoryA: result.inventoryA,
      inventoryB: result.inventoryB,
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Falha ao processar a troca no banco de dados.',
    };
  }
}

export function recordFishCatch(
  userId: string,
  speciesId: string,
  weight: number
): {
  isNewDiscovery: boolean;
  isNewRecord: boolean;
  uniqueSpeciesDiscovered: number;
  catchesToday: number;
  streakDays: number;
} {
  const now = new Date();
  const nowIso = now.toISOString();
  const todayStr = nowIso.split('T')[0];

  const dailyStmt = db.prepare(`
    INSERT INTO daily_activity (user_id, day, catches_count)
    VALUES (?, ?, 1)
    ON CONFLICT(user_id, day) DO UPDATE SET catches_count = catches_count + 1
  `);
  dailyStmt.run(userId, todayStr);

  const todayRow = db
    .prepare('SELECT catches_count FROM daily_activity WHERE user_id = ? AND day = ?')
    .get(userId, todayStr) as { catches_count: number } | undefined;
  const catchesToday = todayRow ? todayRow.catches_count : 1;

  const recentDays = db
    .prepare('SELECT day FROM daily_activity WHERE user_id = ? ORDER BY day DESC LIMIT 30')
    .all(userId) as Array<{ day: string }>;
  let streakDays = 0;
  if (recentDays.length > 0) {
    let checkDate = new Date();
    checkDate.setHours(0, 0, 0, 0);

    for (const row of recentDays) {
      const rowDate = new Date(row.day + 'T00:00:00');
      const diffDays = Math.round((checkDate.getTime() - rowDate.getTime()) / (1000 * 60 * 60 * 24));
      if (diffDays <= 1) {
        streakDays++;
        checkDate = rowDate;
      } else {
        break;
      }
    }
  }
  if (streakDays === 0) streakDays = 1;

  const recordRow = db
    .prepare('SELECT max_weight FROM fish_records WHERE user_id = ? AND species_id = ?')
    .get(userId, speciesId) as { max_weight: number } | undefined;

  let isNewDiscovery = false;
  let isNewRecord = false;

  if (!recordRow) {
    isNewDiscovery = true;
    isNewRecord = true;
    db.prepare(`
      INSERT INTO fish_records (user_id, species_id, max_weight, first_caught_at, last_caught_at, times_caught)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run(userId, speciesId, weight, nowIso, nowIso);
  } else {
    if (weight > recordRow.max_weight) {
      isNewRecord = true;
      db.prepare(`
        UPDATE fish_records
        SET max_weight = ?, last_caught_at = ?, times_caught = times_caught + 1
        WHERE user_id = ? AND species_id = ?
      `).run(weight, nowIso, userId, speciesId);
    } else {
      db.prepare(`
        UPDATE fish_records
        SET last_caught_at = ?, times_caught = times_caught + 1
        WHERE user_id = ? AND species_id = ?
      `).run(nowIso, userId, speciesId);
    }
  }

  const uniqueCountRow = db
    .prepare('SELECT COUNT(*) as count FROM fish_records WHERE user_id = ?')
    .get(userId) as { count: number };

  return {
    isNewDiscovery,
    isNewRecord,
    uniqueSpeciesDiscovered: uniqueCountRow.count,
    catchesToday,
    streakDays,
  };
}

// ===================== MÉTODOS SERVERLESS PARA VERCEL =====================

/**
 * Atualiza o heartbeat de presença do jogador no ambiente serverless
 */
export function heartbeatPlayer(user: { id: string; name: string; email: string }, status: 'IDLE' | 'FISHING' | 'TRADING' = 'IDLE') {
  const now = Date.now();
  db.prepare(`
    INSERT INTO player_heartbeats (user_id, name, email, status, last_seen)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      name = excluded.name,
      email = excluded.email,
      status = excluded.status,
      last_seen = excluded.last_seen
  `).run(user.id, user.name, user.email, status, now);
}

/**
 * Retorna os jogadores ativos nos últimos 12 segundos
 */
export function getActiveOnlinePlayers(): OnlinePlayer[] {
  const cutoff = Date.now() - 12000;
  const rows = db.prepare(`
    SELECT user_id as id, name, email, status
    FROM player_heartbeats
    WHERE last_seen >= ?
    ORDER BY last_seen DESC
  `).all(cutoff) as Array<{ id: string; name: string; email: string; status: 'IDLE' | 'FISHING' | 'TRADING' }>;

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    socketId: `serverless_${r.id}`,
    status: r.status,
  }));
}

/**
 * Salva ou atualiza uma sessão de troca no banco de dados para sincronização serverless
 */
export function saveServerlessTradeSession(session: TradeSession) {
  const json = JSON.stringify(session);
  db.prepare(`
    INSERT INTO serverless_trades (session_id, data, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      data = excluded.data,
      updated_at = excluded.updated_at
  `).run(session.id, json, Date.now());
}

/**
 * Busca uma sessão de troca pelo ID
 */
export function getServerlessTradeSession(sessionId: string): TradeSession | null {
  const row = db.prepare('SELECT data FROM serverless_trades WHERE session_id = ?').get(sessionId) as { data: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.data) as TradeSession;
  } catch {
    return null;
  }
}

/**
 * Procura se existe alguma sessão de troca pendente ou ativa para o usuário
 */
export function findTradeSessionForUser(userId: string): TradeSession | null {
  const rows = db.prepare(`
    SELECT data FROM serverless_trades
    WHERE updated_at >= ?
    ORDER BY updated_at DESC
  `).all(Date.now() - 120000) as Array<{ data: string }>;

  for (const row of rows) {
    try {
      const session = JSON.parse(row.data) as TradeSession;
      if (session.status !== 'COMPLETED' && session.status !== 'CANCELLED' && session.status !== 'DECLINED') {
        if (session.sender.userId === userId || session.receiver.userId === userId) {
          return session;
        }
      }
    } catch {}
  }
  return null;
}
