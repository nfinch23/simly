import type { BestPotionResult } from '@simly/shared';
import type { SimcRunResult } from '../simc-runner';
import {
  buildProfilesetLines,
  matchProfilesetsByPrefix,
  roundTo,
  type Scan,
} from './index';

export interface PotionCandidate {
  key: string;
  item_id: number;
  name: string;
  simcPotion: string;
}

// Patch 12.0.5 (Midnight) combat potions, sourced from
// simc-1205.01.../profiles/MID1/*.simc. SimC's stock per-spec profiles
// pick one of these three:
//   - potion_of_recklessness_2   — melee/physical DPS + caster Mage Frost
//   - lights_potential_2         — most caster DPS (Druid Balance, Evoker,
//                                  Mage Arcane/Fire, Priest, Shaman Ele,
//                                  Warlock, etc.)
//   - draught_of_rampant_abandon_2 — tanks (Blood DK, Brewmaster, etc.)
// We sim all three per character so the runner picks the right one
// instead of relying on the per-spec default. item_ids are placeholders
// pending a per-patch data regen pass — they're only needed for the
// addon's tooltip render.
export const POTION_CANDIDATES: readonly PotionCandidate[] = [
  {
    key: 'recklessness',
    item_id: 0,
    name: 'Potion of Recklessness',
    simcPotion: 'potion_of_recklessness_2',
  },
  {
    key: 'lights_potential',
    item_id: 0,
    name: "Light's Potential Potion",
    simcPotion: 'lights_potential_2',
  },
  {
    key: 'draught_rampant_abandon',
    item_id: 0,
    name: 'Draught of Rampant Abandon',
    simcPotion: 'draught_of_rampant_abandon_2',
  },
];

const PREFIX = 'potion';

export function buildPotionProfilesetLines(): string {
  return buildProfilesetLines(
    PREFIX,
    POTION_CANDIDATES.map((c) => ({
      key: c.key,
      simcLine: `potion=${c.simcPotion}`,
    })),
  );
}

/**
 * Pick the winning potion's SimC key from a SimC run that included the
 * potion profilesets. Returns undefined when no potion profileset was
 * found — caller falls back to the default in raid-buffs.ts.
 */
export function pickWinningPotionSimcKey(run: SimcRunResult): string | undefined {
  const matched = matchProfilesetsByPrefix(run, PREFIX, POTION_CANDIDATES);
  if (matched.length === 0) return undefined;
  matched.sort((a, b) => b.mean - a.mean);
  return matched[0]!.candidate.simcPotion;
}

export function parseBestPotion(run: SimcRunResult): BestPotionResult | undefined {
  const matched = matchProfilesetsByPrefix(run, PREFIX, POTION_CANDIDATES);
  if (matched.length === 0) return undefined;

  matched.sort((a, b) => b.mean - a.mean);
  const winner = matched[0]!;
  const winnerDps = winner.mean;

  return {
    label: 'Best combat potion',
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

export const bestPotionScan: Scan<BestPotionResult> = {
  id: 'best_potion',
  profilesetPrefix: PREFIX,
  buildLines: buildPotionProfilesetLines,
  parseResult: parseBestPotion,
};
