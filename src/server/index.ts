import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { resolve } from 'path';
import { app } from './app.js';
import { TradeManager } from './tradeManager.js';

const httpServer = createServer(app);

// Configuração do Socket.io para desenvolvimento local e servidores com suporte a WebSocket
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

const tradeManager = new TradeManager(io);
io.on('connection', (socket) => {
  tradeManager.registerSocket(socket);
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
      // Sem isto o publicDir é resolvido a partir do root (src/client/public, que não
      // existe) e /assets/* caía no fallback do index.html — as imagens só apareciam
      // no build de produção.
      publicDir: resolve(process.cwd(), 'public'),
    });
    app.use(vite.middlewares);
  } else {
    const express = (await import('express')).default;
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
