import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import { resolve } from 'path';
import { findOrCreateUser, getUserById, addFishToInventory, removeFishFromInventory, getUserInventory } from './db.js';
import { TradeManager } from './tradeManager.js';
import { generateCatch } from '../shared/fishingEngine.js';
import { RARITY_CONFIGS, FISH_SPECIES_CATALOG } from '../shared/fishData.js';
import { FishInstance } from '../shared/types.js';

const app = express();
const httpServer = createServer(app);

// Configuração do Socket.io
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

app.use(cors());
app.use(express.json());

// Trade Manager para gerenciar trocas e jogadores conectados
const tradeManager = new TradeManager(io);
io.on('connection', (socket) => {
  tradeManager.registerSocket(socket);
});

// ===================== ROTAS REST =====================

/**
 * 1. Login Simples / Identificação
 * POST /api/login { name: string, email: string }
 */
app.post('/api/login', (req, res) => {
  try {
    const { name, email } = req.body;
    if (!name || !email) {
      return res.status(400).json({ error: 'Nome e E-mail são obrigatórios.' });
    }

    const userWithInv = findOrCreateUser(name, email);
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
    });
  } catch (error: any) {
    console.error('Erro no login:', error);
    res.status(500).json({ error: error.message || 'Erro interno no servidor' });
  }
});

/**
 * 2. Buscar dados e inventário do usuário
 * GET /api/user/:id
 */
app.get('/api/user/:id', (req, res) => {
  const user = getUserById(req.params.id);
  if (!user) {
    return res.status(404).json({ error: 'Usuário não encontrado' });
  }
  res.json({ success: true, user, inventory: user.inventory });
});

/**
 * 3. Ação de Pesca (Sortear peixe)
 * POST /api/fish/catch { userId: string }
 */
app.post('/api/fish/catch', (req, res) => {
  try {
    const { userId } = req.body;
    const user = getUserById(userId);
    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    const { fish, species } = generateCatch();
    fish.userId = user.id;

    const rarityConfig = RARITY_CONFIGS[fish.rarity];
    const currentCount = user.inventory.length;
    const backpackFull = currentCount >= user.maxBackpackCapacity;

    res.json({
      success: true,
      fish,
      species,
      rarityConfig,
      backpackFull,
      currentInventoryCount: currentCount,
      maxCapacity: user.maxBackpackCapacity,
    });
  } catch (error: any) {
    console.error('Erro ao pescar:', error);
    res.status(500).json({ error: 'Falha ao sortear peixe' });
  }
});

/**
 * 4. Guardar peixe na mochila
 * POST /api/fish/keep { userId: string, fish: FishInstance }
 */
app.post('/api/fish/keep', (req, res) => {
  try {
    const { userId, fish } = req.body as { userId: string; fish: FishInstance };
    if (!userId || !fish || !fish.id) {
      return res.status(400).json({ error: 'Dados inválidos do peixe ou usuário.' });
    }

    const result = addFishToInventory(userId, fish);
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
 * 5. Soltar peixe da mochila
 * POST /api/fish/release { userId: string, fishId: string }
 */
app.post('/api/fish/release', (req, res) => {
  try {
    const { userId, fishId } = req.body;
    if (!userId || !fishId) {
      return res.status(400).json({ error: 'Identificadores obrigatórios.' });
    }

    const result = removeFishFromInventory(userId, fishId);
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
 * 6. Catálogo de peixes e raridades
 * GET /api/species
 */
app.get('/api/species', (_req, res) => {
  res.json({
    rarities: RARITY_CONFIGS,
    species: FISH_SPECIES_CATALOG,
  });
});

// ===================== FRONTEND / VITE SERVER =====================

const PORT = Number(process.env.PORT) || 3000;

async function bootstrap() {
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
      root: resolve(process.cwd(), 'src/client'),
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(resolve(process.cwd(), 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(resolve(process.cwd(), 'dist', 'index.html'));
    });
  }

  httpServer.listen(PORT, () => {
    console.log(`🎣 Servidor do Jogo de Pesca rodando com sucesso em http://localhost:${PORT}`);
    console.log(`📦 Ambiente: ${isProd ? 'Produção' : 'Desenvolvimento (Vite Middleware)'}`);
  });
}

bootstrap().catch((err) => {
  console.error('Falha ao iniciar servidor:', err);
  process.exit(1);
});
