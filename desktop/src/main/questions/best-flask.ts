import type { BestFlaskResult } from '@simly/shared';
import type { SimcRunResult } from '../simc-runner';
import {
  buildProfilesetLines,
  matchProfilesetsByPrefix,
  roundTo,
  type Question,
} from './index';

interface FlaskCandidate {
  key: string;
  item_id: number;
  name: string;
  simcFlask: string;
}

// Minimal patch-12.0.5 candidate list. Phase 4 will load this from a data
// file regenerated per patch (see SCOPE.md section 6 phase 4 + section 9).
export const FLASK_CANDIDATES: readonly FlaskCandidate[] = [
  {
    key: 'tepid_versatility',
    item_id: 212265,
    name: 'Phial of Tepid Versatility',
    simcFlask: 'phial_of_tepid_versatility',
  },
  {
    key: 'elemental_chaos',
    item_id: 212266,
    name: 'Phial of Elemental Chaos',
    simcFlask: 'phial_of_elemental_chaos',
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

export const bestFlaskQuestion: Question<BestFlaskResult> = {
  id: 'best_flask',
  profilesetPrefix: PREFIX,
  buildLines: buildFlaskProfilesetLines,
  parseResult: parseBestFlask,
};
