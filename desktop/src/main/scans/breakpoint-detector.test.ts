import { describe, expect, it } from 'vitest';
import {
  detectLiveStats,
  pickTopKForBreakpointPhase,
  scoreItemForLiveStats,
} from './breakpoint-detector';

describe('detectLiveStats', () => {
  it('flags a stat whose weight shifted by >20% (default threshold)', () => {
    const live = detectLiveStats({
      weightsOriginal: { intellect: 1.0, haste: 0.8, crit: 0.7, mastery: 0.9, versatility: 0.6 },
      weightsConverged: { intellect: 1.0, haste: 0.5, crit: 0.7, mastery: 0.9, versatility: 0.6 },
    });
    // haste dropped from 0.8 → 0.5 = -37.5% — well over 20%.
    expect(live).toContain('haste');
    expect(live).not.toContain('crit');
    expect(live).not.toContain('mastery');
  });

  it('respects a custom weightShiftFraction', () => {
    const live = detectLiveStats({
      weightsOriginal: { haste: 1.0, crit: 1.0 },
      weightsConverged: { haste: 0.95, crit: 1.0 },
      weightShiftFraction: 0.01, // very tight — even 5% shifts count
    });
    expect(live).toEqual(['haste']);
  });

  it('returns empty list when no stat shifted meaningfully', () => {
    const live = detectLiveStats({
      weightsOriginal: { haste: 1.0, crit: 1.0, mastery: 1.0, versatility: 1.0 },
      weightsConverged: { haste: 1.05, crit: 0.95, mastery: 1.02, versatility: 0.98 },
    });
    expect(live).toEqual([]);
  });

  it('flags a stat going from zero to non-zero as live', () => {
    const live = detectLiveStats({
      weightsOriginal: { haste: 0, crit: 1.0 },
      weightsConverged: { haste: 0.4, crit: 1.0 },
    });
    expect(live).toContain('haste');
  });

  it('skips stats that are zero in both baselines', () => {
    const live = detectLiveStats({
      weightsOriginal: { haste: 0, crit: 0, mastery: 1.0, versatility: 0 },
      weightsConverged: { haste: 0, crit: 0, mastery: 0.9, versatility: 0 },
    });
    expect(live).toEqual([]);
  });

  it('only inspects secondary stats — primary changes are ignored', () => {
    const live = detectLiveStats({
      weightsOriginal: { intellect: 1.0, haste: 0.5 },
      weightsConverged: { intellect: 0.5, haste: 0.5 },
    });
    expect(live).not.toContain('intellect');
  });
});

describe('scoreItemForLiveStats', () => {
  it('returns 0 when no live stats', () => {
    expect(scoreItemForLiveStats({ itemIlvl: 280, liveStats: [] })).toBe(0);
  });

  it('returns ilvl as a proxy when at least one live stat', () => {
    expect(scoreItemForLiveStats({ itemIlvl: 280, liveStats: ['haste'] })).toBe(280);
    expect(scoreItemForLiveStats({ itemIlvl: 290, liveStats: ['haste', 'crit'] })).toBe(290);
  });
});

describe('pickTopKForBreakpointPhase', () => {
  it('returns empty list when no live stats', () => {
    const items = [{ ilvl: 280, name: 'A' }, { ilvl: 285, name: 'B' }];
    expect(pickTopKForBreakpointPhase(items, [], 3)).toEqual([]);
  });

  it('sorts by ilvl descending and caps at k', () => {
    const items = [
      { ilvl: 280, name: 'A' },
      { ilvl: 290, name: 'B' },
      { ilvl: 270, name: 'C' },
      { ilvl: 285, name: 'D' },
    ];
    const top = pickTopKForBreakpointPhase(items, ['haste'], 2);
    expect(top.map((i) => i.name)).toEqual(['B', 'D']);
  });

  it('ties broken by name (stable, deterministic)', () => {
    const items = [
      { ilvl: 280, name: 'B' },
      { ilvl: 280, name: 'A' },
    ];
    const top = pickTopKForBreakpointPhase(items, ['haste'], 5);
    expect(top.map((i) => i.name)).toEqual(['A', 'B']);
  });

  it('respects k=0 (returns empty even with live stats)', () => {
    const items = [{ ilvl: 280, name: 'A' }];
    expect(pickTopKForBreakpointPhase(items, ['haste'], 0)).toEqual([]);
  });
});
