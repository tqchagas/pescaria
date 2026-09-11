import Database from 'better-sqlite3';
import { resolve, join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { FishInstance, User, UserWithInventory } from '../shared/types.js';

const DATA_DIR = resolve(process.cwd(), 'data');
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = join(DATA_DIR, 'pescaria.db');
export const db = new Database(DB_PATH);

// Configuração de WAL (Write-Ahead Logging) para alta concorrência e integridade
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
    // Atualiza nome se tiver mudado
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

/**
 * Adiciona um peixe pescado ao inventário do jogador com validação de capacidade máxima
 */
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

/**
 * Remove (solta) um peixe do inventário para liberar espaço
 */
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

/**
 * Executa a troca atômica entre dois jogadores utilizando transação do SQLite
 */
export function executeTradeTransaction(
  userAId: string,
  userBId: string,
  itemAIds: string[],
  itemBIds: string[],
  sessionId: string = 'direct_trade'
): { success: boolean; error?: string; inventoryA?: FishInstance[]; inventoryB?: FishInstance[] } {
  const transaction = db.transaction(() => {
    // 1. Obter inventários atuais com lock
    const invA = getUserInventory(userAId);
    const invB = getUserInventory(userBId);

    const userA = getUserById(userAId);
    const userB = getUserById(userBId);

    if (!userA || !userB) {
      throw new Error('Um dos participantes não foi encontrado.');
    }

    // 2. Validar que cada item pertence ao respectivo jogador
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

    // 3. Validar limites de mochila pós-troca
    const finalCountA = invA.length - itemAIds.length + itemBIds.length;
    if (finalCountA > userA.maxBackpackCapacity) {
      throw new Error(`${userA.name} excederá a capacidade da mochila (${finalCountA}/${userA.maxBackpackCapacity}).`);
    }

    const finalCountB = invB.length - itemBIds.length + itemAIds.length;
    if (finalCountB > userB.maxBackpackCapacity) {
      throw new Error(`${userB.name} excederá a capacidade da mochila (${finalCountB}/${userB.maxBackpackCapacity}).`);
    }

    // 4. Efetuar a troca de posse dos itens de A para B
    const updateStmt = db.prepare('UPDATE inventory SET user_id = ? WHERE id = ?');
    for (const id of itemAIds) {
      updateStmt.run(userBId, id);
    }

    // 5. Efetuar a troca de posse dos itens de B para A
    for (const id of itemBIds) {
      updateStmt.run(userAId, id);
    }

    // 6. Registrar histórico de auditoria
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
