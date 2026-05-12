import { describe, expect, it } from 'vitest';
import {
  computeHerdMedian,
  computeWeightDeltas,
  detectMagnitudeOutliers,
  detectRankFlips,
  formatReconvergeReason,
  RANK_FLIP_TOLERANCE,
  RELATIVE_DELTA_THRESHOLD,
  shouldTriggerPass2,
} from './reconverge-gate';
import type { StatWeights } from '@simly/shared';

// Baseline weights used by most tests. Values are arbitrary but
// representative of a real Demo Warlock pass-1 stat-factor sim.
const baseWeights: StatWeights = {
  intellect: 30,
  haste: 12,
  crit: 15,
  mastery: 10,
  versatility: 11,
};

describe('shouldTriggerPass2', () => {
  it('returns no triggers when nothing changed', () => {
    const result = shouldTriggerPass2({
      weights_v1: baseWeights,
      weights_v2: { ...baseWeights },
      flask_v1_item_id: 100,
      flask_v2_item_id: 100,
      food_v1_item_id: 200,
      food_v2_item_id: 200,
      trinket_flip_predicted: false,
    });
    expect(result.shouldTrigger).toBe(false);
    expect(result.reasons).toEqual([]);
  });

  it('fires WEIGHTS trigger when haste halves vs a flat herd (GCD-floor scenario)', () => {
    // crit/mastery/vers unchanged → herd median = 1.0
    // haste 12 → 6 → ratio 0.5, relative_ratio 0.5 (50% below herd)
    const result = shouldTriggerPass2({
      weights_v1: baseWeights,
      weights_v2: { ...baseWeights, haste: 6 },
      trinket_flip_predicted: false,
    });
    expect(result.shouldTrigger).toBe(true);
    const weightsReason = result.reasons.find((r) => r.kind === 'weights');
    expect(weightsReason).toBeDefined();
    if (weightsReason && weightsReason.kind === 'weights') {
      expect(weightsReason.stat).toBe('haste');
      expect(weightsReason.ratio).toBeCloseTo(0.5, 2);
      expect(weightsReason.herd_median).toBeCloseTo(1.0, 2);
      expect(weightsReason.relative_ratio).toBeCloseTo(0.5, 2);
    }
  });

  it('fires WEIGHTS trigger for upward outliers too (crit shoots up while herd stays flat)', () => {
    const result = shouldTriggerPass2({
      weights_v1: baseWeights,
      // crit 15 → 22 (ratio 1.47); haste/mastery/vers unchanged so
      // herd = 1.0; relative_ratio = 1.47 (47% above herd, above
      // threshold).
      weights_v2: { ...baseWeights, crit: 22 },
      trinket_flip_predicted: false,
    });
    expect(result.shouldTrigger).toBe(true);
    const r = result.reasons.find((x) => x.kind === 'weights');
    expect(r).toBeDefined();
    if (r && r.kind === 'weights') {
      expect(r.stat).toBe('crit');
      expect(r.herd_median).toBeCloseTo(1.0, 2);
    }
  });

  it('does NOT fire when one stat shifts but stays within tolerance of the herd', () => {
    // haste 12 → 13.5 (ratio 1.125); herd = 1.0; relative = 1.125,
    // deviation 12.5%, below 25% threshold.
    const result = shouldTriggerPass2({
      weights_v1: baseWeights,
      weights_v2: { ...baseWeights, haste: 13.5 },
      trinket_flip_predicted: false,
    });
    expect(result.shouldTrigger).toBe(false);
  });

  // NEW: this is the +23.7% near-miss case from PR #27's real Felfriend
  // data. All four secondaries shifted upward (intellect growth lifted
  // the entire stat budget), so the herd shifted too — haste's
  // deviation from herd is only ~13%, well under the threshold. Under
  // the old absolute-shift detection this WOULD have fired (haste +23.7%
  // looks close to the absolute threshold); under herd-relative
  // detection it correctly stays silent because nothing structurally
  // changed about the actor's stat priorities.
  it('does NOT fire when ALL secondaries shift upward together (intellect-growth artifact)', () => {
    const result = shouldTriggerPass2({
      weights_v1: { intellect: 30, crit: 15, haste: 12, mastery: 10, versatility: 11 },
      weights_v2: {
        intellect: 32, // primary growth (excluded from check anyway)
        crit: 15 * 1.035,    // +3.5%
        haste: 12 * 1.237,   // +23.7%
        mastery: 10 * 1.110, // +11.0%
        versatility: 11 * 1.077, // +7.7%
      },
      trinket_flip_predicted: false,
    });
    expect(result.shouldTrigger).toBe(false);
    // Sanity: even the largest shift (haste +23.7%) is within tolerance
    // because the herd also moved.
    const median = computeHerdMedian(
      { intellect: 30, crit: 15, haste: 12, mastery: 10, versatility: 11 },
      {
        intellect: 32,
        crit: 15 * 1.035,
        haste: 12 * 1.237,
        mastery: 10 * 1.110,
        versatility: 11 * 1.077,
      },
    );
    expect(median).toBeGreaterThan(1.07); // herd moved ~9%
    expect(median).toBeLessThan(1.12);
  });

  it('fires WHEN one stat moves opposite the herd (asymmetric structural change)', () => {
    // crit, mastery, vers all up 10%. Haste DOWN 30%. Median ≈ 1.10.
    // haste relative = 0.70/1.10 = 0.636 → 36.4% deviation, fires.
    const result = shouldTriggerPass2({
      weights_v1: { crit: 15, haste: 12, mastery: 10, versatility: 11 },
      weights_v2: { crit: 15 * 1.10, haste: 12 * 0.70, mastery: 10 * 1.10, versatility: 11 * 1.10 },
    });
    expect(result.shouldTrigger).toBe(true);
    const w = result.reasons.find((r) => r.kind === 'weights');
    expect(w).toBeDefined();
    if (w && w.kind === 'weights') {
      expect(w.stat).toBe('haste');
      expect(w.herd_median).toBeCloseTo(1.10, 2);
      expect(w.relative_ratio).toBeLessThan(0.75); // clearly below herd
    }
  });

  it('does NOT fire WEIGHTS trigger for primary-stat changes (intellect excluded)', () => {
    // Intellect can swing freely between sims without indicating an
    // actor-state shift; only secondaries are gated.
    const result = shouldTriggerPass2({
      weights_v1: baseWeights,
      weights_v2: { ...baseWeights, intellect: 80 }, // huge change
      trinket_flip_predicted: false,
    });
    expect(result.shouldTrigger).toBe(false);
  });

  it('fires CONSUMABLES trigger when flask winner flips', () => {
    const result = shouldTriggerPass2({
      weights_v1: baseWeights,
      weights_v2: { ...baseWeights },
      flask_v1_item_id: 100,
      flask_v2_item_id: 101,
      food_v1_item_id: 200,
      food_v2_item_id: 200,
      trinket_flip_predicted: false,
    });
    expect(result.shouldTrigger).toBe(true);
    expect(result.reasons).toHaveLength(1);
    const r = result.reasons[0]!;
    expect(r.kind).toBe('consumables');
    if (r.kind === 'consumables') {
      expect(r.consumable).toBe('flask');
      expect(r.v1_item_id).toBe(100);
      expect(r.v2_item_id).toBe(101);
    }
  });

  it('fires CONSUMABLES trigger when flask SimC key flips (string identifiers)', () => {
    // Real-world orchestrator path: the prescan / re-eval winners are
    // SimC key strings (e.g. flask_of_the_magisters_2), not numeric
    // item_ids, because the best.item_id field is currently a placeholder
    // 0 — same string flowing into setConsumablesInProfile.
    const result = shouldTriggerPass2({
      flask_v1_item_id: 'flask_of_the_magisters_2',
      flask_v2_item_id: 'flask_of_the_blood_knights_2',
      food_v1_item_id: 'silvermoon_parade',
      food_v2_item_id: 'silvermoon_parade',
    });
    expect(result.shouldTrigger).toBe(true);
    const r = result.reasons[0]!;
    expect(r.kind).toBe('consumables');
    if (r.kind === 'consumables') {
      expect(r.consumable).toBe('flask');
      expect(r.v1_item_id).toBe('flask_of_the_magisters_2');
      expect(r.v2_item_id).toBe('flask_of_the_blood_knights_2');
    }
  });

  it('does NOT fire CONSUMABLES trigger when flask SimC keys match', () => {
    const result = shouldTriggerPass2({
      flask_v1_item_id: 'flask_of_the_magisters_2',
      flask_v2_item_id: 'flask_of_the_magisters_2',
      food_v1_item_id: 'silvermoon_parade',
      food_v2_item_id: 'silvermoon_parade',
    });
    expect(result.shouldTrigger).toBe(false);
  });

  it('fires CONSUMABLES trigger when food winner flips', () => {
    const result = shouldTriggerPass2({
      flask_v1_item_id: 100,
      flask_v2_item_id: 100,
      food_v1_item_id: 200,
      food_v2_item_id: 201,
    });
    expect(result.shouldTrigger).toBe(true);
    const r = result.reasons[0]!;
    expect(r.kind).toBe('consumables');
    if (r.kind === 'consumables') expect(r.consumable).toBe('food');
  });

  it('fires TRINKET trigger when stat-vector predicts a flip', () => {
    const result = shouldTriggerPass2({
      trinket_flip_predicted: true,
    });
    expect(result.shouldTrigger).toBe(true);
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]!.kind).toBe('trinket');
  });

  it('collects ALL fired reasons (multi-trigger run reports every cause)', () => {
    // Haste 12→6 fires both `weights` (magnitude) and `weights_rank`
    // (haste-vs-mastery dominance flip), plus flask change fires
    // `consumables`, plus the trinket flip fires `trinket`. Four
    // distinct kinds, all collected.
    const result = shouldTriggerPass2({
      weights_v1: baseWeights,
      weights_v2: { ...baseWeights, haste: 6 },
      flask_v1_item_id: 100,
      flask_v2_item_id: 101,
      food_v1_item_id: 200,
      food_v2_item_id: 200,
      trinket_flip_predicted: true,
    });
    expect(result.shouldTrigger).toBe(true);
    const kinds = new Set(result.reasons.map((r) => r.kind));
    expect(kinds).toContain('weights');
    expect(kinds).toContain('weights_rank');
    expect(kinds).toContain('consumables');
    expect(kinds).toContain('trinket');
  });

  it('silently skips WEIGHTS trigger when stat-weights inputs are missing', () => {
    // Defensive fallback — if the post-gear stat-weights sim failed to
    // produce v2, we can't gate on weights. Don't crash; don't trigger.
    const result = shouldTriggerPass2({
      weights_v1: baseWeights,
      // weights_v2 omitted
      flask_v1_item_id: 100,
      flask_v2_item_id: 100,
      trinket_flip_predicted: false,
    });
    expect(result.shouldTrigger).toBe(false);
  });

  it('silently skips CONSUMABLES trigger when one endpoint is missing', () => {
    // If we only ran the baseline flask scan but the post-gear re-eval
    // failed (or vice versa), we can't compare. Don't crash.
    const result = shouldTriggerPass2({
      flask_v1_item_id: 100,
      // flask_v2_item_id omitted
    });
    expect(result.shouldTrigger).toBe(false);
  });

  it('does not fire on tiny weight shifts that are within sim noise', () => {
    // 12 → 12.1 = +0.8%; well within scale-factor sim noise (~5-10%).
    const result = shouldTriggerPass2({
      weights_v1: baseWeights,
      weights_v2: { ...baseWeights, haste: 12.1, crit: 14.5 },
      trinket_flip_predicted: false,
    });
    expect(result.shouldTrigger).toBe(false);
  });

  it('skips WEIGHTS trigger for stats with v1 = 0 (spec doesn\'t use them)', () => {
    // Some specs have structurally-zero weights for certain stats
    // (e.g. an STR-based spec has zero AGI weight). Dividing by zero
    // would NaN; we just skip the stat.
    const result = shouldTriggerPass2({
      weights_v1: { ...baseWeights, mastery: 0 },
      weights_v2: { ...baseWeights, mastery: 50 },
      trinket_flip_predicted: false,
    });
    expect(result.shouldTrigger).toBe(false);
  });

  it('threshold edges: relative_ratio at 1.25 exactly does NOT fire (strictly greater than)', () => {
    // Herd = 1.0 (other stats unchanged). haste 12 → 15 gives ratio 1.25,
    // relative_ratio 1.25, deviation exactly 25% — boundary case, should
    // NOT fire.
    const result = shouldTriggerPass2({
      weights_v1: baseWeights,
      weights_v2: { ...baseWeights, haste: 15.0 },
      trinket_flip_predicted: false,
    });
    expect(result.shouldTrigger).toBe(false);
    expect(RELATIVE_DELTA_THRESHOLD).toBe(0.25);
  });

  it('threshold edges: relative_ratio just past 1.25 DOES fire', () => {
    // haste 12 → 15.5 (ratio 1.292); herd = 1.0; relative_ratio 1.292,
    // deviation 29.2%, above threshold.
    const result = shouldTriggerPass2({
      weights_v1: baseWeights,
      weights_v2: { ...baseWeights, haste: 15.5 },
      trinket_flip_predicted: false,
    });
    expect(result.shouldTrigger).toBe(true);
  });
});

describe('computeHerdMedian', () => {
  it('returns 1.0 when fewer than 2 secondaries are measurable', () => {
    // Only crit measurable — can't form a median.
    expect(computeHerdMedian({ crit: 15 }, { crit: 12 })).toBe(1.0);
  });

  it('returns the middle ratio for an odd-count list', () => {
    const median = computeHerdMedian(
      { crit: 10, haste: 10, mastery: 10 },
      { crit: 9, haste: 11, mastery: 13 },
    );
    // Sorted ratios: [0.9, 1.1, 1.3]. Median = 1.1.
    expect(median).toBeCloseTo(1.1, 4);
  });

  it('returns the average of the two middle ratios for an even-count list', () => {
    const median = computeHerdMedian(
      { crit: 10, haste: 10, mastery: 10, versatility: 10 },
      { crit: 8, haste: 10, mastery: 12, versatility: 14 },
    );
    // Sorted ratios: [0.8, 1.0, 1.2, 1.4]. Median = (1.0 + 1.2) / 2 = 1.1.
    expect(median).toBeCloseTo(1.1, 4);
  });

  it('skips stats with v1 = 0 when computing median', () => {
    // mastery v1 = 0 → excluded. Median across crit + haste only.
    const median = computeHerdMedian(
      { crit: 10, haste: 10, mastery: 0 },
      { crit: 12, haste: 14, mastery: 5 },
    );
    expect(median).toBeCloseTo(1.3, 4); // avg of 1.2 and 1.4
  });
});

describe('detectMagnitudeOutliers', () => {
  it('returns empty when no stat deviates from the herd', () => {
    // All four secondaries shift uniformly +10%.
    const outliers = detectMagnitudeOutliers(
      { crit: 10, haste: 10, mastery: 10, versatility: 10 },
      { crit: 11, haste: 11, mastery: 11, versatility: 11 },
    );
    expect(outliers).toEqual([]);
  });

  it('returns the outlying stat with its herd_median and relative_ratio', () => {
    const outliers = detectMagnitudeOutliers(
      { crit: 10, haste: 10, mastery: 10, versatility: 10 },
      { crit: 11, haste: 4, mastery: 11, versatility: 11 },
    );
    expect(outliers).toHaveLength(1);
    expect(outliers[0]!.stat).toBe('haste');
    // Herd median: sorted [0.4, 1.1, 1.1, 1.1], median = (1.1+1.1)/2 = 1.1
    expect(outliers[0]!.herd_median).toBeCloseTo(1.1, 4);
    // relative_ratio = 0.4 / 1.1 ≈ 0.364
    expect(outliers[0]!.relative_ratio).toBeCloseTo(0.4 / 1.1, 3);
  });

  it('returns no outliers when fewer than 2 secondaries are measurable (no herd)', () => {
    // Only crit present.
    const outliers = detectMagnitudeOutliers({ crit: 10 }, { crit: 50 });
    expect(outliers).toEqual([]);
  });

  it('respects the threshold argument', () => {
    // With default threshold 0.25 this fires; tighten to 0.50 and it
    // shouldn't.
    const v1 = { crit: 10, haste: 10, mastery: 10, versatility: 10 };
    const v2 = { crit: 11, haste: 11, mastery: 11, versatility: 7 }; // vers -30%
    expect(detectMagnitudeOutliers(v1, v2, 0.25)).toHaveLength(1);
    expect(detectMagnitudeOutliers(v1, v2, 0.50)).toHaveLength(0);
  });
});

describe('detectRankFlips', () => {
  it('detects a clear dominance flip between two stats', () => {
    // v1: crit clearly above haste (15 vs 10 = 1.5x)
    // v2: haste clearly above crit (15 vs 10 = 1.5x)
    const flips = detectRankFlips(
      { crit: 15, haste: 10, mastery: 11, versatility: 9 },
      { crit: 10, haste: 15, mastery: 11, versatility: 9 },
    );
    const cs = flips.find(
      (f) => (f.stat_a === 'crit' && f.stat_b === 'haste') || (f.stat_a === 'haste' && f.stat_b === 'crit'),
    );
    expect(cs).toBeDefined();
    expect(cs!.stat_a).toBe('crit');
    expect(cs!.stat_b).toBe('haste');
  });

  it('does NOT flag stats that stayed in the same relative order', () => {
    // crit and haste both shift down but crit stays on top
    const flips = detectRankFlips(
      { crit: 15, haste: 10 },
      { crit: 12, haste: 8 },
    );
    expect(flips.filter((f) =>
      (f.stat_a === 'crit' && f.stat_b === 'haste') || (f.stat_a === 'haste' && f.stat_b === 'crit'),
    )).toHaveLength(0);
  });

  it('does NOT flag stats that were tied in v1 (within tolerance)', () => {
    // crit/haste within 10% in v1; not a clear pre-flip state.
    const flips = detectRankFlips(
      { crit: 10, haste: 10.5 },
      { crit: 12, haste: 8 }, // now crit clearly dominates
    );
    expect(flips).toHaveLength(0);
  });

  it('does NOT flag stats that became tied in v2 (within tolerance)', () => {
    // Clear dominance in v1, but converged actor brings them within
    // tolerance — not a flip, just a softening.
    const flips = detectRankFlips(
      { crit: 15, haste: 8 },
      { crit: 11, haste: 10.5 },
    );
    expect(flips).toHaveLength(0);
  });

  it('detects multiple simultaneous flips', () => {
    // Two independent flips: crit↔haste AND mastery↔versatility
    const flips = detectRankFlips(
      { crit: 15, haste: 8, mastery: 14, versatility: 7 },
      { crit: 8, haste: 15, mastery: 7, versatility: 14 },
    );
    expect(flips.length).toBeGreaterThanOrEqual(2);
  });

  it('handles missing or zero-weighted stats gracefully', () => {
    // mastery zero in v1 (spec-irrelevant); should be skipped, no NaN.
    expect(() =>
      detectRankFlips(
        { crit: 15, haste: 8, mastery: 0 },
        { crit: 8, haste: 15, mastery: 12 },
      ),
    ).not.toThrow();
  });

  it('orders the flip output deterministically (TRIGGERED_STATS order)', () => {
    // Flips for (crit, haste) and (mastery, versatility) should appear
    // in that order regardless of input map iteration.
    const flips = detectRankFlips(
      { versatility: 14, mastery: 7, haste: 15, crit: 8 },
      { versatility: 7, mastery: 14, haste: 8, crit: 15 },
    );
    // crit appears at index 0 in TRIGGERED_STATS, haste at 1, mastery at
    // 2, versatility at 3 — so the (crit, haste) pair should come first.
    expect(flips[0]!.stat_a === 'crit' || flips[0]!.stat_b === 'crit').toBe(true);
  });

  it('triggers WEIGHTS_RANK reason in shouldTriggerPass2 even when no magnitude trigger fires', () => {
    // Crit and haste flip dominance, but no single stat shifts past 25%.
    // crit: 15 → 12 (-20%) — within threshold
    // haste: 12 → 15 (+25% exactly) — right at threshold (NOT exceeding)
    const result = shouldTriggerPass2({
      weights_v1: { intellect: 30, crit: 15, haste: 12, mastery: 11, versatility: 12 },
      weights_v2: { intellect: 30, crit: 12, haste: 15, mastery: 11, versatility: 12 },
    });
    expect(result.shouldTrigger).toBe(true);
    expect(result.reasons.some((r) => r.kind === 'weights_rank')).toBe(true);
  });

  it('exposes RANK_FLIP_TOLERANCE constant for transparency', () => {
    // Pinning the tolerance constant — bumping it is a public behavior
    // change worth flagging in code review.
    expect(RANK_FLIP_TOLERANCE).toBe(0.10);
  });
});

describe('computeWeightDeltas', () => {
  it('returns per-stat ratios for every present secondary', () => {
    const out = computeWeightDeltas(
      { intellect: 30, crit: 15, haste: 12, mastery: 10, versatility: 11 },
      { intellect: 32, crit: 14, haste: 13, mastery: 11, versatility: 12 },
    );
    expect(out.crit).toBeCloseTo(14 / 15, 4);
    expect(out.haste).toBeCloseTo(13 / 12, 4);
    expect(out.mastery).toBeCloseTo(11 / 10, 4);
    expect(out.versatility).toBeCloseTo(12 / 11, 4);
  });

  it('excludes primary stats (intellect / strength / agility)', () => {
    const out = computeWeightDeltas(
      { intellect: 30, crit: 15 },
      { intellect: 35, crit: 16 },
    );
    expect(out.intellect).toBeUndefined();
    expect(out.crit).toBeDefined();
  });

  it('skips stats missing from either side', () => {
    const out = computeWeightDeltas(
      { crit: 15 },
      { crit: 12, haste: 10 },
    );
    expect(out.crit).toBeDefined();
    expect(out.haste).toBeUndefined(); // missing in v1
  });

  it('skips stats with zero v1 (divide-by-zero protection)', () => {
    const out = computeWeightDeltas(
      { mastery: 0 },
      { mastery: 10 },
    );
    expect(out.mastery).toBeUndefined();
  });
});

describe('formatReconvergeReason', () => {
  it('formats weights reason with stat shift, herd shift, AND relative deviation', () => {
    const out = formatReconvergeReason({
      kind: 'weights',
      stat: 'haste',
      v1: 12,
      v2: 6,
      ratio: 0.5,
      herd_median: 1.1,
      relative_ratio: 0.5 / 1.1,
    });
    expect(out).toContain('haste moved -50.0%');
    expect(out).toContain('vs herd +10.0%');
    expect(out).toContain('relative -54.5%');
  });

  it('formats consumables reason with item ids', () => {
    const out = formatReconvergeReason({
      kind: 'consumables',
      consumable: 'flask',
      v1_item_id: 100,
      v2_item_id: 101,
    });
    expect(out).toContain('flask winner flipped');
    expect(out).toContain('100');
    expect(out).toContain('101');
  });

  it('formats trinket reason', () => {
    const out = formatReconvergeReason({ kind: 'trinket' });
    expect(out).toContain('trinket');
    expect(out).toContain('stat-vector');
  });

  it('formats weights_rank reason with both ratios', () => {
    const out = formatReconvergeReason({
      kind: 'weights_rank',
      stat_a: 'crit',
      stat_b: 'haste',
      v1_ratio: 1.5,
      v2_ratio: 1.3,
    });
    expect(out).toContain('crit vs haste flipped');
    expect(out).toContain('1.50× haste');
    expect(out).toContain('1.30× crit');
  });
});
