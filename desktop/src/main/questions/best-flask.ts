import type { BestFlaskResult } from '@simly/shared';
import type { SimcRunResult } from '../simc-runner';

function roundTo(n: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

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

export function buildFlaskProfilesetLines(): string {
  return FLASK_CANDIDATES.map(
    (c) => `profileset."flask_${c.key}"+="flask=${c.simcFlask}"`,
  ).join('\n');
}

export function parseBestFlask(run: SimcRunResult): BestFlaskResult | undefined {
  const byKey = new Map(FLASK_CANDIDATES.map((c) => [`flask_${c.key}`, c]));
  const matched = run.profilesets
    .map((p) => ({ profileset: p, candidate: byKey.get(p.name) }))
    .filter((m): m is { profileset: typeof run.profilesets[number]; candidate: FlaskCandidate } => !!m.candidate);

  if (matched.length === 0) return undefined;

  matched.sort((a, b) => b.profileset.mean - a.profileset.mean);
  const winner = matched[0]!;
  const winnerDps = winner.profileset.mean;

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
      dps: Math.round(m.profileset.mean),
      delta_pct: roundTo(((m.profileset.mean - winnerDps) / winnerDps) * 100, 2),
    })),
  };
}
