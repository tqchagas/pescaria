import { FishInstance, FishSpecies, RarityConfig } from '../shared/types.js';
import { FISH_SPECIES_CATALOG, RARITY_CONFIGS } from '../shared/fishData.js';

/**
 * Gera um elemento SVG estilizado e detalhado para uma espécie de peixe
 */
export function renderFishSVG(species: FishSpecies, width: number = 180, height: number = 110): string {
  const { baseColor, accentColor, finColor, rarity, bodyLengthRatio } = species;
  const cfg = RARITY_CONFIGS[rarity];

  // Ajustes de proporção com base no corpo da espécie
  const scaleX = bodyLengthRatio || 1.0;
  const glowFilter = rarity >= 4 ? `filter="url(#glow-${species.id})"` : '';

  return `
    <svg width="${width}" height="${height}" viewBox="0 0 200 120" xmlns="http://www.w3.org/2000/svg" class="fish-svg-art">
      <defs>
        <radialGradient id="grad-body-${species.id}" cx="40%" cy="40%" r="60%">
          <stop offset="0%" stop-color="${accentColor}" />
          <stop offset="60%" stop-color="${baseColor}" />
          <stop offset="100%" stop-color="#0f172a" />
        </radialGradient>

        <linearGradient id="grad-fin-${species.id}" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${finColor}" />
          <stop offset="100%" stop-color="${baseColor}" />
        </linearGradient>

        ${
          rarity >= 4
            ? `<filter id="glow-${species.id}" x="-30%" y="-30%" width="160%" height="160%">
                <feGaussianBlur stdDeviation="6" result="blur" />
                <feComposite in="SourceGraphic" in2="blur" operator="over" />
              </filter>`
            : ''
        }
      </defs>

      <g transform="translate(100, 60)" ${glowFilter}>
        <!-- Barbatana Dorsal Superior -->
        <path d="M -15,-28 Q 15,-48 35,-24 L 20,-20 Z" fill="url(#grad-fin-${species.id})" opacity="0.9" />

        <!-- Barbatana Ventral / Peitoral Inferior -->
        <path d="M -10,24 Q 5,42 22,26 L 10,20 Z" fill="url(#grad-fin-${species.id})" opacity="0.85" />

        <!-- Cauda / Barbatana Traseira com ondulações -->
        <path d="M 45,0 Q 80,-36 90,-25 Q 75,0 90,25 Q 80,36 45,0 Z" fill="url(#grad-fin-${species.id})" />

        <!-- Corpo Principal Estilizado -->
        <ellipse cx="0" cy="0" rx="${60 * scaleX}" ry="28" fill="url(#grad-body-${species.id})" />

        <!-- Escamas e Detalhes de Textura -->
        <path d="M -15,-10 Q 0,-5 -15,0 Q 0,5 -15,10" stroke="${accentColor}" stroke-width="2" fill="none" opacity="0.45" />
        <path d="M 5,-12 Q 20,-6 5,0 Q 20,6 5,12" stroke="${accentColor}" stroke-width="2" fill="none" opacity="0.45" />
        <path d="M 25,-8 Q 38,-4 25,0 Q 38,4 25,8" stroke="${accentColor}" stroke-width="1.8" fill="none" opacity="0.4" />

        <!-- Barbatana Peitoral Lateral -->
        <path d="M -15,2 Q -5,16 10,6 Q 0,-2 -15,2 Z" fill="${finColor}" opacity="0.8" />

        <!-- Olho Expressivo -->
        <circle cx="${-42 * scaleX}" cy="-6" r="7" fill="#ffffff" />
        <circle cx="${-44 * scaleX}" cy="-6" r="4.2" fill="#09090b" />
        <circle cx="${-45 * scaleX}" cy="-7.5" r="1.5" fill="#ffffff" />

        <!-- Brilho na cabeça -->
        <path d="M ${-50 * scaleX},-2 Q ${-45 * scaleX},-18 ${-20 * scaleX},-20" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round" fill="none" opacity="0.5" />
      </g>
    </svg>
  `;
}
