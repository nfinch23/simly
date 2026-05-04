import { describe, expect, it } from 'vitest';
import * as cfg from './gear-config';

describe('gear-config thresholds (sanity)', () => {
  it('classification thresholds: tie < good < trash (monotone widening)', () => {
    expect(cfg.TIE_WINDOW_PCT).toBeLessThan(cfg.GOOD_THRESHOLD_PCT);
    expect(cfg.GOOD_THRESHOLD_PCT).toBeLessThan(cfg.TRASH_THRESHOLD_PCT);
  });

  it('ladder thresholds: refined keep < coarse keep (each stage narrows)', () => {
    expect(cfg.REFINED_KEEP_THRESHOLD_PCT).toBeLessThan(cfg.COARSE_KEEP_THRESHOLD_PCT);
  });

  it('iteration counts: coarse < refined < final (each stage adds precision)', () => {
    expect(cfg.COARSE_ITERATIONS).toBeLessThan(cfg.REFINED_ITERATIONS);
    expect(cfg.REFINED_ITERATIONS).toBeLessThan(cfg.FINAL_ITERATIONS);
  });

  it('pruner multiplier > 1 (otherwise the leader item itself fails the filter)', () => {
    expect(cfg.DEFAULT_PRUNER_MULTIPLIER).toBeGreaterThan(1);
  });

  it('maxCombos is a positive integer in a sane range', () => {
    expect(cfg.DEFAULT_MAX_COMBOS).toBeGreaterThan(0);
    expect(cfg.DEFAULT_MAX_COMBOS).toBeLessThanOrEqual(100_000);
    expect(Number.isInteger(cfg.DEFAULT_MAX_COMBOS)).toBe(true);
  });

  it('TOP_TRINKETS_TO_KEEP is at least 2 (need pairs for the trinket sim)', () => {
    expect(cfg.TOP_TRINKETS_TO_KEEP).toBeGreaterThanOrEqual(2);
  });

  it('IGNORE_THRESHOLD_PCT defaults to TRASH_THRESHOLD_PCT (consistent semantics)', () => {
    expect(cfg.IGNORE_THRESHOLD_PCT).toBe(cfg.TRASH_THRESHOLD_PCT);
  });

  it('SWAP_TEST_ITERATIONS > 0 and reasonable for a tight profileset count', () => {
    expect(cfg.SWAP_TEST_ITERATIONS).toBeGreaterThan(0);
    expect(cfg.SWAP_TEST_ITERATIONS).toBeLessThanOrEqual(10_000);
  });
});

describe('gear-config exports (consumer-facing surface)', () => {
  // Smoke test for the consumer-facing exports — guards against
  // accidental rename/removal that would break dependent modules.
  it('exposes all the threshold constants downstream modules import', () => {
    const required = [
      'DEFAULT_PRUNER_MULTIPLIER',
      'DEFAULT_MAX_COMBOS',
      'TIE_WINDOW_PCT',
      'GOOD_THRESHOLD_PCT',
      'TRASH_THRESHOLD_PCT',
      'COARSE_KEEP_THRESHOLD_PCT',
      'REFINED_KEEP_THRESHOLD_PCT',
      'COARSE_ITERATIONS',
      'REFINED_ITERATIONS',
      'FINAL_ITERATIONS',
      'TOP_TRINKETS_TO_KEEP',
      'TRINKET_ITERATIONS',
      'SWAP_TEST_ITERATIONS',
      'IGNORE_THRESHOLD_PCT',
    ];
    for (const key of required) {
      expect(cfg, `missing export: ${key}`).toHaveProperty(key);
    }
  });
});
