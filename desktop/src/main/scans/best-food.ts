import type { BestFoodResult } from '@simly/shared';
import type { SimcRunResult } from '../simc-runner';
import {
  buildProfilesetLines,
  matchProfilesetsByPrefix,
  roundTo,
  type Scan,
} from './index';

export interface FoodCandidate {
  key: string;
  item_id: number;
  name: string;
  simcFood: string;
}

// Patch 12.0.5 (Midnight) feasts, sourced from simc.exe stock profiles
// under simc-1205.01.../profiles/MID1/. item_ids are placeholders (0)
// pending a per-patch data regeneration pass — they're only required
// by the Phase 3 tooltip hook, not by the DPS comparison itself.
export const FOOD_CANDIDATES: readonly FoodCandidate[] = [
  {
    key: 'blooming_feast',
    item_id: 0,
    name: 'Blooming Feast',
    simcFood: 'blooming_feast',
  },
  {
    key: 'harandar_celebration',
    item_id: 0,
    name: "Har'andar Celebration",
    simcFood: 'harandar_celebration',
  },
  {
    key: 'queldorei_medley',
    item_id: 0,
    name: "Quel'dorei Medley",
    simcFood: 'queldorei_medley',
  },
  {
    key: 'royal_roast',
    item_id: 0,
    name: 'Royal Roast',
    simcFood: 'royal_roast',
  },
  {
    key: 'silvermoon_parade',
    item_id: 0,
    name: 'Silvermoon Parade',
    simcFood: 'silvermoon_parade',
  },
];

const PREFIX = 'food';

export function buildFoodProfilesetLines(): string {
  return buildProfilesetLines(
    PREFIX,
    FOOD_CANDIDATES.map((c) => ({
      key: c.key,
      simcLine: `food=${c.simcFood}`,
    })),
  );
}

/**
 * Pick the winning food's SimC key (e.g. `silvermoon_parade`) from a
 * SimC run that included the food profilesets. See `pickWinningFlaskSimcKey`
 * for the motivation — symmetric helper for food.
 */
export function pickWinningFoodSimcKey(run: SimcRunResult): string | undefined {
  const matched = matchProfilesetsByPrefix(run, PREFIX, FOOD_CANDIDATES);
  if (matched.length === 0) return undefined;
  matched.sort((a, b) => b.mean - a.mean);
  return matched[0]!.candidate.simcFood;
}

export function parseBestFood(run: SimcRunResult): BestFoodResult | undefined {
  const matched = matchProfilesetsByPrefix(run, PREFIX, FOOD_CANDIDATES);
  if (matched.length === 0) return undefined;

  matched.sort((a, b) => b.mean - a.mean);
  const winner = matched[0]!;
  const winnerDps = winner.mean;

  return {
    label: 'Best food',
    best: {
      item_id: winner.candidate.item_id,
      name: winner.candidate.name,
      dps: Math.round(winnerDps),
    },
    alternatives: matched.slice(1).map((m) => ({
      item_id: m.candidate.item_id,
      name: m.candidate.name,
      dps: Math.round(m.mean),
      delta_pct: roundTo(((m.mean - winnerDps) / winnerDps) * 100, 2),
    })),
  };
}

export const bestFoodScan: Scan<BestFoodResult> = {
  id: 'best_food',
  profilesetPrefix: PREFIX,
  buildLines: buildFoodProfilesetLines,
  parseResult: parseBestFood,
};
