import { describe, expect, it } from 'vitest';
import {
  formatReconvergeReason,
  shouldTriggerPass2,
  WEIGHT_SHIFT_THRESHOLD,
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

  it('fires WEIGHTS trigger when haste shifts past 25% (GCD-floor scenario)', () => {
    const result = shouldTriggerPass2({
      weights_v1: baseWeights,
      // Haste's marginal value halves — classic post-GCD-floor pattern.
      weights_v2: { ...baseWeights, haste: 6 },
      flask_v1_item_id: 100,
      flask_v2_item_id: 100,
      food_v1_item_id: 200,
      food_v2_item_id: 200,
      trinket_flip_predicted: false,
    });
    expect(result.shouldTrigger).toBe(true);
    expect(result.reasons).toHaveLength(1);
    const reason = result.reasons[0]!;
    expect(reason.kind).toBe('weights');
    if (reason.kind === 'weights') {
      expect(reason.stat).toBe('haste');
      expect(reason.ratio).toBeCloseTo(0.5, 2);
    }
  });

  it('fires WEIGHTS trigger for upward shifts too (haste becomes more valuable)', () => {
    const result = shouldTriggerPass2({
      weights_v1: baseWeights,
      weights_v2: { ...baseWeights, crit: 22 }, // 22/15 = 1.47 ratio = +47%
      trinket_flip_predicted: false,
    });
    expect(result.shouldTrigger).toBe(true);
    const r = result.reasons[0]!;
    expect(r.kind).toBe('weights');
    if (r.kind === 'weights') expect(r.stat).toBe('crit');
  });

  it('does NOT fire WEIGHTS trigger when shift is below threshold', () => {
    const result = shouldTriggerPass2({
      // 12 → 13.5 is +12.5%, well below the 25% threshold.
      weights_v1: baseWeights,
      weights_v2: { ...baseWeights, haste: 13.5 },
      trinket_flip_predicted: false,
    });
    expect(result.shouldTrigger).toBe(false);
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
    expect(result.reasons).toHaveLength(3);
    const kinds = result.reasons.map((r) => r.kind);
    expect(kinds).toContain('weights');
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

  it('threshold edges: ratio = 1.25 exactly does NOT fire (strictly greater than)', () => {
    // 12 × 1.25 = 15.0 → |ratio - 1| = 0.25 exactly; should NOT trigger.
    const result = shouldTriggerPass2({
      weights_v1: baseWeights,
      weights_v2: { ...baseWeights, haste: 15.0 },
      trinket_flip_predicted: false,
    });
    expect(result.shouldTrigger).toBe(false);
    expect(WEIGHT_SHIFT_THRESHOLD).toBe(0.25);
  });

  it('threshold edges: ratio just past 1.25 DOES fire', () => {
    const result = shouldTriggerPass2({
      weights_v1: baseWeights,
      weights_v2: { ...baseWeights, haste: 15.5 }, // ratio ≈ 1.29
      trinket_flip_predicted: false,
    });
    expect(result.shouldTrigger).toBe(true);
  });
});

describe('formatReconvergeReason', () => {
  it('formats weights reason with sign and percent', () => {
    const out = formatReconvergeReason({
      kind: 'weights',
      stat: 'haste',
      v1: 12,
      v2: 6,
      ratio: 0.5,
    });
    expect(out).toBe('weights: haste shifted -50.0% (12.00 → 6.00)');
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
});
