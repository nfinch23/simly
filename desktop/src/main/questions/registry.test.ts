import { describe, expect, it } from 'vitest';
import { QUESTIONS, buildAllQuestionLines, parseAllQuestions } from './registry';
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

describe('QUESTIONS registry', () => {
  it('contains the best_flask question', () => {
    const ids = QUESTIONS.map((q) => q.id);
    expect(ids).toContain('best_flask');
  });

  it('every registered question has a unique id and prefix', () => {
    const ids = QUESTIONS.map((q) => q.id);
    const prefixes = QUESTIONS.map((q) => q.profilesetPrefix);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
});

describe('buildAllQuestionLines', () => {
  it('concatenates each question\'s buildLines() output', () => {
    const out = buildAllQuestionLines();
    // best_flask should contribute its profileset lines for the flask
    // candidates. Just spot-check that the prefix appears at least once.
    expect(out).toContain('profileset."flask_');
  });
});

describe('parseAllQuestions', () => {
  it('returns a map keyed by question id with each question\'s result', () => {
    const run = fakeRun([
      { name: 'flask_blood_knights', mean: 100 },
      { name: 'flask_magisters', mean: 110 },
      { name: 'food_silvermoon_parade', mean: 120 },
      { name: 'food_royal_roast', mean: 115 },
    ]);
    const all = parseAllQuestions(run);
    expect(all['best_flask']).toBeDefined();
    expect((all['best_flask'] as { best: { name: string } }).best.name).toBe(
      'Flask of the Magisters',
    );
    expect(all['best_food']).toBeDefined();
    expect((all['best_food'] as { best: { name: string } }).best.name).toBe(
      'Silvermoon Parade',
    );
  });

  it('omits questions whose parseResult returns undefined', () => {
    const run = fakeRun([{ name: 'unrelated_profileset', mean: 1 }]);
    const all = parseAllQuestions(run);
    expect(all['best_flask']).toBeUndefined();
    expect(all['best_food']).toBeUndefined();
    expect(Object.keys(all)).toHaveLength(0);
  });
});
