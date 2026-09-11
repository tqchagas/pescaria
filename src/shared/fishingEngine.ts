import { FishInstance, FishSpecies, RarityTier } from './types.js';
import { FISH_SPECIES_CATALOG, RARITY_CONFIGS, SPECIES_BY_RARITY } from './fishData.js';

/**
 * Gerador Pseudo-Aleatório Determinístico (Mulberry32)
 * Permite reproduzir sorteios idênticos a partir de uma semente (seed).
 */
export class Mulberry32PRNG {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /**
   * Retorna um número determinístico no intervalo [0, 1)
   */
  public next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

/**
 * Tabela de limites de probabilidade cumulativa para faixas de raridade 1 a 6
 */
export const CUMULATIVE_RARITY_THRESHOLDS: Array<{ tier: RarityTier; threshold: number }> = [
  { tier: 1, threshold: 0.40 }, // 40% (0.00 a 0.40)
  { tier: 2, threshold: 0.65 }, // 25% (0.40 a 0.65)
  { tier: 3, threshold: 0.83 }, // 18% (0.65 a 0.83)
  { tier: 4, threshold: 0.93 }, // 10% (0.83 a 0.93)
  { tier: 5, threshold: 0.98 }, // 5%  (0.93 a 0.98)
  { tier: 6, threshold: 1.00 }, // 2%  (0.98 a 1.00)
];

/**
 * Sorteia a raridade com base em uma probabilidade cumulativa estrita.
 * @param roll Valor entre 0 e 1 (se omitido, usa Math.random())
 */
export function rollRarity(roll?: number): RarityTier {
  const value = roll !== undefined ? Math.max(0, Math.min(0.999999, roll)) : Math.random();

  for (const item of CUMULATIVE_RARITY_THRESHOLDS) {
    if (value < item.threshold) {
      return item.tier;
    }
  }

  return 1;
}

/**
 * Escolhe aleatoriamente uma espécie dentro da raridade especificada.
 * @param rarity Nível de raridade (1 a 6)
 * @param speciesRoll Valor entre 0 e 1
 */
export function pickSpecies(rarity: RarityTier, speciesRoll?: number): FishSpecies {
  const pool = SPECIES_BY_RARITY[rarity];
  if (!pool || pool.length === 0) {
    return FISH_SPECIES_CATALOG[0];
  }
  const roll = speciesRoll !== undefined ? Math.max(0, Math.min(0.999999, speciesRoll)) : Math.random();
  const index = Math.floor(roll * pool.length);
  return pool[index];
}

/**
 * Formata o peso em gramas para exibição amigável (g ou kg).
 * @param weightInGrams Peso em gramas
 */
export function formatWeight(weightInGrams: number): string {
  if (weightInGrams < 1000) {
    return `${Math.round(weightInGrams)} g`;
  }
  const inKg = weightInGrams / 1000;
  return `${inKg.toFixed(2)} kg`;
}

/**
 * Calcula o peso do exemplar pescado.
 * 
 * Regra:
 * O peso do exemplar pescado é sorteado dentro da faixa [minWeight, maxWeight] da espécie.
 * Utiliza-se uma distribuição Gaussiana/Triangular aproximada (média de duas amostras independentes)
 * para favorecer pesos medianos típicos, enquanto mantém a emoção de capturar espécimes raros "troféu"
 * próximos do topo da faixa.
 *
 * @param species A espécie do peixe
 * @param primaryRoll Primeiro valor pseudo-aleatório [0, 1)
 * @param secondaryRoll Segundo valor pseudo-aleatório [0, 1)
 */
export function calculateWeight(
  species: FishSpecies,
  primaryRoll?: number,
  secondaryRoll?: number
): { weight: number; formattedWeight: string; trophyScore: number } {
  const r1 = primaryRoll !== undefined ? Math.max(0, Math.min(0.999999, primaryRoll)) : Math.random();
  const r2 = secondaryRoll !== undefined ? Math.max(0, Math.min(0.999999, secondaryRoll)) : Math.random();

  // Fator de distribuição suave centralizada com cauda natural
  // (r1 + r2) / 2 produz uma curva triangular contínua com média em 0.5
  const normalizedFactor = (r1 + r2) / 2;

  // Modificador sutil pela raridade: espécies de raridade superior têm uma leve tendência
  // a demonstrar peso mais imponente na faixa de pesca esportiva
  const rarityBonus = (species.rarity - 1) * 0.015; // De 0% a 7.5%
  const finalFactor = Math.min(1.0, Math.max(0.0, normalizedFactor + rarityBonus * (r1 - 0.5)));

  const span = species.maxWeight - species.minWeight;
  const exactWeightInGrams = Math.round(species.minWeight + span * finalFactor);

  // Trophy Score de 0 a 100% indicando o quão próximo do peso máximo o exemplar ficou
  const trophyScore = Math.round(((exactWeightInGrams - species.minWeight) / (span || 1)) * 100);

  return {
    weight: exactWeightInGrams,
    formattedWeight: formatWeight(exactWeightInGrams),
    trophyScore,
  };
}

/**
 * Gera uma instância completa de peixe fisgado, determinística se fornecida uma semente.
 */
export function generateCatch(options?: {
  seed?: number;
  forceRarity?: RarityTier;
  forceSpeciesId?: string;
}): { fish: FishInstance; species: FishSpecies } {
  let rng: Mulberry32PRNG | null = null;
  if (options?.seed !== undefined) {
    rng = new Mulberry32PRNG(options.seed);
  }

  const nextRand = () => (rng ? rng.next() : Math.random());

  // 1. Sortear raridade
  const rarity = options?.forceRarity ?? rollRarity(nextRand());

  // 2. Sortear espécie
  let species: FishSpecies;
  if (options?.forceSpeciesId) {
    const found = FISH_SPECIES_CATALOG.find((f) => f.id === options.forceSpeciesId);
    species = found || pickSpecies(rarity, nextRand());
  } else {
    species = pickSpecies(rarity, nextRand());
  }

  // 3. Sortear peso
  const { weight, formattedWeight, trophyScore } = calculateWeight(species, nextRand(), nextRand());
  const trophySizeLabel = getTrophySizeLabel(trophyScore);

  // 4. Montar instância única
  const fish: FishInstance = {
    id: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `fish_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
    speciesId: species.id,
    name: species.name,
    rarity: species.rarity,
    weight,
    formattedWeight,
    caughtAt: new Date().toISOString(),
    trophyScore,
    trophySizeLabel,
  };

  return { fish, species };
}

/**
 * Classificação amigável do porte do espécime com base na pontuação de troféu
 */
export function getTrophySizeLabel(trophyScore: number): string {
  if (trophyScore < 25) return 'Pequeno';
  if (trophyScore < 60) return 'Médio';
  if (trophyScore < 85) return 'Grande';
  if (trophyScore < 95) return 'Gigante';
  return 'Troféu Lendário';
}

/**
 * Contexto ambiental e climático do momento da pescaria
 */
export function getEnvironmentContext(date: Date = new Date()): {
  location: string;
  weather: string;
  period: string;
} {
  const hour = date.getHours();
  let period = 'Manhã';
  if (hour >= 12 && hour < 18) period = 'Tarde';
  else if (hour >= 18 && hour < 20) period = 'Entardecer';
  else if (hour >= 20 || hour < 5) period = 'Noite';

  const locations = [
    'Lago Cristalino 🏝️',
    'Rio das Antas 🌴',
    'Represa Imperial 🌊',
    'Riacho das Pedras 🏞️',
  ];
  const weathers = [
    '☀️ Ensolarado',
    '🌤️ Céu Limpo',
    '⛅ Nublado',
    '🌧️ Chuva Suave',
    '⛈️ Tempestade',
  ];

  const locIndex = (date.getDate() + date.getMonth()) % locations.length;
  const weatherIndex = (date.getHours() + date.getMinutes()) % weathers.length;

  return {
    location: locations[locIndex],
    weather: weathers[weatherIndex],
    period,
  };
}

export interface WhatsAppShareParams {
  fish: FishInstance;
  rarityConfig: { label: string; stars: string };
  trophySizeLabel: string;
  isNewDiscovery?: boolean;
  isNewRecord?: boolean;
  environment: { location: string; weather: string; period: string };
  catchesToday: number;
  currentInventoryCount: number;
  maxCapacity: number;
  uniqueSpeciesDiscovered: number;
  totalSpecies: number;
  streakDays: number;
  gameUrl?: string;
}

/**
 * Constrói o texto perfeitamente formatado para compartilhamento no WhatsApp
 */
export function generateWhatsAppShareText(params: WhatsAppShareParams): string {
  const {
    fish,
    rarityConfig,
    trophySizeLabel,
    isNewDiscovery = false,
    isNewRecord = false,
    environment,
    catchesToday,
    currentInventoryCount,
    maxCapacity,
    uniqueSpeciesDiscovered,
    totalSpecies,
    streakDays,
    gameUrl = 'https://pescaria2d.app',
  } = params;

  const shortId = fish.id.replace(/-/g, '').substring(0, 10).toUpperCase();

  let streakLevel = 'Bronze';
  if (streakDays >= 14) streakLevel = 'Diamante 💎';
  else if (streakDays >= 7) streakLevel = 'Ouro 🥇';
  else if (streakDays >= 3) streakLevel = 'Prata 🥈';

  const lines: string[] = [
    `🐟 *${fish.name}*`,
    `🎖️ ${rarityConfig.label} — ${rarityConfig.stars}`,
    `⚖️ ${fish.formattedWeight}`,
    `🫧 Tamanho: ${trophySizeLabel}`,
    `🆔 ${shortId}`,
  ];

  if (isNewDiscovery) {
    lines.push(`🆕 *NOVA DESCOBERTA NO ÁLBUM!*`);
  }
  if (isNewRecord) {
    lines.push(`🏆 *Novo recorde pessoal desta espécie!*`);
  }

  lines.push(
    ``,
    `📍 ${environment.location} | ${environment.weather}`,
    `🌅 Período: ${environment.period}`,
    `🎣 Hoje: ${catchesToday} fisgado(s)`,
    `📦 Mochila: ${currentInventoryCount}/${maxCapacity}`,
    `📗 Espécies no Álbum: ${uniqueSpeciesDiscovered}/${totalSpecies}`,
    `🔥 Streak: ${streakDays} dia(s) — nível ${streakLevel}`,
    `🎯 Missão: ${isNewDiscovery || isNewRecord ? 'completa ✅' : 'em progresso 🎣'}`,
    ``,
    `🎣 *Venha pescar comigo no Pescaria 2D!*`,
    gameUrl
  );

  return lines.join('\n');
}

/**
 * Validação de integridade para a troca entre dois jogadores.
 * Garante que:
 * 1. Cada jogador oferta de 1 a 3 itens (ou de 0 a 3 se permitido troca unilateral com consentimento).
 * 2. Ambos possuem itens válidos e únicos em seus inventários.
 * 3. O espaço pós-troca de ambos não ultrapassa o limite da mochila.
 */
export function validateTradeCapacity(
  inventoryA: FishInstance[],
  inventoryB: FishInstance[],
  offerAIds: string[],
  offerBIds: string[],
  maxCapacity: number = 20
): { valid: boolean; error?: string } {
  // 1. Limite de 1 a 3 itens por proposta
  if (offerAIds.length === 0 && offerBIds.length === 0) {
    return { valid: false, error: 'A troca precisa incluir pelo menos um peixe ofertado.' };
  }
  if (offerAIds.length > 3) {
    return { valid: false, error: 'Jogador A não pode ofertar mais de 3 peixes por negociação.' };
  }
  if (offerBIds.length > 3) {
    return { valid: false, error: 'Jogador B não pode ofertar mais de 3 peixes por negociação.' };
  }

  // 2. Verificar se os itens ofertados existem nos inventários
  const setA = new Set(inventoryA.map((i) => i.id));
  for (const id of offerAIds) {
    if (!setA.has(id)) {
      return { valid: false, error: 'Um ou mais peixes ofertados pelo Jogador A não estão em seu inventário.' };
    }
  }

  const setB = new Set(inventoryB.map((i) => i.id));
  for (const id of offerBIds) {
    if (!setB.has(id)) {
      return { valid: false, error: 'Um ou mais peixes ofertados pelo Jogador B não estão em seu inventário.' };
    }
  }

  // 3. Verificar capacidades pós-troca
  // Capacidade final de A = len(A) - oferecidos(A) + recebidos(B)
  const finalCountA = inventoryA.length - offerAIds.length + offerBIds.length;
  if (finalCountA > maxCapacity) {
    return {
      valid: false,
      error: `Jogador A excederá o limite da mochila (${finalCountA}/${maxCapacity}). Libere espaço antes de concluir!`,
    };
  }

  const finalCountB = inventoryB.length - offerBIds.length + offerAIds.length;
  if (finalCountB > maxCapacity) {
    return {
      valid: false,
      error: `Jogador B excederá o limite da mochila (${finalCountB}/${maxCapacity}). Libere espaço antes de concluir!`,
    };
  }

  return { valid: true };
}
