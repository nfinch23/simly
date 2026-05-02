import type { BestFlaskResult } from '@simly/shared';
import type { SimcRunResult } from '../simc-runner';
import {
  buildProfilesetLines,
  matchProfilesetsByPrefix,
  roundTo,
  type Scan,
} from './index';

interface FlaskCandidate {
  key: string;
  item_id: number;
  name: string;
  simcFlask: string;
}

// Patch 12.0.5 (Midnight) DPS flasks, sourced from simc.exe stock profiles
// under simc-1205.01.../profiles/MID1/. item_ids are placeholders (0)
// pending a per-patch data regeneration pass — they're only required by
// the Phase 3 tooltip hook, not by the DPS comparison itself. Phase 4
// will load this list from data/ regenerated per patch.
export const FLASK_CANDIDATES: readonly FlaskCandidate[] = [
  {
    key: 'blood_knights',
    item_id: 0,
    name: 'Flask of the Blood Knights',
    simcFlask: 'flask_of_the_blood_knights_2',
  },
  {
    key: 'magisters',
    item_id: 0,
    name: 'Flask of the Magisters',
    simcFlask: 'flask_of_the_magisters_2',
  },
  {
    key: 'shattered_sun',
    item_id: 0,
    name: 'Flask of the Shattered Sun',
    simcFlask: 'flask_of_the_shattered_sun_2',
  },
];

const PREFIX = 'flask';

export function buildFlaskProfilesetLines(): string {
  return buildProfilesetLines(
    PREFIX,
    FLASK_CANDIDATES.map((c) => ({
      key: c.key,
      simcLine: `flask=${c.simcFlask}`,
    })),
  );
}

export function parseBestFlask(run: SimcRunResult): BestFlaskResult | undefined {
  const matched = matchProfilesetsByPrefix(run, PREFIX, FLASK_CANDIDATES);
  if (matched.length === 0) return undefined;

  matched.sort((a, b) => b.mean - a.mean);
  const winner = matched[0]!;
  const winnerDps = winner.mean;

  return {
    label: 'Best flask',
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

export const bestFlaskScan: Scan<BestFlaskResult> = {
  id: 'best_flask',
  profilesetPrefix: PREFIX,
  buildLines: buildFlaskProfilesetLines,
  parseResult: parseBestFlask,
};
