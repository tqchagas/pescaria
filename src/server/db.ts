import { FishInstance, User, UserWithInventory, OnlinePlayer, TradeSession } from '../shared/types.js';
import { q, withTransaction, ready, dbMode, type Queryable } from './dbClient.js';

export { ready, dbMode };

interface UserRow {
  id: string;
  name: string;
  email: string;
  created_at: string;
  max_backpack_capacity: number;
}

const USER_COLUMNS = 'id, name, email, created_at, max_backpack_capacity';

function toUser(row: UserRow): User {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    createdAt: row.created_at,
    maxBackpackCapacity: row.max_backpack_capacity,
  };
}

function newId(prefix: string): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Normaliza e busca ou cria o usuário pelo e-mail ou id explícito
 */
export async function findOrCreateUser(
  name: string,
  email: string,
  explicitId?: string
): Promise<UserWithInventory> {
  const cleanEmail = email.trim().toLowerCase();
  const cleanName = name.trim();

  let existing = await q.get<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE email = ?`, [cleanEmail]);

  if (!existing && explicitId) {
    existing = await q.get<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, [explicitId]);
  }

  let user: User;

  if (existing) {
    user = toUser(existing);
    if (existing.name !== cleanName && cleanName.length > 0) {
      await q.run('UPDATE users SET name = ? WHERE id = ?', [cleanName, existing.id]);
      user.name = cleanName;
    }
  } else {
    const userId = explicitId || newId('usr');
    const createdAt = new Date().toISOString();
    await q.run(
      `INSERT OR REPLACE INTO users (id, name, email, created_at, max_backpack_capacity, last_catch_at)
       VALUES (?, ?, ?, ?, 20, 0)`,
      [userId, cleanName, cleanEmail, createdAt]
    );

    user = {
      id: userId,
      name: cleanName,
      email: cleanEmail,
      createdAt,
      maxBackpackCapacity: 20,
    };
  }

  const inventory = await getUserInventory(user.id);
  return { ...user, inventory };
}

/**
 * Garante que o usuário exista, auto-reidratando a partir de nome/e-mail se necessário
 */
export async function ensureUser(id: string, name?: string, email?: string): Promise<UserWithInventory | null> {
  const existing = await getUserById(id);
  if (existing) return existing;
  if (name && email) {
    return findOrCreateUser(name, email, id);
  }
  return null;
}

export async function getUserById(id: string): Promise<UserWithInventory | null> {
  const row = await q.get<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, [id]);
  if (!row) return null;
  return { ...toUser(row), inventory: await getUserInventory(row.id) };
}

export async function getUserByEmail(email: string): Promise<UserWithInventory | null> {
  const cleanEmail = email.trim().toLowerCase();
  const row = await q.get<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE email = ?`, [cleanEmail]);
  if (!row) return null;
  return { ...toUser(row), inventory: await getUserInventory(row.id) };
}

export async function getUserInventory(userId: string, conn: Queryable = q): Promise<FishInstance[]> {
  return conn.all<FishInstance>(
    `SELECT id, species_id as speciesId, name, rarity, weight,
            formatted_weight as formattedWeight, caught_at as caughtAt, user_id as userId
     FROM inventory
     WHERE user_id = ?
     ORDER BY datetime(caught_at) DESC`,
    [userId]
  );
}

export async function addFishToInventory(
  userId: string,
  fish: FishInstance
): Promise<{ success: boolean; inventory: FishInstance[]; error?: string }> {
  const user = await getUserById(userId);
  if (!user) {
    return { success: false, inventory: [], error: 'Jogador não encontrado.' };
  }

  if (user.inventory.length >= user.maxBackpackCapacity) {
    return {
      success: false,
      inventory: user.inventory,
      error: `A mochila está cheia! Capacidade máxima atingida (${user.maxBackpackCapacity} peixes).`,
    };
  }

  await q.run(
    `INSERT INTO inventory (id, user_id, species_id, name, rarity, weight, formatted_weight, caught_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [fish.id, userId, fish.speciesId, fish.name, fish.rarity, fish.weight, fish.formattedWeight, fish.caughtAt]
  );

  return { success: true, inventory: await getUserInventory(userId) };
}

export async function removeFishFromInventory(
  userId: string,
  fishId: string
): Promise<{ success: boolean; inventory: FishInstance[]; error?: string }> {
  const result = await q.run('DELETE FROM inventory WHERE id = ? AND user_id = ?', [fishId, userId]);

  if (result.changes === 0) {
    return {
      success: false,
      inventory: await getUserInventory(userId),
      error: 'Peixe não encontrado no seu inventário.',
    };
  }

  return { success: true, inventory: await getUserInventory(userId) };
}

export async function executeTradeTransaction(
  userAId: string,
  userBId: string,
  itemAIds: string[],
  itemBIds: string[],
  sessionId: string = 'direct_trade'
): Promise<{ success: boolean; error?: string; inventoryA?: FishInstance[]; inventoryB?: FishInstance[] }> {
  try {
    return await withTransaction(async (tx) => {
      const [invA, invB] = [await getUserInventory(userAId, tx), await getUserInventory(userBId, tx)];

      const userA = await tx.get<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, [userAId]);
      const userB = await tx.get<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, [userBId]);

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
      if (finalCountA > userA.max_backpack_capacity) {
        throw new Error(
          `${userA.name} excederá a capacidade da mochila (${finalCountA}/${userA.max_backpack_capacity}).`
        );
      }

      const finalCountB = invB.length - itemBIds.length + itemAIds.length;
      if (finalCountB > userB.max_backpack_capacity) {
        throw new Error(
          `${userB.name} excederá a capacidade da mochila (${finalCountB}/${userB.max_backpack_capacity}).`
        );
      }

      for (const id of itemAIds) {
        await tx.run('UPDATE inventory SET user_id = ? WHERE id = ?', [userBId, id]);
      }
      for (const id of itemBIds) {
        await tx.run('UPDATE inventory SET user_id = ? WHERE id = ?', [userAId, id]);
      }

      await tx.run(
        `INSERT INTO trade_history (id, session_id, user_a_id, user_b_id, items_a, items_b, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          newId('trade'),
          sessionId,
          userAId,
          userBId,
          JSON.stringify(itemAIds.map((id) => mapA.get(id))),
          JSON.stringify(itemBIds.map((id) => mapB.get(id))),
          new Date().toISOString(),
        ]
      );

      return {
        success: true as const,
        inventoryA: await getUserInventory(userAId, tx),
        inventoryB: await getUserInventory(userBId, tx),
      };
    });
  } catch (err: any) {
    return {
      success: false,
      error: err?.message || 'Falha ao processar a troca no banco de dados.',
    };
  }
}

// ===================== COOLDOWN DE PESCA (ANTI-FARM) =====================

/** Intervalo mínimo entre duas fisgadas. A animação do cliente já leva ~3.6s. */
export const CATCH_COOLDOWN_MS = 3000;

/**
 * Consome o cooldown de pesca de forma atômica.
 *
 * O timing da pescaria vivia só na animação do cliente, então um POST em loop
 * em /api/fish/catch farmava lendários à vontade e inflacionava o mercado de trocas.
 * O UPDATE condicional resolve a corrida sem transação: só um request passa.
 */
export async function tryConsumeCatchCooldown(
  userId: string,
  cooldownMs: number = CATCH_COOLDOWN_MS
): Promise<{ allowed: boolean; retryAfterMs: number }> {
  const now = Date.now();
  const result = await q.run('UPDATE users SET last_catch_at = ? WHERE id = ? AND last_catch_at <= ?', [
    now,
    userId,
    now - cooldownMs,
  ]);

  if (result.changes > 0) {
    return { allowed: true, retryAfterMs: 0 };
  }

  const row = await q.get<{ last_catch_at: number }>('SELECT last_catch_at FROM users WHERE id = ?', [userId]);
  const lastCatchAt = row?.last_catch_at ?? now;
  return { allowed: false, retryAfterMs: Math.max(0, lastCatchAt + cooldownMs - now) };
}

// ===================== PROGRESSO, ÁLBUM E STREAK =====================

export interface SpeciesRecord {
  speciesId: string;
  maxWeight: number;
  timesCaught: number;
  firstCaughtAt: string;
  lastCaughtAt: string;
}

export interface PlayerProgress {
  streakDays: number;
  catchesToday: number;
  uniqueSpeciesDiscovered: number;
  records: SpeciesRecord[];
}

/** Conta dias consecutivos a partir de hoje. Dias devem vir em ordem decrescente. */
function computeStreak(days: string[]): number {
  let streak = 0;
  let checkDate = new Date();
  checkDate.setHours(0, 0, 0, 0);

  for (const day of days) {
    const rowDate = new Date(`${day}T00:00:00`);
    const diffDays = Math.round((checkDate.getTime() - rowDate.getTime()) / 86400000);
    if (diffDays <= 1) {
      streak++;
      checkDate = rowDate;
    } else {
      break;
    }
  }

  return streak;
}

async function readStreak(userId: string): Promise<number> {
  const rows = await q.all<{ day: string }>(
    'SELECT day FROM daily_activity WHERE user_id = ? ORDER BY day DESC LIMIT 30',
    [userId]
  );
  return computeStreak(rows.map((r) => r.day));
}

async function readRecords(userId: string): Promise<SpeciesRecord[]> {
  return q.all<SpeciesRecord>(
    `SELECT species_id as speciesId, max_weight as maxWeight, times_caught as timesCaught,
            first_caught_at as firstCaughtAt, last_caught_at as lastCaughtAt
     FROM fish_records
     WHERE user_id = ?`,
    [userId]
  );
}

/**
 * Progresso somente-leitura: alimenta os indicadores do cabeçalho e o álbum.
 * Não incrementa nada — diferente de recordFishCatch.
 */
export async function getPlayerProgress(userId: string): Promise<PlayerProgress> {
  const today = new Date().toISOString().split('T')[0];

  const [todayRow, streakDays, records] = await Promise.all([
    q.get<{ catches_count: number }>('SELECT catches_count FROM daily_activity WHERE user_id = ? AND day = ?', [
      userId,
      today,
    ]),
    readStreak(userId),
    readRecords(userId),
  ]);

  return {
    streakDays,
    catchesToday: todayRow?.catches_count ?? 0,
    uniqueSpeciesDiscovered: records.length,
    records,
  };
}

export async function recordFishCatch(
  userId: string,
  speciesId: string,
  weight: number
): Promise<{
  isNewDiscovery: boolean;
  isNewRecord: boolean;
  uniqueSpeciesDiscovered: number;
  catchesToday: number;
  streakDays: number;
}> {
  const nowIso = new Date().toISOString();
  const todayStr = nowIso.split('T')[0];

  await q.run(
    `INSERT INTO daily_activity (user_id, day, catches_count)
     VALUES (?, ?, 1)
     ON CONFLICT(user_id, day) DO UPDATE SET catches_count = catches_count + 1`,
    [userId, todayStr]
  );

  const todayRow = await q.get<{ catches_count: number }>(
    'SELECT catches_count FROM daily_activity WHERE user_id = ? AND day = ?',
    [userId, todayStr]
  );
  const catchesToday = todayRow?.catches_count ?? 1;

  // O dia de hoje já foi inserido acima, então a streak é sempre >= 1 aqui.
  const streakDays = Math.max(1, await readStreak(userId));

  const recordRow = await q.get<{ max_weight: number }>(
    'SELECT max_weight FROM fish_records WHERE user_id = ? AND species_id = ?',
    [userId, speciesId]
  );

  let isNewDiscovery = false;
  let isNewRecord = false;

  if (!recordRow) {
    isNewDiscovery = true;
    isNewRecord = true;
    await q.run(
      `INSERT INTO fish_records (user_id, species_id, max_weight, first_caught_at, last_caught_at, times_caught)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [userId, speciesId, weight, nowIso, nowIso]
    );
  } else if (weight > recordRow.max_weight) {
    isNewRecord = true;
    await q.run(
      `UPDATE fish_records
       SET max_weight = ?, last_caught_at = ?, times_caught = times_caught + 1
       WHERE user_id = ? AND species_id = ?`,
      [weight, nowIso, userId, speciesId]
    );
  } else {
    await q.run(
      `UPDATE fish_records
       SET last_caught_at = ?, times_caught = times_caught + 1
       WHERE user_id = ? AND species_id = ?`,
      [nowIso, userId, speciesId]
    );
  }

  const uniqueCountRow = await q.get<{ count: number }>(
    'SELECT COUNT(*) as count FROM fish_records WHERE user_id = ?',
    [userId]
  );

  return {
    isNewDiscovery,
    isNewRecord,
    uniqueSpeciesDiscovered: uniqueCountRow?.count ?? 1,
    catchesToday,
    streakDays,
  };
}

// ===================== PRESENÇA E TROCAS SERVERLESS =====================

/**
 * Atualiza o heartbeat de presença do jogador no ambiente serverless
 */
export async function heartbeatPlayer(
  user: { id: string; name: string; email: string },
  status: 'IDLE' | 'FISHING' | 'TRADING' = 'IDLE'
): Promise<void> {
  await q.run(
    `INSERT INTO player_heartbeats (user_id, name, email, status, last_seen)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       name = excluded.name,
       email = excluded.email,
       status = excluded.status,
       last_seen = excluded.last_seen`,
    [user.id, user.name, user.email, status, Date.now()]
  );
}

/**
 * Retorna os jogadores ativos nos últimos 12 segundos
 */
export async function getActiveOnlinePlayers(): Promise<OnlinePlayer[]> {
  const rows = await q.all<{ id: string; name: string; email: string; status: OnlinePlayer['status'] }>(
    `SELECT user_id as id, name, email, status
     FROM player_heartbeats
     WHERE last_seen >= ?
     ORDER BY last_seen DESC`,
    [Date.now() - 12000]
  );

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
export async function saveServerlessTradeSession(session: TradeSession): Promise<void> {
  await q.run(
    `INSERT INTO serverless_trades (session_id, data, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       data = excluded.data,
       updated_at = excluded.updated_at`,
    [session.id, JSON.stringify(session), Date.now()]
  );
}

/**
 * Busca uma sessão de troca pelo ID
 */
export async function getServerlessTradeSession(sessionId: string): Promise<TradeSession | null> {
  const row = await q.get<{ data: string }>('SELECT data FROM serverless_trades WHERE session_id = ?', [sessionId]);
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
export async function findTradeSessionForUser(userId: string): Promise<TradeSession | null> {
  const rows = await q.all<{ data: string }>(
    `SELECT data FROM serverless_trades
     WHERE updated_at >= ?
     ORDER BY updated_at DESC`,
    [Date.now() - 120000]
  );

  for (const row of rows) {
    try {
      const session = JSON.parse(row.data) as TradeSession;
      if (session.status !== 'COMPLETED' && session.status !== 'CANCELLED' && session.status !== 'DECLINED') {
        if (session.sender.userId === userId || session.receiver.userId === userId) {
          return session;
        }
      }
    } catch {
      // Linha corrompida — ignora.
    }
  }
  return null;
}
