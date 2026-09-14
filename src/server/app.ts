import express from 'express';
import cors from 'cors';
import {
  findOrCreateUser,
  ensureUser,
  getUserById,
  getUserByEmail,
  addFishToInventory,
  removeFishFromInventory,
  getUserInventory,
  recordFishCatch,
  getPlayerProgress,
  tryConsumeCatchCooldown,
  CATCH_COOLDOWN_MS,
  heartbeatPlayer,
  getActiveOnlinePlayers,
  saveServerlessTradeSession,
  getServerlessTradeSession,
  findTradeSessionForUser,
  executeTradeTransaction,
} from './db.js';
import { generateCatch, getEnvironmentContext, generateWhatsAppShareText, validateTradeCapacity } from '../shared/fishingEngine.js';
import { RARITY_CONFIGS, FISH_SPECIES_CATALOG } from '../shared/fishData.js';
import { FishInstance, TradeSession } from '../shared/types.js';

export const app = express();

app.use(cors());
app.use(express.json());

// ===================== ROTAS DE AUTENTICAÇÃO E PERFIL =====================

/**
 * 1. Login / Identificação Leve
 */
app.post('/api/login', async (req, res) => {
  try {
    const { name, email } = req.body;
    if (!name || !email) {
      return res.status(400).json({ error: 'Nome e E-mail são obrigatórios.' });
    }

    const userWithInv = await findOrCreateUser(name, email);
    const progress = await getPlayerProgress(userWithInv.id);

    res.json({
      success: true,
      user: {
        id: userWithInv.id,
        name: userWithInv.name,
        email: userWithInv.email,
        createdAt: userWithInv.createdAt,
        maxBackpackCapacity: userWithInv.maxBackpackCapacity,
      },
      inventory: userWithInv.inventory,
      progress: { ...progress, totalSpecies: FISH_SPECIES_CATALOG.length },
    });
  } catch (error: any) {
    console.error('Erro no login:', error);
    res.status(500).json({ error: error.message || 'Erro interno no servidor' });
  }
});

/**
 * 2. Buscar dados do usuário
 */
app.get('/api/user/:id', async (req, res) => {
  try {
    let user = await getUserById(req.params.id);
    if (!user && req.query.name && req.query.email) {
      user = await ensureUser(req.params.id, String(req.query.name), String(req.query.email));
    }
    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    const progress = await getPlayerProgress(user.id);
    res.json({
      success: true,
      user,
      inventory: user.inventory,
      progress: { ...progress, totalSpecies: FISH_SPECIES_CATALOG.length },
    });
  } catch (error: any) {
    console.error('Erro ao buscar usuário:', error);
    res.status(500).json({ error: 'Erro ao buscar dados do jogador' });
  }
});

/**
 * 2b. Progresso do jogador: streak, capturas do dia e álbum de espécies
 */
app.get('/api/user/:id/progress', async (req, res) => {
  try {
    const user = await getUserById(req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    const progress = await getPlayerProgress(user.id);
    res.json({
      success: true,
      ...progress,
      totalSpecies: FISH_SPECIES_CATALOG.length,
      backpackCount: user.inventory.length,
      maxCapacity: user.maxBackpackCapacity,
    });
  } catch (error: any) {
    console.error('Erro ao buscar progresso:', error);
    res.status(500).json({ error: 'Erro ao buscar progresso' });
  }
});

// ===================== ROTAS DE PESCARIA =====================

/**
 * 3. Pescar (sorteio determinístico, cálculo de peso, álbum e shareText)
 */
app.post('/api/fish/catch', async (req, res) => {
  try {
    const { userId, userName, userEmail } = req.body;
    let user = await getUserById(userId);
    if (!user && userName && userEmail) {
      user = await ensureUser(userId, userName, userEmail);
    }
    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    // Cooldown no servidor: impede farm por POST em loop, que inflacionaria o mercado de trocas.
    const cooldown = await tryConsumeCatchCooldown(user.id);
    if (!cooldown.allowed) {
      const seconds = Math.ceil(cooldown.retryAfterMs / 1000);
      return res.status(429).json({
        error: `Calma, pescador! Aguarde ${seconds}s antes do próximo lançamento.`,
        retryAfterMs: cooldown.retryAfterMs,
        cooldownMs: CATCH_COOLDOWN_MS,
      });
    }

    const { fish, species } = generateCatch();
    fish.userId = user.id;

    const rarityConfig = RARITY_CONFIGS[fish.rarity];
    const currentCount = user.inventory.length;
    const backpackFull = currentCount >= user.maxBackpackCapacity;

    const stats = await recordFishCatch(user.id, species.id, fish.weight);
    const environment = getEnvironmentContext();

    const shareText = generateWhatsAppShareText({
      fish,
      rarityConfig,
      trophySizeLabel: fish.trophySizeLabel || 'Médio',
      isNewDiscovery: stats.isNewDiscovery,
      isNewRecord: stats.isNewRecord,
      environment,
      catchesToday: stats.catchesToday,
      currentInventoryCount: currentCount,
      maxCapacity: user.maxBackpackCapacity,
      uniqueSpeciesDiscovered: stats.uniqueSpeciesDiscovered,
      totalSpecies: FISH_SPECIES_CATALOG.length,
      streakDays: stats.streakDays,
    });

    res.json({
      success: true,
      fish,
      species,
      rarityConfig,
      backpackFull,
      currentInventoryCount: currentCount,
      maxCapacity: user.maxBackpackCapacity,
      isNewDiscovery: stats.isNewDiscovery,
      isNewRecord: stats.isNewRecord,
      trophySizeLabel: fish.trophySizeLabel || 'Médio',
      uniqueSpeciesDiscovered: stats.uniqueSpeciesDiscovered,
      totalSpecies: FISH_SPECIES_CATALOG.length,
      catchesToday: stats.catchesToday,
      streakDays: stats.streakDays,
      environment,
      shareText,
    });
  } catch (error: any) {
    console.error('Erro ao pescar:', error);
    res.status(500).json({ error: 'Falha ao sortear peixe' });
  }
});

/**
 * 4. Guardar na mochila
 */
app.post('/api/fish/keep', async (req, res) => {
  try {
    const { userId, fish, userName, userEmail } = req.body as {
      userId: string;
      fish: FishInstance;
      userName?: string;
      userEmail?: string;
    };
    if (!userId || !fish || !fish.id) {
      return res.status(400).json({ error: 'Dados inválidos do peixe ou usuário.' });
    }

    let user = await getUserById(userId);
    if (!user && userName && userEmail) {
      user = await ensureUser(userId, userName, userEmail);
    }
    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    const result = await addFishToInventory(userId, fish);
    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }

    res.json({
      success: true,
      action: 'KEPT',
      fish,
      inventory: result.inventory,
      message: `${fish.name} (${fish.formattedWeight}) guardado na mochila!`,
    });
  } catch (error: any) {
    console.error('Erro ao guardar peixe:', error);
    res.status(500).json({ error: error.message || 'Erro ao guardar na mochila' });
  }
});

/**
 * 5. Soltar da mochila
 */
app.post('/api/fish/release', async (req, res) => {
  try {
    const { userId, fishId, userName, userEmail } = req.body;
    if (!userId || !fishId) {
      return res.status(400).json({ error: 'Identificadores obrigatórios.' });
    }

    let user = await getUserById(userId);
    if (!user && userName && userEmail) {
      user = await ensureUser(userId, userName, userEmail);
    }
    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    const result = await removeFishFromInventory(userId, fishId);
    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }

    res.json({
      success: true,
      action: 'RELEASED',
      inventory: result.inventory,
      message: 'Peixe solto de volta à água com sucesso!',
    });
  } catch (error: any) {
    console.error('Erro ao soltar peixe:', error);
    res.status(500).json({ error: 'Erro ao soltar peixe' });
  }
});

/**
 * 6. Catálogo de espécies
 */
app.get('/api/species', (_req, res) => {
  res.json({
    rarities: RARITY_CONFIGS,
    species: FISH_SPECIES_CATALOG,
  });
});

// ===================== ROTAS SERVERLESS PARA VERCEL (TROCAS E PRESENÇA) =====================

/**
 * 7. Heartbeat de Jogador Ativo (Vercel Polling)
 */
app.post('/api/players/heartbeat', async (req, res) => {
  try {
    const { user, status } = req.body;
    if (user && user.id) {
      await heartbeatPlayer(user, status || 'IDLE');
    }
    const online = await getActiveOnlinePlayers();
    res.json({ success: true, online });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 8. Lista de Jogadores Ativos
 */
app.get('/api/players/online', async (_req, res) => {
  try {
    const online = await getActiveOnlinePlayers();
    res.json({ success: true, online });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 9. Iniciar Convite de Troca via REST
 */
app.post('/api/trade/request', async (req, res) => {
  try {
    const { senderId, targetUserId, targetEmail } = req.body;
    const sender = await getUserById(senderId);
    if (!sender) return res.status(404).json({ error: 'Remetente não encontrado.' });

    let target = targetUserId ? await getUserById(targetUserId) : null;
    if (!target && targetEmail) {
      target = await getUserByEmail(targetEmail);
    }

    if (!target) {
      return res.status(404).json({ error: 'Pescador parceiro não encontrado.' });
    }

    if (target.id === sender.id) {
      return res.status(400).json({ error: 'Você não pode negociar consigo mesmo!' });
    }

    const sessionId = `trade_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const session: TradeSession = {
      id: sessionId,
      sender: {
        userId: sender.id,
        userName: sender.name,
        userEmail: sender.email,
        socketId: `serverless_${sender.id}`,
        offeredItemIds: [],
        isReady: false,
        isConfirmed: false,
      },
      receiver: {
        userId: target.id,
        userName: target.name,
        userEmail: target.email,
        socketId: `serverless_${target.id}`,
        offeredItemIds: [],
        isReady: false,
        isConfirmed: false,
      },
      status: 'PENDING',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await saveServerlessTradeSession(session);
    res.json({ success: true, session });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 10. Polling de Sessão de Troca e Notificações
 */
app.get('/api/trade/poll', async (req, res) => {
  try {
    const userId = req.query.userId as string;
    if (!userId) return res.status(400).json({ error: 'userId obrigatório.' });

    const session = await findTradeSessionForUser(userId);
    if (!session) {
      return res.json({ active: false, session: null });
    }

    const itemsOfferA = await resolveFishInstances(session.sender.userId, session.sender.offeredItemIds);
    const itemsOfferB = await resolveFishInstances(session.receiver.userId, session.receiver.offeredItemIds);

    res.json({
      active: true,
      session,
      itemsOfferA,
      itemsOfferB,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 11. Responder convite de troca (Aceitar ou Recusar)
 */
app.post('/api/trade/respond', async (req, res) => {
  try {
    const { sessionId, accept } = req.body;
    const session = await getServerlessTradeSession(sessionId);
    if (!session) return res.status(404).json({ error: 'Sessão não encontrada.' });

    session.status = accept ? 'ACTIVE' : 'DECLINED';
    session.updatedAt = Date.now();
    await saveServerlessTradeSession(session);

    res.json({ success: true, session });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 12. Atualizar oferta de peixes
 */
app.post('/api/trade/offer', async (req, res) => {
  try {
    const { sessionId, userId, itemIds } = req.body;
    const session = await getServerlessTradeSession(sessionId);
    if (!session || session.status !== 'ACTIVE') {
      return res.status(400).json({ error: 'Sessão de troca não está ativa.' });
    }

    const isSender = session.sender.userId === userId;
    const myOffer = isSender ? session.sender : session.receiver;
    const partnerOffer = isSender ? session.receiver : session.sender;

    myOffer.offeredItemIds = (itemIds || []).slice(0, 3);
    myOffer.isConfirmed = false;
    partnerOffer.isConfirmed = false;
    session.updatedAt = Date.now();

    await saveServerlessTradeSession(session);

    const itemsOfferA = await resolveFishInstances(session.sender.userId, session.sender.offeredItemIds);
    const itemsOfferB = await resolveFishInstances(session.receiver.userId, session.receiver.offeredItemIds);

    res.json({ success: true, session, itemsOfferA, itemsOfferB });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 13. Confirmar Troca
 */
app.post('/api/trade/confirm', async (req, res) => {
  try {
    const { sessionId, userId } = req.body;
    const session = await getServerlessTradeSession(sessionId);
    if (!session || session.status !== 'ACTIVE') {
      return res.status(400).json({ error: 'Sessão de troca inválida.' });
    }

    if (session.sender.userId === userId) {
      session.sender.isConfirmed = true;
    } else if (session.receiver.userId === userId) {
      session.receiver.isConfirmed = true;
    }
    session.updatedAt = Date.now();

    // Se ambos confirmaram, executar a transação atômica!
    if (session.sender.isConfirmed && session.receiver.isConfirmed) {
      const invA = await getUserInventory(session.sender.userId);
      const invB = await getUserInventory(session.receiver.userId);

      const validation = validateTradeCapacity(
        invA,
        invB,
        session.sender.offeredItemIds,
        session.receiver.offeredItemIds,
        20
      );

      if (!validation.valid) {
        session.sender.isConfirmed = false;
        session.receiver.isConfirmed = false;
        await saveServerlessTradeSession(session);
        return res.status(400).json({ error: validation.error });
      }

      const result = await executeTradeTransaction(
        session.sender.userId,
        session.receiver.userId,
        session.sender.offeredItemIds,
        session.receiver.offeredItemIds,
        session.id
      );

      if (!result.success) {
        session.sender.isConfirmed = false;
        session.receiver.isConfirmed = false;
        await saveServerlessTradeSession(session);
        return res.status(500).json({ error: result.error });
      }

      session.status = 'COMPLETED';
      await saveServerlessTradeSession(session);

      return res.json({
        success: true,
        completed: true,
        session,
        updatedInventory: userId === session.sender.userId ? result.inventoryA : result.inventoryB,
      });
    }

    await saveServerlessTradeSession(session);
    res.json({ success: true, completed: false, session });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 14. Cancelar Troca
 */
app.post('/api/trade/cancel', async (req, res) => {
  try {
    const { sessionId } = req.body;
    const session = await getServerlessTradeSession(sessionId);
    if (session) {
      session.status = 'CANCELLED';
      session.updatedAt = Date.now();
      await saveServerlessTradeSession(session);
    }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

async function resolveFishInstances(userId: string, itemIds: string[]): Promise<FishInstance[]> {
  const inventory = await getUserInventory(userId);
  const itemMap = new Map(inventory.map((i) => [i.id, i]));
  return itemIds.map((id) => itemMap.get(id)).filter(Boolean) as FishInstance[];
}

export default app;
