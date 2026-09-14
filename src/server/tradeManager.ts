import { Server as SocketIOServer, Socket } from 'socket.io';
import { OnlinePlayer, TradeSession, TradeOffer, FishInstance } from '../shared/types.js';
import { executeTradeTransaction, getUserById, getUserInventory } from './db.js';
import { validateTradeCapacity } from '../shared/fishingEngine.js';

export class TradeManager {
  private io: SocketIOServer;
  // Mapeamento: socketId -> OnlinePlayer
  private onlineUsersBySocket: Map<string, OnlinePlayer> = new Map();
  // Mapeamento: userId -> socketId
  private socketByUserId: Map<string, string> = new Map();
  // Mapeamento: sessionId -> TradeSession
  private activeSessions: Map<string, TradeSession> = new Map();

  constructor(io: SocketIOServer) {
    this.io = io;
  }

  public registerSocket(socket: Socket) {
    // 1. Jogador se autentica/conecta no WebSocket
    socket.on('player:join', (userData: { id: string; name: string; email: string }) => {
      const player: OnlinePlayer = {
        id: userData.id,
        name: userData.name,
        email: userData.email,
        socketId: socket.id,
        status: 'IDLE',
      };

      this.onlineUsersBySocket.set(socket.id, player);
      this.socketByUserId.set(player.id, socket.id);

      this.broadcastOnlinePlayers();
    });

    // 2. Solicitar troca com outro jogador
    socket.on('trade:request', (payload: { targetUserId?: string; targetEmail?: string }) => {
      const sender = this.onlineUsersBySocket.get(socket.id);
      if (!sender) {
        return socket.emit('trade:error', { message: 'Você não está identificado no servidor.' });
      }

      let targetSocketId: string | undefined;
      let targetPlayer: OnlinePlayer | undefined;

      if (payload.targetUserId) {
        targetSocketId = this.socketByUserId.get(payload.targetUserId);
      } else if (payload.targetEmail) {
        const cleanEmail = payload.targetEmail.trim().toLowerCase();
        for (const [sId, p] of this.onlineUsersBySocket.entries()) {
          if (p.email.toLowerCase() === cleanEmail) {
            targetSocketId = sId;
            break;
          }
        }
      }

      if (!targetSocketId || !this.onlineUsersBySocket.has(targetSocketId)) {
        return socket.emit('trade:error', { message: 'Jogador não encontrado ou desconectado.' });
      }

      targetPlayer = this.onlineUsersBySocket.get(targetSocketId)!;

      if (targetPlayer.id === sender.id) {
        return socket.emit('trade:error', { message: 'Você não pode negociar consigo mesmo!' });
      }

      if (targetPlayer.status === 'TRADING') {
        return socket.emit('trade:error', { message: `${targetPlayer.name} já está em uma negociação no momento.` });
      }

      // Cria a sessão com status PENDING
      const sessionId = `session_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      const session: TradeSession = {
        id: sessionId,
        sender: {
          userId: sender.id,
          userName: sender.name,
          userEmail: sender.email,
          socketId: sender.socketId,
          offeredItemIds: [],
          isReady: false,
          isConfirmed: false,
        },
        receiver: {
          userId: targetPlayer.id,
          userName: targetPlayer.name,
          userEmail: targetPlayer.email,
          socketId: targetPlayer.socketId,
          offeredItemIds: [],
          isReady: false,
          isConfirmed: false,
        },
        status: 'PENDING',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      this.activeSessions.set(sessionId, session);

      // Envia notificação ao jogador alvo
      this.io.to(targetSocketId).emit('trade:invited', {
        sessionId,
        from: { id: sender.id, name: sender.name, email: sender.email },
      });

      socket.emit('trade:invite_sent', {
        sessionId,
        to: { id: targetPlayer.id, name: targetPlayer.name },
      });
    });

    // 3. Responder convite de troca (Aceitar / Recusar)
    socket.on('trade:respond', (payload: { sessionId: string; accept: boolean }) => {
      const session = this.activeSessions.get(payload.sessionId);
      if (!session || session.status !== 'PENDING') {
        return socket.emit('trade:error', { message: 'Sessão de troca expirada ou inexistente.' });
      }

      const senderSocket = this.io.sockets.sockets.get(session.sender.socketId);
      const receiverSocket = this.io.sockets.sockets.get(session.receiver.socketId);

      if (!payload.accept) {
        session.status = 'DECLINED';
        if (senderSocket) {
          senderSocket.emit('trade:declined', {
            sessionId: session.id,
            by: session.receiver.userName,
          });
        }
        this.activeSessions.delete(session.id);
        return;
      }

      // Se aceitou, ambos entram no status TRADING
      session.status = 'ACTIVE';
      session.updatedAt = Date.now();

      const p1 = this.onlineUsersBySocket.get(session.sender.socketId);
      const p2 = this.onlineUsersBySocket.get(session.receiver.socketId);
      if (p1) p1.status = 'TRADING';
      if (p2) p2.status = 'TRADING';
      this.broadcastOnlinePlayers();

      // Emitir início para ambos
      const startPayload = {
        sessionId: session.id,
        session,
      };

      if (senderSocket) senderSocket.emit('trade:started', startPayload);
      if (receiverSocket) receiverSocket.emit('trade:started', startPayload);
    });

    // 4. Atualizar oferta de peixes (selecionar 0 a 3 itens)
    socket.on('trade:offer_update', async (payload: { sessionId: string; itemIds: string[] }) => {
      const session = this.activeSessions.get(payload.sessionId);
      if (!session || session.status !== 'ACTIVE') return;

      const player = this.onlineUsersBySocket.get(socket.id);
      if (!player) return;

      const isSender = session.sender.userId === player.id;
      const targetOffer = isSender ? session.sender : session.receiver;
      const otherOffer = isSender ? session.receiver : session.sender;

      // Limitar a no máximo 3 itens
      targetOffer.offeredItemIds = (payload.itemIds || []).slice(0, 3);
      // Qualquer alteração na oferta reseta a confirmação de ambos por segurança
      targetOffer.isConfirmed = false;
      otherOffer.isConfirmed = false;
      session.updatedAt = Date.now();

      // Buscar instâncias completas dos itens para enviar aos clientes
      const itemsOfferA = await this.resolveFishInstances(session.sender.userId, session.sender.offeredItemIds);
      const itemsOfferB = await this.resolveFishInstances(session.receiver.userId, session.receiver.offeredItemIds);

      this.emitToSession(session, 'trade:sync', {
        session,
        itemsOfferA,
        itemsOfferB,
      });
    });

    // 5. Confirmar troca
    socket.on('trade:confirm', async (payload: { sessionId: string }) => {
      const session = this.activeSessions.get(payload.sessionId);
      if (!session || session.status !== 'ACTIVE') return;

      const player = this.onlineUsersBySocket.get(socket.id);
      if (!player) return;

      if (session.sender.userId === player.id) {
        session.sender.isConfirmed = true;
      } else if (session.receiver.userId === player.id) {
        session.receiver.isConfirmed = true;
      }

      session.updatedAt = Date.now();

      const itemsOfferA = await this.resolveFishInstances(session.sender.userId, session.sender.offeredItemIds);
      const itemsOfferB = await this.resolveFishInstances(session.receiver.userId, session.receiver.offeredItemIds);

      // Sincroniza estado de confirmação
      this.emitToSession(session, 'trade:sync', {
        session,
        itemsOfferA,
        itemsOfferB,
      });

      // Se ambos confirmaram, executar a transação atômica!
      if (session.sender.isConfirmed && session.receiver.isConfirmed) {
        await this.finalizeTrade(session);
      }
    });

    // 6. Cancelar troca
    socket.on('trade:cancel', (payload: { sessionId: string }) => {
      this.cancelSession(payload.sessionId, 'Negociação cancelada pelo outro jogador.');
    });

    // 7. Desconexão
    socket.on('disconnect', () => {
      const player = this.onlineUsersBySocket.get(socket.id);
      if (player) {
        this.socketByUserId.delete(player.id);
        this.onlineUsersBySocket.delete(socket.id);

        // Cancelar qualquer sessão ativa do jogador
        for (const [sId, session] of this.activeSessions.entries()) {
          if (session.sender.userId === player.id || session.receiver.userId === player.id) {
            this.cancelSession(sId, `${player.name} desconectou-se do jogo.`);
          }
        }
      }
      this.broadcastOnlinePlayers();
    });
  }

  private async resolveFishInstances(userId: string, itemIds: string[]): Promise<FishInstance[]> {
    const inventory = await getUserInventory(userId);
    const itemMap = new Map(inventory.map((i) => [i.id, i]));
    return itemIds.map((id) => itemMap.get(id)).filter(Boolean) as FishInstance[];
  }

  private async finalizeTrade(session: TradeSession): Promise<void> {
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
      this.emitToSession(session, 'trade:error', {
        message: validation.error || 'A troca não pôde ser validada.',
      });
      // Desmarca confirmação para que ajustem
      session.sender.isConfirmed = false;
      session.receiver.isConfirmed = false;
      return;
    }

    // Executar transação atômica no SQLite
    const result = await executeTradeTransaction(
      session.sender.userId,
      session.receiver.userId,
      session.sender.offeredItemIds,
      session.receiver.offeredItemIds,
      session.id
    );

    if (!result.success) {
      this.emitToSession(session, 'trade:error', {
        message: result.error || 'Erro interno ao salvar a transação.',
      });
      session.sender.isConfirmed = false;
      session.receiver.isConfirmed = false;
      return;
    }

    session.status = 'COMPLETED';

    // Notificar ambos os jogadores com seus novos inventários
    const socketA = this.io.sockets.sockets.get(session.sender.socketId);
    const socketB = this.io.sockets.sockets.get(session.receiver.socketId);

    if (socketA) {
      socketA.emit('trade:completed', {
        message: 'Troca concluída com sucesso!',
        updatedInventory: result.inventoryA,
      });
    }

    if (socketB) {
      socketB.emit('trade:completed', {
        message: 'Troca concluída com sucesso!',
        updatedInventory: result.inventoryB,
      });
    }

    // Restaurar status dos jogadores
    const p1 = this.onlineUsersBySocket.get(session.sender.socketId);
    const p2 = this.onlineUsersBySocket.get(session.receiver.socketId);
    if (p1) p1.status = 'IDLE';
    if (p2) p2.status = 'IDLE';

    this.activeSessions.delete(session.id);
    this.broadcastOnlinePlayers();
  }

  private cancelSession(sessionId: string, reason: string) {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    session.status = 'CANCELLED';
    this.emitToSession(session, 'trade:cancelled', { reason });

    const p1 = this.onlineUsersBySocket.get(session.sender.socketId);
    const p2 = this.onlineUsersBySocket.get(session.receiver.socketId);
    if (p1) p1.status = 'IDLE';
    if (p2) p2.status = 'IDLE';

    this.activeSessions.delete(sessionId);
    this.broadcastOnlinePlayers();
  }

  private emitToSession(session: TradeSession, event: string, data: any) {
    this.io.to(session.sender.socketId).emit(event, data);
    this.io.to(session.receiver.socketId).emit(event, data);
  }

  private broadcastOnlinePlayers() {
    const players = Array.from(this.onlineUsersBySocket.values()).map((p) => ({
      id: p.id,
      name: p.name,
      email: p.email,
      status: p.status,
    }));

    this.io.emit('players:online_list', players);
  }
}
