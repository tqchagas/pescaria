import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  rollRarity,
  pickSpecies,
  calculateWeight,
  generateCatch,
  validateTradeCapacity,
  formatWeight,
  Mulberry32PRNG,
} from '../src/shared/fishingEngine.js';
import { FISH_SPECIES_CATALOG, RARITY_CONFIGS } from '../src/shared/fishData.js';
import { FishInstance } from '../src/shared/types.js';

describe('Fishing Engine Tests', () => {
  test('Rarity roll distribution matches defined probabilities within statistical tolerance', () => {
    const totalRolls = 100000;
    const counts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
    const prng = new Mulberry32PRNG(42);

    for (let i = 0; i < totalRolls; i++) {
      const roll = prng.next();
      const rarity = rollRarity(roll);
      counts[rarity]++;
    }

    const p1 = counts[1] / totalRolls;
    const p2 = counts[2] / totalRolls;
    const p3 = counts[3] / totalRolls;
    const p4 = counts[4] / totalRolls;
    const p5 = counts[5] / totalRolls;
    const p6 = counts[6] / totalRolls;

    // Verificar se as probabilidades batem com tolerância de ±1%
    assert.ok(Math.abs(p1 - 0.40) < 0.01, `Nível 1 esperado ~0.40, obtido ${p1}`);
    assert.ok(Math.abs(p2 - 0.25) < 0.01, `Nível 2 esperado ~0.25, obtido ${p2}`);
    assert.ok(Math.abs(p3 - 0.18) < 0.01, `Nível 3 esperado ~0.18, obtido ${p3}`);
    assert.ok(Math.abs(p4 - 0.10) < 0.01, `Nível 4 esperado ~0.10, obtido ${p4}`);
    assert.ok(Math.abs(p5 - 0.05) < 0.01, `Nível 5 esperado ~0.05, obtido ${p5}`);
    assert.ok(Math.abs(p6 - 0.02) < 0.01, `Nível 6 esperado ~0.02, obtido ${p6}`);
  });

  test('All species weights are strictly within their minWeight and maxWeight bounds', () => {
    const prng = new Mulberry32PRNG(999);

    for (const species of FISH_SPECIES_CATALOG) {
      for (let i = 0; i < 500; i++) {
        const { weight } = calculateWeight(species, prng.next(), prng.next());
        assert.ok(
          weight >= species.minWeight,
          `Peixe ${species.name} com peso ${weight} abaixo do mínimo ${species.minWeight}`
        );
        assert.ok(
          weight <= species.maxWeight,
          `Peixe ${species.name} com peso ${weight} acima do máximo ${species.maxWeight}`
        );
      }
    }
  });

  test('Deterministic seed produces identical catch outcomes', () => {
    const catchA = generateCatch({ seed: 12345 });
    const catchB = generateCatch({ seed: 12345 });

    assert.strictEqual(catchA.species.id, catchB.species.id);
    assert.strictEqual(catchA.fish.weight, catchB.fish.weight);
    assert.strictEqual(catchA.fish.rarity, catchB.fish.rarity);
  });

  test('Format weight returns correct human-readable units', () => {
    assert.strictEqual(formatWeight(150), '150 g');
    assert.strictEqual(formatWeight(999), '999 g');
    assert.strictEqual(formatWeight(1000), '1.00 kg');
    assert.strictEqual(formatWeight(4520), '4.52 kg');
    assert.strictEqual(formatWeight(38500), '38.50 kg');
  });

  test('Trade capacity validator prevents overflow and detects fraud', () => {
    const dummyFish = (id: string): FishInstance => ({
      id,
      speciesId: 'lambari',
      name: 'Lambari',
      rarity: 1,
      weight: 100,
      formattedWeight: '100 g',
      caughtAt: new Date().toISOString(),
    });

    // Cenário 1: Jogador B ficaria com 21 peixes (limite 20)
    // Inv A tem 1 peixe, oferta 1
    // Inv B tem 20 peixes, oferta 0 -> B receberia 1 e ficaria com 21
    const invA = [dummyFish('a1')];
    const invB = Array.from({ length: 20 }, (_, i) => dummyFish(`b${i}`));

    const resultOverflow = validateTradeCapacity(invA, invB, ['a1'], [], 20);
    assert.strictEqual(resultOverflow.valid, false);
    assert.ok(resultOverflow.error?.includes('Jogador B excederá o limite'));

    // Cenário 2: Troca equilibrada 1 por 1
    const invB19 = Array.from({ length: 19 }, (_, i) => dummyFish(`b${i}`));
    const resultOk = validateTradeCapacity(invA, invB19, ['a1'], ['b0'], 20);
    assert.strictEqual(resultOk.valid, true);

    // Cenário 3: Jogador tenta ofertar item que não possui
    const resultFraud = validateTradeCapacity(invA, invB19, ['hacker_item_id'], ['b0'], 20);
    assert.strictEqual(resultFraud.valid, false);
    assert.ok(resultFraud.error?.includes('não estão em seu inventário'));

    // Cenário 4: Mais de 3 itens ofertados
    const invA4 = [dummyFish('1'), dummyFish('2'), dummyFish('3'), dummyFish('4')];
    const resultTooMany = validateTradeCapacity(invA4, invB19, ['1', '2', '3', '4'], ['b0'], 20);
    assert.strictEqual(resultTooMany.valid, false);
    assert.ok(resultTooMany.error?.includes('mais de 3 peixes'));
  });

  test('Trophy size labels map correctly across score ranges', async () => {
    const { getTrophySizeLabel } = await import('../src/shared/fishingEngine.js');
    assert.strictEqual(getTrophySizeLabel(10), 'Pequeno');
    assert.strictEqual(getTrophySizeLabel(40), 'Médio');
    assert.strictEqual(getTrophySizeLabel(70), 'Grande');
    assert.strictEqual(getTrophySizeLabel(88), 'Gigante');
    assert.strictEqual(getTrophySizeLabel(99), 'Troféu Lendário');
  });

  test('generateWhatsAppShareText formats output accurately with emojis, stars and metrics', async () => {
    const { generateWhatsAppShareText } = await import('../src/shared/fishingEngine.js');

    const sampleFish: FishInstance = {
      id: 'x0ogd9cni6-test-uuid',
      speciesId: 'tilapia',
      name: 'Tilápia',
      rarity: 2,
      weight: 1150,
      formattedWeight: '1.15 kg',
      caughtAt: new Date().toISOString(),
    };

    const text = generateWhatsAppShareText({
      fish: sampleFish,
      rarityConfig: { label: 'Comum', stars: '★★☆☆☆☆' },
      trophySizeLabel: 'Grande',
      isNewDiscovery: true,
      isNewRecord: true,
      environment: {
        location: 'Lago Cristalino 🏝️',
        weather: '⛈️ Tempestade',
        period: 'Manhã',
      },
      catchesToday: 15,
      currentInventoryCount: 15,
      maxCapacity: 20,
      uniqueSpeciesDiscovered: 7,
      totalSpecies: 12,
      streakDays: 4,
      gameUrl: 'https://pescaria2d.app',
    });

    assert.ok(text.includes('🐟 *Tilápia*'));
    assert.ok(text.includes('🎖️ Comum — ★★☆☆☆☆'));
    assert.ok(text.includes('⚖️ 1.15 kg'));
    assert.ok(text.includes('🫧 Tamanho: Grande'));
    assert.ok(text.includes('🆔 X0OGD9CNI6'));
    assert.ok(text.includes('🆕 *NOVA DESCOBERTA NO ÁLBUM!*'));
    assert.ok(text.includes('🏆 *Novo recorde pessoal desta espécie!*'));
    assert.ok(text.includes('📍 Lago Cristalino 🏝️ | ⛈️ Tempestade'));
    assert.ok(text.includes('🌅 Período: Manhã'));
    assert.ok(text.includes('🎣 Hoje: 15 fisgado(s)'));
    assert.ok(text.includes('📦 Mochila: 15/20'));
    assert.ok(text.includes('📗 Espécies no Álbum: 7/12'));
    assert.ok(text.includes('🔥 Streak: 4 dia(s) — nível Prata 🥈'));
    assert.ok(text.includes('🎯 Missão: completa ✅'));
    assert.ok(text.includes('https://pescaria2d.app'));
  });
});
