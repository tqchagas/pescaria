/**
 * Tipos e Interfaces do Jogo de Pesca 2D
 */

export type RarityTier = 1 | 2 | 3 | 4 | 5 | 6;

export interface RarityConfig {
  tier: RarityTier;
  label: string;
  probability: number; // Fração 0 a 1 (ex: 0.40 = 40%)
  percentage: number;  // 40, 25, 18, 10, 5, 2
  color: string;
  glowColor: string;
  badgeBg: string;
  typicalWeightRange: string;
  stars: string; // Ex: "★☆☆☆☆☆"
}

export interface FishSpecies {
  id: string;
  name: string;
  rarity: RarityTier;
  minWeight: number; // Em gramas (g)
  maxWeight: number; // Em gramas (g)
  description: string;
  baseColor: string;
  accentColor: string;
  finColor: string;
  bodyLengthRatio: number; // Razão de proporção para renderização gráfica
}

export interface FishInstance {
  id: string;
  speciesId: string;
  name: string;
  rarity: RarityTier;
  weight: number; // Peso exato em gramas
  formattedWeight: string; // Ex: "185 g" ou "4.25 kg"
  caughtAt: string; // ISO 8601
  userId?: string;
  trophySizeLabel?: string; // "Pequeno", "Médio", "Grande", "Gigante", "Troféu Lendário"
  trophyScore?: number;
}

export interface EnvironmentContext {
  location: string;
  weather: string;
  period: string;
}

export interface User {
  id: string;
  name: string;
  email: string;
  createdAt: string;
  maxBackpackCapacity: number;
}

export interface UserWithInventory extends User {
  inventory: FishInstance[];
}

export type FishingState =
  | 'IDLE'             // Esperando ação do jogador (vara parada)
  | 'CASTING'          // Jogador arremessou a linha; boia em trajetória parabólica
  | 'REELING'          // Boia na água, aguardando mordida ou puxando fisgada
  | 'CAUGHT'           // Fisgou! Peixe salta e tela de vitória/recompensa prepara
  | 'INVENTORY_ACTION'; // Modal aberto: jogador escolhe Guardar ou Soltar

export type TradeStatus =
  | 'PENDING'
  | 'ACTIVE'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'DECLINED';

export interface TradeOffer {
  userId: string;
  userName: string;
  userEmail: string;
  socketId: string;
  offeredItemIds: string[]; // 0 a 3 itens selecionados
  isReady: boolean;        // Bloqueou sua oferta
  isConfirmed: boolean;    // Clicou no botão final de confirmação
}

export interface TradeSession {
  id: string;
  sender: TradeOffer;
  receiver: TradeOffer;
  status: TradeStatus;
  createdAt: number;
  updatedAt: number;
}

export interface OnlinePlayer {
  id: string;
  name: string;
  email: string;
  socketId: string;
  status: 'IDLE' | 'FISHING' | 'TRADING';
}

// Respostas de APIs REST
export interface LoginResponse {
  success: boolean;
  user: User;
  inventory: FishInstance[];
}

export interface CatchFishResult {
  fish: FishInstance;
  species: FishSpecies;
  rarityConfig: RarityConfig;
  backpackFull: boolean;
  currentInventoryCount: number;
  maxCapacity: number;
  isNewDiscovery: boolean;
  isNewRecord: boolean;
  trophySizeLabel: string;
  uniqueSpeciesDiscovered: number;
  totalSpecies: number;
  catchesToday: number;
  streakDays: number;
  environment: EnvironmentContext;
  shareText: string;
}

export interface ActionFishResponse {
  success: boolean;
  action: 'KEPT' | 'RELEASED';
  fish: FishInstance;
  inventory: FishInstance[];
  message: string;
}
