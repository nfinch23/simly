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
      kind: 'consumables';
      consumable: 'flask' | 'food';
      v1_item_id: number | undefined;
      v2_item_id: number | undefined;
    }
  | {
      kind: 'trinket';
    };

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

  // --- Trigger A: stat-weights shift past threshold on any secondary.
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
    case 'consumables':
      return `consumables: ${reason.consumable} winner flipped (item_id ${reason.v1_item_id} → ${reason.v2_item_id})`;
    case 'trinket':
      return `trinket: stat-vector predicts different pair`;
  }
}
