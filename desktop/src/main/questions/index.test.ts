import { describe, expect, it } from 'vitest';
import {
  buildProfilesetLines,
  matchProfilesetsByPrefix,
  roundTo,
} from './index';
import type { SimcRunResult } from '../simc-runner';

function fakeRun(profilesets: Array<{ name: string; mean: number }>): SimcRunResult {
  return {
    simcVersion: '1205-01',
    gitRevision: 'abcdefg',
    buildDate: '2026-04-30',
    profilesets: profilesets.map((p) => ({
      name: p.name,
      mean: p.mean,
      stddev: 0,
      iterations: 1,
    })),
    rawJsonPath: '/tmp/x.json',
  };
}

describe('buildProfilesetLines', () => {
  it('emits one line per candidate with prefix_key naming', () => {
    const out = buildProfilesetLines('flask', [
      { key: 'a', simcLine: 'flask=foo' },
      { key: 'b', simcLine: 'flask=bar' },
    ]);
    expect(out).toBe(
      'profileset."flask_a"+="flask=foo"\nprofileset."flask_b"+="flask=bar"',
    );
  });

  it('returns an empty string for no candidates', () => {
    expect(buildProfilesetLines('flask', [])).toBe('');
  });
});

describe('matchProfilesetsByPrefix', () => {
  const candidates = [
    { key: 'a', item_id: 1 },
    { key: 'b', item_id: 2 },
  ] as const;

  it('matches profilesets named <prefix>_<key> to candidates', () => {
    const run = fakeRun([
      { name: 'flask_a', mean: 100 },
      { name: 'flask_b', mean: 200 },
    ]);
    const matched = matchProfilesetsByPrefix(run, 'flask', candidates);
    expect(matched).toHaveLength(2);
    expect(matched[0]!.candidate.item_id).toBe(1);
    expect(matched[0]!.mean).toBe(100);
  });

  it('skips profilesets that do not belong to this question', () => {
    const run = fakeRun([
      { name: 'food_a', mean: 999 },
      { name: 'flask_a', mean: 100 },
      { name: 'random', mean: 1 },
    ]);
    const matched = matchProfilesetsByPrefix(run, 'flask', candidates);
    expect(matched).toHaveLength(1);
    expect(matched[0]!.candidate.item_id).toBe(1);
  });

  it('returns empty when no profileset matches', () => {
    const run = fakeRun([{ name: 'food_a', mean: 999 }]);
    expect(matchProfilesetsByPrefix(run, 'flask', candidates)).toEqual([]);
  });
});

describe('roundTo', () => {
  it('rounds to the requested decimal places', () => {
    expect(roundTo(1.23456, 2)).toBe(1.23);
    expect(roundTo(1.235, 2)).toBe(1.24);
    expect(roundTo(-0.20924671732, 2)).toBe(-0.21);
  });

  it('handles 0 decimals', () => {
    expect(roundTo(1.7, 0)).toBe(2);
  });
});
