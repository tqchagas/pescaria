import { io, Socket } from 'socket.io-client';
import { FishingGameCanvas } from './gameCanvas.js';
import { FishingStateMachine } from './stateMachine.js';
import { sound } from './audio.js';
import { renderFishSVG } from './fishRenderer.js';
import {
  CatchFishResult,
  FishInstance,
  FishSpecies,
  OnlinePlayer,
  RarityConfig,
  TradeSession,
  User,
} from '../shared/types.js';
import { RARITY_CONFIGS, FISH_SPECIES_CATALOG, SPECIES_BY_RARITY } from '../shared/fishData.js';
import { generateWhatsAppShareText, getEnvironmentContext, getTrophySizeLabel } from '../shared/fishingEngine.js';

class FishingApp {
  private socket: Socket;
  private canvas: FishingGameCanvas;
  private fsm: FishingStateMachine;

  // Estado do Jogador
  private currentUser: User | null = null;
  private inventory: FishInstance[] = [];
  private pendingCatch: CatchFishResult | null = null;

  // Estado de Troca
  private activeTradeSession: TradeSession | null = null;
  private selectedTradeItemIds: string[] = [];
  private pendingInviteSessionId: string | null = null;
  private isSocketConnected: boolean = false;

  constructor() {
    const canvasEl = document.getElementById('gameCanvas') as HTMLCanvasElement;
    this.canvas = new FishingGameCanvas(canvasEl);
    this.fsm = new FishingStateMachine('IDLE');

    // Inicializar conexão WebSocket com tolerância para Vercel
    this.socket = io(window.location.origin, {
      reconnectionAttempts: 3,
      timeout: 3000,
    });
    this.setupSocketListeners();
    this.startServerlessPolling();

    // Inicializar listeners de UI
    this.setupUIListeners();
    this.setupFSMListeners();

    // Carregar catálogo estático na Peixepédia
    this.renderCatalog();

    // Restaurar sessão de usuário salva localmente
    this.restoreUserSession();
  }

  // ===================== RESTAURAÇÃO DE SESSÃO =====================

  private restoreUserSession() {
    const saved = localStorage.getItem('pescaria_user');
    if (saved) {
      try {
        const user = JSON.parse(saved) as User;
        this.fetchUserData(user.id);
      } catch {
        this.showLoginModal();
      }
    } else {
      this.showLoginModal();
    }
  }

  private async fetchUserData(userId: string) {
    try {
      const res = await fetch(`/api/user/${userId}`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      this.setUser(data.user, data.inventory);
    } catch {
      this.showLoginModal();
    }
  }

  private setUser(user: User, inventory: FishInstance[]) {
    this.currentUser = user;
    this.inventory = inventory;
    localStorage.setItem('pescaria_user', JSON.stringify(user));

    // Atualizar UI do cabeçalho
    const pill = document.getElementById('playerInfoPill');
    const nameEl = document.getElementById('headerPlayerName');
    const backpackEl = document.getElementById('headerBackpackCount');
    const logoutBtn = document.getElementById('btnLogout');

    if (pill && nameEl && backpackEl && logoutBtn) {
      pill.style.display = 'flex';
      logoutBtn.style.display = 'inline-flex';
      nameEl.textContent = user.name;
      backpackEl.textContent = `🎒 ${inventory.length}/${user.maxBackpackCapacity}`;
    }

    // Notificar servidor via WebSocket
    this.socket.emit('player:join', {
      id: user.id,
      name: user.name,
      email: user.email,
    });
  }

  // ===================== MÁQUINA DE ESTADOS DE PESCA =====================

  private setupFSMListeners() {
    const btnFishAction = document.getElementById('btnFishAction') as HTMLButtonElement;
    const btnFishLabel = document.getElementById('btnFishLabel') as HTMLSpanElement;

    this.fsm.subscribe((from, to) => {
      if (to === 'IDLE') {
        this.canvas.setState('IDLE');
        btnFishAction.disabled = false;
        btnFishAction.classList.remove('fishing-pulse');
        btnFishLabel.textContent = 'Pescar';
      } else if (to === 'CASTING') {
        this.canvas.setState('CASTING');
        btnFishAction.disabled = true;
        btnFishAction.classList.add('fishing-pulse');
        btnFishLabel.textContent = 'Lançando...';
      } else if (to === 'REELING') {
        this.canvas.setState('REELING');
        btnFishLabel.textContent = 'Fisgando...';
      } else if (to === 'CAUGHT') {
        const color = this.pendingCatch?.species.baseColor || '#0ea5e9';
        this.canvas.setState('CAUGHT', color);
        btnFishLabel.textContent = 'Fisgou!';
      } else if (to === 'INVENTORY_ACTION') {
        btnFishAction.disabled = true;
        btnFishLabel.textContent = 'Recompensa';
        this.showRewardModal();
      }
    });
  }

  private async handleFishClick() {
    if (!this.currentUser) {
      this.showLoginModal();
      return;
    }

    if (!this.fsm.can('START_CAST')) {
      return;
    }

    // 1. Iniciar Lançamento (CASTING)
    this.fsm.transition('START_CAST');
    sound.playCast();

    // 2. Chamar endpoint da API para gerar resultado determinístico no backend
    let catchResultPromise = fetch('/api/fish/catch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: this.currentUser.id }),
    }).then((r) => r.json());

    // 3. Aguardar tempo da animação de voo da boia (1.1s)
    setTimeout(async () => {
      this.fsm.transition('BOBBER_LANDED');
      sound.playSplash();

      // Som repetido do molinete
      const reelInterval = setInterval(() => {
        if (this.fsm.is('REELING')) {
          sound.playReel();
        } else {
          clearInterval(reelInterval);
        }
      }, 220);

      // 4. Momento da mordida / fisgada (após 1.6s na água)
      setTimeout(async () => {
        clearInterval(reelInterval);

        try {
          const result: CatchFishResult = await catchResultPromise;
          this.pendingCatch = result;

          sound.playBite();
          this.fsm.transition('FISH_HOOKED');
          sound.playCatch(result.fish.rarity);

          // 5. Após salto do peixe (0.9s), abrir modal de decisão
          setTimeout(() => {
            this.fsm.transition('SHOW_REWARD_MODAL');
          }, 900);
        } catch (err) {
          console.error('Falha ao obter captura:', err);
          this.fsm.transition('RESET');
          this.showToast('Erro ao pescar. Tente novamente!', 'danger');
        }
      }, 1600);
    }, 1100);
  }

  // ===================== MODAIS DE RECOMPENSA E MOCHILA =====================

  private showRewardModal() {
    if (!this.pendingCatch) return;

    const modal = document.getElementById('rewardModal')!;
    const svgBox = document.getElementById('rewardFishSvg')!;
    const badge = document.getElementById('rewardRarityBadge')!;
    const name = document.getElementById('rewardFishName')!;
    const weight = document.getElementById('rewardFishWeight')!;
    const lore = document.getElementById('rewardFishLore')!;
    const space = document.getElementById('rewardBackpackSpace')!;
    const btnKeep = document.getElementById('btnKeepFish') as HTMLButtonElement;

    const { fish, species, rarityConfig, backpackFull, currentInventoryCount, maxCapacity } = this.pendingCatch;

    svgBox.innerHTML = renderFishSVG(species, 220, 130);

    // Badges de Nova Descoberta e Recorde Pessoal
    const recordBadges = document.getElementById('rewardRecordBadges');
    if (recordBadges) {
      let badgesHtml = '';
      if (this.pendingCatch.isNewDiscovery) {
        badgesHtml += '<span class="badge-discovery">🆕 NOVA DESCOBERTA NO ÁLBUM!</span>';
      }
      if (this.pendingCatch.isNewRecord) {
        badgesHtml += '<span class="badge-record">🏆 Novo recorde pessoal desta espécie!</span>';
      }
      if (badgesHtml) {
        recordBadges.innerHTML = badgesHtml;
        recordBadges.style.display = 'flex';
      } else {
        recordBadges.style.display = 'none';
      }
    }

    badge.textContent = `Nível ${rarityConfig.tier} - ${rarityConfig.label} (${rarityConfig.stars})`;
    badge.style.background = rarityConfig.badgeBg;
    badge.style.color = rarityConfig.glowColor;
    badge.style.border = `1px solid ${rarityConfig.color}`;

    name.textContent = fish.name;
    weight.textContent = `⚖️ ${fish.formattedWeight}`;

    const sizeEl = document.getElementById('rewardTrophySize');
    if (sizeEl) {
      sizeEl.textContent = `🫧 Tamanho: ${this.pendingCatch.trophySizeLabel || 'Médio'}`;
    }

    const envTag = document.getElementById('rewardEnvTag');
    if (envTag && this.pendingCatch.environment) {
      const env = this.pendingCatch.environment;
      envTag.textContent = `📍 ${env.location} | ${env.weather} (${env.period})`;
    }

    lore.textContent = species.description;
    space.textContent = `Mochila: ${currentInventoryCount}/${maxCapacity} peixes`;

    if (backpackFull) {
      btnKeep.disabled = true;
      btnKeep.textContent = '⚠️ Mochila Cheia (20/20)';
    } else {
      btnKeep.disabled = false;
      btnKeep.textContent = '🎒 Guardar na Mochila';
    }

    modal.style.display = 'flex';
  }

  private async keepCaughtFish() {
    if (!this.currentUser || !this.pendingCatch) return;

    try {
      const res = await fetch('/api/fish/keep', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: this.currentUser.id,
          fish: this.pendingCatch.fish,
        }),
      });

      const data = await res.json();
      if (!data.success) {
        this.showToast(data.error || 'Erro ao guardar peixe', 'danger');
        return;
      }

      this.inventory = data.inventory;
      this.updateHeaderBackpack();
      this.showToast(data.message, 'success');
    } catch (err) {
      this.showToast('Erro ao salvar na mochila', 'danger');
    } finally {
      this.closeModal('rewardModal');
      this.pendingCatch = null;
      this.fsm.transition('FISH_RESOLVED');
    }
  }

  private releaseCaughtFish() {
    this.closeModal('rewardModal');
    if (this.pendingCatch) {
      this.showToast(`${this.pendingCatch.fish.name} foi solto de volta à água! 🌊`, 'info');
      this.pendingCatch = null;
    }
    this.fsm.transition('FISH_RESOLVED');
  }

  private openBackpackModal() {
    if (!this.currentUser) {
      this.showLoginModal();
      return;
    }

    const modal = document.getElementById('backpackModal')!;
    const titleCount = document.getElementById('backpackCapacityTitle')!;
    const container = document.getElementById('inventoryContainer')!;

    titleCount.textContent = `${this.inventory.length}/${this.currentUser.maxBackpackCapacity}`;

    if (this.inventory.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">🎣</div>
          <h3>Sua mochila está vazia!</h3>
          <p>Lance sua linha no rio para capturar seus primeiros peixes.</p>
        </div>
      `;
    } else {
      let cardsHtml = '<div class="inventory-grid">';
      for (const item of this.inventory) {
        const species = FISH_SPECIES_CATALOG.find((s) => s.id === item.speciesId) || FISH_SPECIES_CATALOG[0];
        const rarityCfg = RARITY_CONFIGS[item.rarity];
        const dateStr = new Date(item.caughtAt).toLocaleDateString('pt-BR', {
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        });

        cardsHtml += `
          <div class="fish-card" data-fish-id="${item.id}">
            <div class="fish-card-preview">
              ${renderFishSVG(species, 120, 70)}
            </div>
            <div class="brand-badge" style="background: ${rarityCfg.badgeBg}; color: ${rarityCfg.glowColor}; border-color: ${rarityCfg.color}; margin-top: 4px;">
              Nível ${item.rarity} - ${rarityCfg.label}
            </div>
            <div class="fish-card-title">${item.name}</div>
            <div class="fish-card-weight">⚖️ ${item.formattedWeight}</div>
            <div class="fish-card-date">Fisgado em: ${dateStr}</div>
            <div class="fish-card-actions">
              <button class="btn btn-danger btn-release-fish" data-id="${item.id}" title="Soltar peixe para liberar espaço">
                Soltar 🌊
              </button>
              <button class="btn btn-primary btn-trade-fish" data-id="${item.id}" title="Propor este peixe em troca">
                Trocar 🤝
              </button>
              <button class="btn btn-whatsapp btn-share-fish" data-id="${item.id}" title="Compartilhar no WhatsApp">
                🟢 Whats
              </button>
            </div>
          </div>
        `;
      }
      cardsHtml += '</div>';
      container.innerHTML = cardsHtml;

      // Listeners nos botões dentro dos cards
      container.querySelectorAll('.btn-release-fish').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          const id = (e.currentTarget as HTMLElement).getAttribute('data-id')!;
          this.releaseFishFromBackpack(id);
        });
      });

      container.querySelectorAll('.btn-trade-fish').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          const id = (e.currentTarget as HTMLElement).getAttribute('data-id')!;
          this.closeModal('backpackModal');
          this.openTradingLobby(id);
        });
      });

      container.querySelectorAll('.btn-share-fish').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          const id = (e.currentTarget as HTMLElement).getAttribute('data-id')!;
          const fish = this.inventory.find((f) => f.id === id);
          if (!fish) return;
          const cfg = RARITY_CONFIGS[fish.rarity];
          const env = getEnvironmentContext();
          const text = generateWhatsAppShareText({
            fish,
            rarityConfig: cfg,
            trophySizeLabel: fish.trophySizeLabel || getTrophySizeLabel(fish.trophyScore || 50),
            environment: env,
            catchesToday: this.inventory.length,
            currentInventoryCount: this.inventory.length,
            maxCapacity: this.currentUser?.maxBackpackCapacity || 20,
            uniqueSpeciesDiscovered: new Set(this.inventory.map((i) => i.speciesId)).size,
            totalSpecies: FISH_SPECIES_CATALOG.length,
            streakDays: 1,
            gameUrl: window.location.origin,
          });
          this.shareOnWhatsApp(text);
        });
      });
    }

    modal.style.display = 'flex';
  }

  private async releaseFishFromBackpack(fishId: string) {
    if (!this.currentUser) return;
    if (!confirm('Deseja realmente soltar este exemplar de volta à água?')) return;

    try {
      const res = await fetch('/api/fish/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: this.currentUser.id, fishId }),
      });
      const data = await res.json();
      if (data.success) {
        this.inventory = data.inventory;
        this.updateHeaderBackpack();
        this.showToast('Peixe libertado na água com sucesso!', 'info');
        this.openBackpackModal(); // Re-renderizar modal
      }
    } catch {
      this.showToast('Erro ao soltar peixe', 'danger');
    }
  }

  // ===================== SISTEMA DE TROCAS (WEBSOCKET) =====================

  private setupSocketListeners() {
    this.socket.on('connect', () => {
      this.isSocketConnected = true;
      if (this.currentUser) {
        this.socket.emit('player:join', {
          id: this.currentUser.id,
          name: this.currentUser.name,
          email: this.currentUser.email,
        });
      }
    });

    this.socket.on('disconnect', () => {
      this.isSocketConnected = false;
    });

    this.socket.on('connect_error', () => {
      this.isSocketConnected = false;
    });

    // 1. Atualização da lista de jogadores online
    this.socket.on('players:online_list', (players: OnlinePlayer[]) => {
      const otherPlayers = players.filter((p) => p.id !== this.currentUser?.id);
      const badge = document.getElementById('onlineCountBadge');
      if (badge) {
        badge.textContent = `${otherPlayers.length}`;
      }
      this.renderOnlinePlayersList(otherPlayers);
    });

    // 2. Notificação de convite recebido
    this.socket.on('trade:invited', (data: { sessionId: string; from: { id: string; name: string; email: string } }) => {
      this.pendingInviteSessionId = data.sessionId;
      const modal = document.getElementById('tradeInviteReceivedModal')!;
      const msg = document.getElementById('tradeInviteMessage')!;
      msg.textContent = `O pescador ${data.from.name} (${data.from.email}) quer negociar peixes com você!`;
      modal.style.display = 'flex';
      sound.playBite();
    });

    // 3. Convite enviado com sucesso
    this.socket.on('trade:invite_sent', (data: { sessionId: string; to: { id: string; name: string } }) => {
      this.showToast(`Convite de troca enviado para ${data.to.name}! Aguardando resposta...`, 'info');
    });

    // 4. Convite recusado
    this.socket.on('trade:declined', (data: { by: string }) => {
      this.showToast(`${data.by} recusou o convite de negociação.`, 'danger');
    });

    // 5. Início da sessão ativa de troca
    this.socket.on('trade:started', (data: { sessionId: string; session: TradeSession }) => {
      this.activeTradeSession = data.session;
      this.selectedTradeItemIds = [];
      this.closeModal('tradingLobbyModal');
      this.closeModal('tradeInviteReceivedModal');
      this.openTradeRoom(data.session);
    });

    // 6. Sincronização em tempo real das ofertas
    this.socket.on(
      'trade:sync',
      (data: { session: TradeSession; itemsOfferA: FishInstance[]; itemsOfferB: FishInstance[] }) => {
        this.activeTradeSession = data.session;
        this.renderTradeRoomSync(data.session, data.itemsOfferA, data.itemsOfferB);
      }
    );

    // 7. Troca concluída com sucesso!
    this.socket.on('trade:completed', (data: { message: string; updatedInventory: FishInstance[] }) => {
      this.inventory = data.updatedInventory;
      this.updateHeaderBackpack();
      this.closeModal('tradeRoomModal');
      this.activeTradeSession = null;
      this.selectedTradeItemIds = [];
      sound.playTradeSuccess();
      this.showToast(data.message, 'success');
    });

    // 8. Troca cancelada
    this.socket.on('trade:cancelled', (data: { reason: string }) => {
      this.closeModal('tradeRoomModal');
      this.activeTradeSession = null;
      this.selectedTradeItemIds = [];
      this.showToast(data.reason || 'Negociação cancelada.', 'info');
    });

    // 9. Erro de negociação
    this.socket.on('trade:error', (data: { message: string }) => {
      this.showToast(data.message, 'danger');
    });
  }

  /**
   * Sincronização Serverless (Vercel): Polling automático quando WebSockets não estiverem disponíveis
   */
  private startServerlessPolling() {
    // 1. Heartbeat a cada 4 segundos
    setInterval(async () => {
      if (!this.currentUser) return;
      if (this.isSocketConnected) return;

      try {
        const res = await fetch('/api/players/heartbeat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user: this.currentUser,
            status: this.activeTradeSession ? 'TRADING' : 'IDLE',
          }),
        });
        const data = await res.json();
        if (data.success && data.online) {
          const otherPlayers = data.online.filter((p: any) => p.id !== this.currentUser?.id);
          const badge = document.getElementById('onlineCountBadge');
          if (badge) badge.textContent = `${otherPlayers.length}`;
          this.renderOnlinePlayersList(otherPlayers);
        }
      } catch {}
    }, 4000);

    // 2. Polling de Negociações a cada 1.5 segundos
    setInterval(async () => {
      if (!this.currentUser) return;
      if (this.isSocketConnected) return;

      try {
        const res = await fetch(`/api/trade/poll?userId=${this.currentUser.id}`);
        const data = await res.json();
        if (!data.active || !data.session) {
          if (this.activeTradeSession && this.activeTradeSession.status !== 'COMPLETED') {
            this.closeModal('tradeRoomModal');
            this.activeTradeSession = null;
          }
          return;
        }

        const session: TradeSession = data.session;

        if (session.status === 'PENDING' && session.receiver.userId === this.currentUser.id) {
          if (!this.pendingInviteSessionId) {
            this.pendingInviteSessionId = session.id;
            const modal = document.getElementById('tradeInviteReceivedModal')!;
            const msg = document.getElementById('tradeInviteMessage')!;
            msg.textContent = `O pescador ${session.sender.userName} (${session.sender.userEmail}) quer negociar peixes com você!`;
            modal.style.display = 'flex';
            sound.playBite();
          }
        } else if (session.status === 'ACTIVE') {
          if (this.pendingInviteSessionId) {
            this.closeModal('tradeInviteReceivedModal');
            this.pendingInviteSessionId = null;
          }
          if (!this.activeTradeSession) {
            this.closeModal('tradingLobbyModal');
            this.activeTradeSession = session;
            this.selectedTradeItemIds = [];
            this.openTradeRoom(session);
          }
          this.activeTradeSession = session;
          this.renderTradeRoomSync(session, data.itemsOfferA, data.itemsOfferB);
        } else if (session.status === 'COMPLETED') {
          if (this.activeTradeSession) {
            this.closeModal('tradeRoomModal');
            this.activeTradeSession = null;
            this.selectedTradeItemIds = [];
            sound.playTradeSuccess();
            this.showToast('Troca concluída com sucesso!', 'success');
            this.fetchUserData(this.currentUser.id);
          }
        } else if (session.status === 'DECLINED' || session.status === 'CANCELLED') {
          if (this.activeTradeSession) {
            this.closeModal('tradeRoomModal');
            this.activeTradeSession = null;
            this.selectedTradeItemIds = [];
            this.showToast(session.status === 'DECLINED' ? 'Convite de troca recusado.' : 'Troca cancelada.', 'info');
          }
        }
      } catch {}
    }, 1500);
  }

  private async sendTradeInvite(params: { targetUserId?: string; targetEmail?: string }) {
    if (this.isSocketConnected) {
      this.socket.emit('trade:request', params);
    } else {
      try {
        const res = await fetch('/api/trade/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            senderId: this.currentUser?.id,
            targetUserId: params.targetUserId,
            targetEmail: params.targetEmail,
          }),
        });
        const data = await res.json();
        if (data.success) {
          this.showToast('Convite de troca enviado! Aguardando resposta...', 'info');
        } else {
          this.showToast(data.error || 'Erro ao enviar convite.', 'danger');
        }
      } catch {
        this.showToast('Erro ao enviar convite de troca.', 'danger');
      }
    }
  }

  private async respondTradeInvite(accept: boolean) {
    if (!this.pendingInviteSessionId) return;
    if (this.isSocketConnected) {
      this.socket.emit('trade:respond', {
        sessionId: this.pendingInviteSessionId,
        accept,
      });
    } else {
      try {
        await fetch('/api/trade/respond', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: this.pendingInviteSessionId,
            accept,
          }),
        });
      } catch {}
    }
    if (!accept) {
      this.closeModal('tradeInviteReceivedModal');
      this.pendingInviteSessionId = null;
    }
  }

  private async confirmActiveTrade() {
    if (!this.activeTradeSession) return;
    if (this.isSocketConnected) {
      this.socket.emit('trade:confirm', { sessionId: this.activeTradeSession.id });
    } else {
      try {
        const res = await fetch('/api/trade/confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: this.activeTradeSession.id,
            userId: this.currentUser?.id,
          }),
        });
        const data = await res.json();
        if (data.success) {
          if (data.completed) {
            this.inventory = data.updatedInventory;
            this.updateHeaderBackpack();
            this.closeModal('tradeRoomModal');
            this.activeTradeSession = null;
            this.selectedTradeItemIds = [];
            sound.playTradeSuccess();
            this.showToast('Troca concluída com sucesso!', 'success');
          } else {
            this.activeTradeSession = data.session;
          }
        } else {
          this.showToast(data.error || 'Erro ao confirmar troca.', 'danger');
        }
      } catch {}
    }
  }

  private async cancelActiveTrade() {
    if (!this.activeTradeSession) return;
    if (this.isSocketConnected) {
      this.socket.emit('trade:cancel', { sessionId: this.activeTradeSession.id });
    } else {
      try {
        await fetch('/api/trade/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: this.activeTradeSession.id }),
        });
      } catch {}
      this.closeModal('tradeRoomModal');
      this.activeTradeSession = null;
      this.selectedTradeItemIds = [];
      this.showToast('Negociação cancelada.', 'info');
    }
  }

  private openTradingLobby(preselectedFishId?: string) {
    if (!this.currentUser) {
      this.showLoginModal();
      return;
    }
    if (preselectedFishId) {
      this.selectedTradeItemIds = [preselectedFishId];
    }
    const modal = document.getElementById('tradingLobbyModal')!;
    modal.style.display = 'flex';
  }

  private renderOnlinePlayersList(players: OnlinePlayer[]) {
    const list = document.getElementById('onlinePlayersList');
    if (!list) return;

    if (players.length === 0) {
      list.innerHTML = `
        <div style="text-align: center; color: var(--text-muted); padding: 16px;">
          Nenhum outro jogador conectado no momento. Abra uma segunda aba para testar!
        </div>
      `;
      return;
    }

    let html = '';
    for (const p of players) {
      const isBusy = p.status === 'TRADING';
      html += `
        <div class="player-row">
          <div>
            <strong>${p.name}</strong>
            <div style="font-size: 11px; color: var(--text-muted);">${p.email}</div>
          </div>
          <div style="display: flex; align-items: center; gap: 10px;">
            <span class="player-status-tag ${isBusy ? 'tag-trading' : 'tag-idle'}">
              ${isBusy ? 'Em Troca' : 'Disponível'}
            </span>
            <button class="btn btn-primary btn-invite-player" data-user-id="${p.id}" ${isBusy ? 'disabled' : ''}>
              Convidar
            </button>
          </div>
        </div>
      `;
    }
    list.innerHTML = html;

    list.querySelectorAll('.btn-invite-player').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const targetUserId = (e.currentTarget as HTMLElement).getAttribute('data-user-id')!;
        this.socket.emit('trade:request', { targetUserId });
      });
    });
  }

  private openTradeRoom(session: TradeSession) {
    const modal = document.getElementById('tradeRoomModal')!;
    const isSender = session.sender.userId === this.currentUser?.id;
    const myOffer = isSender ? session.sender : session.receiver;
    const partnerOffer = isSender ? session.receiver : session.sender;

    document.getElementById('localPlayerNameLabel')!.textContent = `${myOffer.userName} (Você)`;
    document.getElementById('remotePlayerNameLabel')!.textContent = partnerOffer.userName;

    this.renderTradeInventoryChips();
    this.renderTradeSlots([], []);
    modal.style.display = 'flex';
  }

  private renderTradeInventoryChips() {
    const chipsContainer = document.getElementById('tradeInventoryChips')!;
    if (this.inventory.length === 0) {
      chipsContainer.innerHTML = '<span style="font-size: 12px; color: #94a3b8;">Nenhum peixe na mochila.</span>';
      return;
    }

    let html = '';
    for (const item of this.inventory) {
      const isSelected = this.selectedTradeItemIds.includes(item.id);
      const isMaxReached = this.selectedTradeItemIds.length >= 3 && !isSelected;
      html += `
        <div class="trade-inventory-chip ${isSelected ? 'selected-for-trade' : ''} ${isMaxReached ? 'disabled' : ''}" data-fish-id="${item.id}">
          <strong>${item.name}</strong>
          <span>${item.formattedWeight}</span>
        </div>
      `;
    }
    chipsContainer.innerHTML = html;

    chipsContainer.querySelectorAll('.trade-inventory-chip').forEach((chip) => {
      chip.addEventListener('click', (e) => {
        const id = (e.currentTarget as HTMLElement).getAttribute('data-fish-id')!;
        this.toggleItemInTradeOffer(id);
      });
    });
  }

  private toggleItemInTradeOffer(fishId: string) {
    if (!this.activeTradeSession) return;

    if (this.selectedTradeItemIds.includes(fishId)) {
      this.selectedTradeItemIds = this.selectedTradeItemIds.filter((id) => id !== fishId);
    } else {
      if (this.selectedTradeItemIds.length >= 3) {
        this.showToast('Você só pode ofertar até 3 peixes por troca.', 'danger');
        return;
      }
      this.selectedTradeItemIds.push(fishId);
    }

    // Sincronizar via WebSocket (se conectado) ou via REST API (Vercel Serverless)
    if (this.isSocketConnected) {
      this.socket.emit('trade:offer_update', {
        sessionId: this.activeTradeSession.id,
        itemIds: this.selectedTradeItemIds,
      });
    } else {
      fetch('/api/trade/offer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: this.activeTradeSession.id,
          userId: this.currentUser?.id,
          itemIds: this.selectedTradeItemIds,
        }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (data.success) {
            this.activeTradeSession = data.session;
            this.renderTradeRoomSync(data.session, data.itemsOfferA, data.itemsOfferB);
          }
        })
        .catch(() => {});
    }

    this.renderTradeInventoryChips();
  }

  private renderTradeRoomSync(session: TradeSession, itemsA: FishInstance[], itemsB: FishInstance[]) {
    const isSender = session.sender.userId === this.currentUser?.id;
    const myOffer = isSender ? session.sender : session.receiver;
    const partnerOffer = isSender ? session.receiver : session.sender;

    const myItems = isSender ? itemsA : itemsB;
    const partnerItems = isSender ? itemsB : itemsA;

    // Atualizar labels de status de confirmação
    const localStatus = document.getElementById('localPlayerReadyStatus')!;
    const remoteStatus = document.getElementById('remotePlayerReadyStatus')!;
    const localBox = document.getElementById('localPlayerBox')!;
    const remoteBox = document.getElementById('remotePlayerBox')!;

    if (myOffer.isConfirmed) {
      localStatus.textContent = 'Confirmado ✓';
      localStatus.style.background = 'rgba(34, 197, 94, 0.2)';
      localStatus.style.color = '#4ade80';
      localBox.classList.add('ready');
    } else {
      localStatus.textContent = `${myOffer.offeredItemIds.length} item(ns) ofertado(s)`;
      localStatus.style.background = 'rgba(148, 163, 184, 0.2)';
      localStatus.style.color = '#cbd5e1';
      localBox.classList.remove('ready');
    }

    if (partnerOffer.isConfirmed) {
      remoteStatus.textContent = 'Confirmado ✓';
      remoteStatus.style.background = 'rgba(34, 197, 94, 0.2)';
      remoteStatus.style.color = '#4ade80';
      remoteBox.classList.add('ready');
    } else {
      remoteStatus.textContent = `${partnerOffer.offeredItemIds.length} item(ns) ofertado(s)`;
      remoteStatus.style.background = 'rgba(148, 163, 184, 0.2)';
      remoteStatus.style.color = '#cbd5e1';
      remoteBox.classList.remove('ready');
    }

    this.renderTradeSlots(myItems, partnerItems);

    // Atualizar botão de confirmação
    const btnConfirm = document.getElementById('btnConfirmTrade') as HTMLButtonElement;
    if (myOffer.isConfirmed) {
      btnConfirm.disabled = true;
      btnConfirm.textContent = 'Aguardando parceiro...';
    } else {
      btnConfirm.disabled = false;
      btnConfirm.textContent = '🔒 Confirmar Troca';
    }
  }

  private renderTradeSlots(localItems: FishInstance[], remoteItems: FishInstance[]) {
    const localContainer = document.getElementById('localTradeSlots')!;
    const remoteContainer = document.getElementById('remoteTradeSlots')!;

    localContainer.innerHTML = this.buildSlotsHtml(localItems, true);
    remoteContainer.innerHTML = this.buildSlotsHtml(remoteItems, false);

    // Listeners para remover item local
    localContainer.querySelectorAll('.slot-remove-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const id = (e.currentTarget as HTMLElement).getAttribute('data-id')!;
        this.toggleItemInTradeOffer(id);
      });
    });
  }

  private buildSlotsHtml(items: FishInstance[], isLocal: boolean): string {
    let html = '';
    for (let i = 0; i < 3; i++) {
      const item = items[i];
      if (item) {
        html += `
          <div class="trade-slot filled">
            ${isLocal ? `<button class="slot-remove-btn" data-id="${item.id}">✕</button>` : ''}
            <div style="font-weight: 700; font-size: 12px; margin-top: 4px;">${item.name}</div>
            <div style="color: #38bdf8; font-size: 11px;">${item.formattedWeight}</div>
            <div style="font-size: 10px; color: #94a3b8;">Nível ${item.rarity}</div>
          </div>
        `;
      } else {
        html += `
          <div class="trade-slot">
            <span>Slot Vazio</span>
          </div>
        `;
      }
    }
    return html;
  }

  // ===================== PEIXEPÉDIA (CATÁLOGO) =====================

  private renderCatalog() {
    const tbody = document.getElementById('catalogTableBody');
    if (!tbody) return;

    let html = '';
    for (let tier = 1; tier <= 6; tier++) {
      const cfg = RARITY_CONFIGS[tier as 1 | 2 | 3 | 4 | 5 | 6];
      const species = SPECIES_BY_RARITY[tier as 1 | 2 | 3 | 4 | 5 | 6] || [];
      const speciesNames = species.map((s) => s.name).join(', ');

      html += `
        <tr>
          <td>
            <span class="brand-badge" style="background: ${cfg.badgeBg}; color: ${cfg.glowColor}; border-color: ${cfg.color};">
              Nível ${cfg.tier} - ${cfg.label}
            </span>
          </td>
          <td><strong>${cfg.percentage}%</strong></td>
          <td>${speciesNames}</td>
          <td><code>${cfg.typicalWeightRange}</code></td>
        </tr>
      `;
    }
    tbody.innerHTML = html;
  }

  // ===================== HELPERS E LISTENERS =====================

  private setupUIListeners() {
    // 1. Botão Pescar
    const btnFishAction = document.getElementById('btnFishAction')!;
    btnFishAction.addEventListener('click', () => this.handleFishClick());

    // Atalho: Tecla ESPAÇO
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && (e.target as HTMLElement).tagName !== 'INPUT') {
        e.preventDefault();
        this.handleFishClick();
      }
    });

    // 2. Formulário de Login
    const loginForm = document.getElementById('loginForm') as HTMLFormElement;
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = (document.getElementById('loginName') as HTMLInputElement).value.trim();
      const email = (document.getElementById('loginEmail') as HTMLInputElement).value.trim();

      if (!name || !email) return;

      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, email }),
        });

        const data = await res.json();
        if (data.success) {
          this.setUser(data.user, data.inventory);
          this.closeModal('loginModal');
          this.showToast(`Bem-vindo, ${data.user.name}!`, 'success');
        } else {
          this.showToast(data.error || 'Erro no login', 'danger');
        }
      } catch {
        this.showToast('Erro de conexão ao fazer login', 'danger');
      }
    });

    // 3. Ações na Recompensa de Pesca
    document.getElementById('btnKeepFish')!.addEventListener('click', () => this.keepCaughtFish());
    document.getElementById('btnReleaseFish')!.addEventListener('click', () => this.releaseCaughtFish());

    // 4. Mochila
    document.getElementById('btnOpenBackpack')!.addEventListener('click', () => this.openBackpackModal());

    // 5. Hub de Trocas
    document.getElementById('btnOpenTrading')!.addEventListener('click', () => this.openTradingLobby());

    // 6. Convidar por E-mail
    document.getElementById('btnInviteByEmail')!.addEventListener('click', () => {
      const emailInput = document.getElementById('tradeTargetEmailInput') as HTMLInputElement;
      const targetEmail = emailInput.value.trim();
      if (!targetEmail) {
        this.showToast('Informe o e-mail do jogador para convidar.', 'info');
        return;
      }
      this.sendTradeInvite({ targetEmail });
      emailInput.value = '';
    });

    // 7. Responder Convite
    document.getElementById('btnAcceptTradeInvite')!.addEventListener('click', () => {
      this.respondTradeInvite(true);
    });

    document.getElementById('btnDeclineTradeInvite')!.addEventListener('click', () => {
      this.respondTradeInvite(false);
    });

    // 8. Confirmar / Cancelar Troca
    document.getElementById('btnConfirmTrade')!.addEventListener('click', () => {
      this.confirmActiveTrade();
    });

    document.getElementById('btnCancelTrade')!.addEventListener('click', () => {
      this.cancelActiveTrade();
    });

    // 9. Catálogo
    document.getElementById('btnOpenCatalog')!.addEventListener('click', () => {
      document.getElementById('catalogModal')!.style.display = 'flex';
    });

    // 10. Som
    const btnSound = document.getElementById('btnToggleSound')!;
    btnSound.addEventListener('click', () => {
      sound.enabled = !sound.enabled;
      btnSound.textContent = sound.enabled ? '🔊' : '🔇';
      this.showToast(sound.enabled ? 'Som ativado' : 'Som desativado', 'info');
    });

    // 11. Compartilhar no WhatsApp e Copiar
    document.getElementById('btnShareWhatsApp')?.addEventListener('click', () => {
      if (this.pendingCatch?.shareText) {
        this.shareOnWhatsApp(this.pendingCatch.shareText);
      }
    });

    document.getElementById('btnCopyShareText')?.addEventListener('click', () => {
      if (this.pendingCatch?.shareText) {
        this.copyShareText(this.pendingCatch.shareText);
      }
    });

    // 12. Logout / Trocar Jogador
    document.getElementById('btnLogout')!.addEventListener('click', () => {
      localStorage.removeItem('pescaria_user');
      window.location.reload();
    });

    // Fechar modais pelos botões com data-close
    document.querySelectorAll('[data-close]').forEach((el) => {
      el.addEventListener('click', (e) => {
        const targetId = (e.currentTarget as HTMLElement).getAttribute('data-close')!;
        this.closeModal(targetId);
      });
    });
  }

  private async shareOnWhatsApp(text: string) {
    if (navigator.share && /mobile|android|iphone|ipad/i.test(navigator.userAgent)) {
      try {
        await navigator.share({
          title: 'Minha Fisgada no Pescaria 2D!',
          text,
        });
        return;
      } catch {
        // Usuário cancelou ou fallback
      }
    }

    const url = `https://api.whatsapp.com/send?text=${encodeURIComponent(text)}`;
    window.open(url, '_blank');
  }

  private async copyShareText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      this.showToast('📋 Texto copiado para a área de transferência!', 'success');
    } catch {
      this.showToast('Não foi possível copiar automaticamente.', 'danger');
    }
  }

  private updateHeaderBackpack() {
    if (!this.currentUser) return;
    const backpackEl = document.getElementById('headerBackpackCount');
    if (backpackEl) {
      backpackEl.textContent = `🎒 ${this.inventory.length}/${this.currentUser.maxBackpackCapacity}`;
    }
  }

  private showLoginModal() {
    const modal = document.getElementById('loginModal')!;
    modal.style.display = 'flex';
  }

  private closeModal(modalId: string) {
    const modal = document.getElementById(modalId);
    if (modal) {
      modal.style.display = 'none';
    }
  }

  private showToast(message: string, type: 'success' | 'danger' | 'info' = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = 'toast';

    let icon = 'ℹ️';
    let borderColor = 'rgba(255, 255, 255, 0.2)';
    if (type === 'success') {
      icon = '✅';
      borderColor = '#22c55e';
    } else if (type === 'danger') {
      icon = '⚠️';
      borderColor = '#ef4444';
    }

    toast.style.borderColor = borderColor;
    toast.innerHTML = `<span>${icon}</span><span>${message}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(100%)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3800);
  }
}

// Inicializar aplicação assim que a janela carregar
window.addEventListener('DOMContentLoaded', () => {
  new FishingApp();
});
