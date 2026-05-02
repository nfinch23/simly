import type { StatWeights } from '@simly/shared';
import { runSimc, type RunnerPaths, type SimcRunResult } from '../simc-runner';

/**
 * Stats SimC will compute scale factors for. We deliberately ask for
 * `intellect,strength,agility` so the same script works regardless of
 * spec — SimC ignores stats that don't apply to the active class. Crit /
 * haste / mastery / versatility are universal.
 */
export const SCALE_FACTOR_STATS = [
  'intellect',
  'strength',
  'agility',
  'crit',
  'haste',
  'mastery',
  'versatility',
] as const;

/**
 * Map SimC's JSON keys (capitalized abbreviations) to our canonical
 * lowercase stat names. SimC emits "Int" / "Str" / "Agi" / "Crit" /
 * "Haste" / "Mastery" / "Vers" in `sim.players[0].scale_factors`.
 */
const SIMC_KEY_TO_CANONICAL: Record<string, string> = {
  Int: 'intellect',
  Str: 'strength',
  Agi: 'agility',
  Crit: 'crit',
  Haste: 'haste',
  Mastery: 'mastery',
  Vers: 'versatility',
  // Some SimC builds also emit secondary aliases — no-op safe to leave.
  SP: 'spell_power',
  AP: 'attack_power',
};

export interface RunStatWeightsOptions {
  paths: RunnerPaths;
  /** Real character profile string (warlock="..." level=... etc). */
  baseProfile: string;
  /** Iterations for the scale-factor sim. Stat weights converge fast — 300 is plenty for v1. */
  iterations?: number;
}

export interface StatWeightsRunResult {
  weights: StatWeights;
  simcVersion: string;
  gitRevision: string;
  durationMs: number;
}

/**
 * Run a single SimC invocation in scale-factor mode and return the
 * canonical-keyed weights. This is a separate run from the consumables
 * profileset sim (different SimC mode), so it costs an extra subprocess
 * invocation per "Update sims" cycle. Stat weights converge in ~3-5s
 * with 300 iterations on a real character — cheap.
 */
export async function runStatWeightsScan(
  opts: RunStatWeightsOptions,
): Promise<StatWeightsRunResult> {
  const iterations = opts.iterations ?? 300;
  const t0 = Date.now();

  const profileScript = [
    opts.baseProfile.trim(),
    '',
    'calculate_scale_factors=1',
    `scale_only=${SCALE_FACTOR_STATS.join(',')}`,
  ].join('\n');

  const run = await runSimc({
    paths: opts.paths,
    profileScript,
    iterations,
    scratchTag: `stat-weights-${Date.now()}`,
  });

  return {
    weights: extractStatWeights(run),
    simcVersion: run.simcVersion,
    gitRevision: run.gitRevision,
    durationMs: Date.now() - t0,
  };
}

/**
 * Pull `scale_factors` out of `sim.players[0]`, normalize keys, and
 * drop any stat that came back as 0 / NaN (SimC emits 0 for irrelevant
 * stats — e.g., Strength on a warlock).
 */
export function extractStatWeights(run: SimcRunResult): StatWeights {
  const root = run.rawJson as
    | {
        sim?: {
          players?: Array<{ scale_factors?: Record<string, number> }>;
        };
      }
    | undefined;
  const raw = root?.sim?.players?.[0]?.scale_factors ?? {};
  const out: StatWeights = {};
  for (const [simcKey, value] of Object.entries(raw)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) continue;
    const canonical = SIMC_KEY_TO_CANONICAL[simcKey] ?? simcKey.toLowerCase();
    out[canonical] = value;
  }
  return out;
}
