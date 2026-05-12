/**
 * Pass-2 trigger gate for the two-pass stat-reconverge pipeline.
 *
 * After pass 1 (stat-weights → consumables prescan → trinket prescan →
 * gear search), the orchestrator re-runs stat-weights and consumables
 * against the new gear, then asks this module: "should we run pass 2?"
 *
 * Three independent triggers; ANY of them fires pass 2:
 *   - WEIGHTS: any secondary stat's marginal value shifted past
 *     WEIGHT_SHIFT_THRESHOLD between v1 and v2. Indicates the actor
 *     crossed a structural threshold (classic case: GCD floor) and the
 *     gear search's pre-filter / pruner predictions were stale.
 *   - CONSUMABLES: the post-gear consumables scan picked a different
 *     flask or food than the baseline prescan locked. Different gear
 *     wants different consumables — the locked-in pass-1 sim may have
 *     been against the wrong consumable context.
 *   - TRINKET: the stat-vector prediction (computed elsewhere by the
 *     caller; passed in as a boolean) says a different trinket pair
 *     would now win. We trust the prediction enough to retrigger the
 *     full trinket prescan against the new gear.
 *
 * Missing-data fallback: if any required input is missing (e.g., the
 * stat-weights re-run failed for some reason), the corresponding
 * trigger silently does not fire. The gate never crashes the pipeline
 * — pass 1's result is always a valid final answer.
 *
 * Pure module. All inputs are primitives or simple shapes; no I/O, no
 * SimC, no electron-store. Fully unit-testable.
 */

import type { StatWeights } from '@simly/shared';

/**
 * Threshold for the WEIGHTS trigger. Any secondary stat whose marginal
 * value changes by more than this fraction between v1 and v2 fires the
 * trigger.
 *
 * 0.25 chosen as the conservative "something material shifted" floor.
 * GCD-floor crossings typically halve or double a stat's marginal
 * value, so a 25% gate catches breakpoint transitions while ignoring
 * sim-noise jitter (typically <10% on 1000-iter scale-factor sims).
 */
export const WEIGHT_SHIFT_THRESHOLD = 0.25;

/**
 * Tolerance for the WEIGHTS_RANK trigger. Two stats are considered
 * "clearly separated" in a given pass when their ratio exceeds
 * 1 + this value (i.e., the dominant one is at least 10% bigger).
 *
 * A rank FLIP is recorded when stats A and B were clearly separated
 * in v1 with A > B, AND in v2 are clearly separated with B > A.
 * Ties (stats within the tolerance) on either side do not count as
 * flips — that catches sim-noise jitter without false-firing on
 * stats that have always been roughly equivalent.
 *
 * 0.10 chosen because 1000-iter scale-factor sims show typical noise
 * of ~5% per-stat; 10% is comfortably outside that envelope.
 *
 * Real-world signal this catches: a "soft" breakpoint. Mastery
 * dominates pre-converge; the converged gear pushes haste over a
 * GCD floor and haste now dominates. Individual magnitudes might
 * not change >25% (the WEIGHTS threshold), but the *priority order*
 * for future gear decisions clearly has.
 */
export const RANK_FLIP_TOLERANCE = 0.10;

/**
 * Stats that count for the WEIGHTS trigger. Primary stats (intellect /
 * strength / agility) deliberately excluded — their marginal value is
 * dominated by ilvl scaling, not actor state, so a primary-stat weight
 * shift means the sim is broken, not that we crossed a threshold.
 */
export const TRIGGERED_STATS = [
  'crit',
  'haste',
  'mastery',
  'versatility',
] as const;

export type TriggeredStat = (typeof TRIGGERED_STATS)[number];

export type ReconvergeReason =
  | {
      kind: 'weights';
      stat: TriggeredStat;
      v1: number;
      v2: number;
      /** v2 / v1 ratio; the trigger fires when |ratio - 1| > threshold. */
      ratio: number;
    }
  | {
      kind: 'weights_rank';
      /** The two stats that swapped dominance. */
      stat_a: TriggeredStat;
      stat_b: TriggeredStat;
      /** Ratio stat_a / stat_b in pass v1 (always > 1 by construction). */
      v1_ratio: number;
      /** Ratio stat_b / stat_a in pass v2 (always > 1 by construction). */
      v2_ratio: number;
    }
  | {
      kind: 'consumables';
      consumable: 'flask' | 'food';
      v1_item_id: number | undefined;
      v2_item_id: number | undefined;
    }
  | {
      kind: 'trinket';
    };

/**
 * Detect every pair of secondary stats that clearly swapped dominance
 * between v1 and v2. A "clear" swap requires both versions to separate
 * the pair by more than RANK_FLIP_TOLERANCE — pairs that were within
 * tolerance in either version are skipped (they were already tied,
 * not flipped).
 *
 * Pairs are returned in a stable order (the pair where stat_a appears
 * earlier in TRIGGERED_STATS comes first) so the diagnostic output is
 * deterministic across runs.
 */
export function detectRankFlips(
  weights_v1: Readonly<Record<string, number | undefined>>,
  weights_v2: Readonly<Record<string, number | undefined>>,
  tolerance: number = RANK_FLIP_TOLERANCE,
): Array<{
  stat_a: TriggeredStat;
  stat_b: TriggeredStat;
  v1_ratio: number;
  v2_ratio: number;
}> {
  const flips: Array<{
    stat_a: TriggeredStat;
    stat_b: TriggeredStat;
    v1_ratio: number;
    v2_ratio: number;
  }> = [];

  for (let i = 0; i < TRIGGERED_STATS.length; i++) {
    for (let j = i + 1; j < TRIGGERED_STATS.length; j++) {
      const a = TRIGGERED_STATS[i]!;
      const b = TRIGGERED_STATS[j]!;
      const a_v1 = weights_v1[a];
      const b_v1 = weights_v1[b];
      const a_v2 = weights_v2[a];
      const b_v2 = weights_v2[b];
      if (
        a_v1 === undefined ||
        b_v1 === undefined ||
        a_v2 === undefined ||
        b_v2 === undefined
      ) {
        continue;
      }
      if (a_v1 <= 0 || b_v1 <= 0 || a_v2 <= 0 || b_v2 <= 0) continue;

      const v1_ratio_ab = a_v1 / b_v1; // > 1 ⇒ A dominates in v1
      const v2_ratio_ab = a_v2 / b_v2; // > 1 ⇒ A still dominates in v2

      // A clearly dominated B in v1 (>= 1 + tolerance), and B clearly
      // dominates A in v2.
      if (v1_ratio_ab > 1 + tolerance && v2_ratio_ab < 1 / (1 + tolerance)) {
        flips.push({
          stat_a: a,
          stat_b: b,
          v1_ratio: v1_ratio_ab,
          v2_ratio: b_v2 / a_v2,
        });
        continue;
      }
      // B clearly dominated A in v1, and A clearly dominates B in v2.
      if (v1_ratio_ab < 1 / (1 + tolerance) && v2_ratio_ab > 1 + tolerance) {
        flips.push({
          stat_a: b,
          stat_b: a,
          v1_ratio: b_v1 / a_v1,
          v2_ratio: v2_ratio_ab,
        });
        continue;
      }
    }
  }

  return flips;
}

/**
 * Compute per-stat v2/v1 ratios for every secondary stat present in
 * both weight maps with non-zero v1. Used to write `weight_deltas`
 * into pass_history regardless of whether any trigger fired —
 * gives the addon panel + future devex tools a visible record of how
 * much actor state shifted on each pass.
 *
 * Stats missing from either side or with zero v1 are omitted from
 * the output (avoids divide-by-zero and noise from spec-irrelevant
 * stats).
 */
export function computeWeightDeltas(
  weights_v1: Readonly<Record<string, number | undefined>>,
  weights_v2: Readonly<Record<string, number | undefined>>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const stat of TRIGGERED_STATS) {
    const v1 = weights_v1[stat];
    const v2 = weights_v2[stat];
    if (v1 === undefined || v2 === undefined) continue;
    if (v1 === 0) continue;
    out[stat] = v2 / v1;
  }
  return out;
}

export interface ReconvergeGateInput {
  /** Stat weights from the initial pre-gear-search scale-factor sim. */
  weights_v1?: StatWeights;
  /** Stat weights re-run against the gear that pass 1 converged on. */
  weights_v2?: StatWeights;
  /** Item id of the flask the baseline prescan locked in. Undefined if no flask scan ran. */
  flask_v1_item_id?: number;
  /** Item id of the flask the post-gear re-eval picked. Undefined if no flask re-eval ran. */
  flask_v2_item_id?: number;
  food_v1_item_id?: number;
  food_v2_item_id?: number;
  /**
   * Pre-computed result of "does stat-vector × new-actor-stats predict
   * a different trinket pair than the locked pair?" The caller owns
   * the math (it has the trinket pool + the v2 weights + the new gear
   * stat totals); this module just consumes the boolean.
   */
  trinket_flip_predicted?: boolean;
}

export interface ReconvergeGateResult {
  /** True if any reason fired. The orchestrator dispatches pass 2 when true. */
  shouldTrigger: boolean;
  /** All reasons that fired; the orchestrator logs these for diagnostics. */
  reasons: ReconvergeReason[];
}

/**
 * Compute pass-2 trigger decision and reasons. See module docstring for
 * the three-trigger contract.
 *
 * Calling convention: the orchestrator builds the input object after
 * the end-of-pass-1 diagnostics complete, hands it here, and either
 * dispatches pass 2 (if shouldTrigger) or skips to the composer.
 */
export function shouldTriggerPass2(
  input: ReconvergeGateInput,
): ReconvergeGateResult {
  const reasons: ReconvergeReason[] = [];

  // --- Trigger A: stat-weights magnitude shift past threshold on any
  // secondary. Catches "hard" breakpoints — a stat's marginal value
  // halved/doubled.
  if (input.weights_v1 && input.weights_v2) {
    for (const stat of TRIGGERED_STATS) {
      const v1 = input.weights_v1[stat];
      const v2 = input.weights_v2[stat];
      // Both values must be present AND v1 must be non-zero to compute
      // a meaningful ratio. Skip stats the sim didn't measure or that
      // are structurally zero for this spec.
      if (v1 === undefined || v2 === undefined) continue;
      if (v1 === 0) continue;
      const ratio = v2 / v1;
      if (Math.abs(ratio - 1) > WEIGHT_SHIFT_THRESHOLD) {
        reasons.push({ kind: 'weights', stat, v1, v2, ratio });
      }
    }

    // --- Trigger A2: WEIGHTS_RANK. Even if no single stat shifted past
    // the magnitude threshold, a "soft" breakpoint can flip the
    // PRIORITY ORDER of secondaries (e.g., crit > haste in v1, haste >
    // crit in v2). That's a strong signal future gear decisions will
    // disagree with pass-1's pick, so re-search is warranted.
    const flips = detectRankFlips(input.weights_v1, input.weights_v2);
    for (const flip of flips) {
      reasons.push({ kind: 'weights_rank', ...flip });
    }
  }

  // --- Trigger B: flask or food winner flipped.
  // Discrete picks → any change fires, no threshold. Both endpoints
  // must have been measured (item_id present on both sides) for a
  // change to count as a flip.
  if (
    input.flask_v1_item_id !== undefined &&
    input.flask_v2_item_id !== undefined &&
    input.flask_v1_item_id !== input.flask_v2_item_id
  ) {
    reasons.push({
      kind: 'consumables',
      consumable: 'flask',
      v1_item_id: input.flask_v1_item_id,
      v2_item_id: input.flask_v2_item_id,
    });
  }
  if (
    input.food_v1_item_id !== undefined &&
    input.food_v2_item_id !== undefined &&
    input.food_v1_item_id !== input.food_v2_item_id
  ) {
    reasons.push({
      kind: 'consumables',
      consumable: 'food',
      v1_item_id: input.food_v1_item_id,
      v2_item_id: input.food_v2_item_id,
    });
  }

  // --- Trigger C: trinket stat-vector flip.
  if (input.trinket_flip_predicted === true) {
    reasons.push({ kind: 'trinket' });
  }

  return {
    shouldTrigger: reasons.length > 0,
    reasons,
  };
}

/**
 * Format a reason for the diagnostic log. Used by the orchestrator to
 * surface why pass 2 fired so the user can verify (or tune thresholds).
 */
export function formatReconvergeReason(reason: ReconvergeReason): string {
  switch (reason.kind) {
    case 'weights': {
      const pct = (reason.ratio - 1) * 100;
      const sign = pct >= 0 ? '+' : '';
      return `weights: ${reason.stat} shifted ${sign}${pct.toFixed(1)}% (${reason.v1.toFixed(2)} → ${reason.v2.toFixed(2)})`;
    }
    case 'weights_rank':
      return (
        `weights_rank: ${reason.stat_a} vs ${reason.stat_b} flipped ` +
        `(was ${reason.stat_a} ${reason.v1_ratio.toFixed(2)}× ${reason.stat_b}, ` +
        `now ${reason.stat_b} ${reason.v2_ratio.toFixed(2)}× ${reason.stat_a})`
      );
    case 'consumables':
      return `consumables: ${reason.consumable} winner flipped (item_id ${reason.v1_item_id} → ${reason.v2_item_id})`;
    case 'trinket':
      return `trinket: stat-vector predicts different pair`;
  }
}
