import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LatestNightlyStrategy,
  MondayWeeklyStrategy,
  mostRecentMondayBoundary,
  parseNightlyIndex,
  NIGHTLY_BASE_URL,
} from './simc-version-source';

const FIXTURE = readFileSync(
  join(__dirname, '__fixtures__', 'simc-nightly-index.html'),
  'utf8',
);

describe('parseNightlyIndex', () => {
  it('returns Win64 nightlies in the order they appear in the listing', () => {
    const versions = parseNightlyIndex(FIXTURE);
    expect(versions.length).toBeGreaterThan(0);
    // Fixture is sorted by mtime descending; first match should be the
    // most recent Win64 build (1205.01 captured at the time of writing).
    expect(versions[0]!.patch).toBe('1205.01');
    expect(versions[0]!.gitHash).toBe('d6f091a');
    expect(versions[0]!.filename).toBe('simc-1205.01.d6f091a-win64.7z');
  });

  it('builds an absolute download URL', () => {
    const versions = parseNightlyIndex(FIXTURE);
    expect(versions[0]!.downloadUrl).toBe(
      `${NIGHTLY_BASE_URL}simc-1205.01.d6f091a-win64.7z`,
    );
  });

  it('parses publishedAt as a valid Date', () => {
    const v = parseNightlyIndex(FIXTURE)[0]!;
    expect(v.publishedAt).toBeInstanceOf(Date);
    expect(Number.isFinite(v.publishedAt.getTime())).toBe(true);
  });

  it('skips Mac .dmg and WinARM64 .7z assets', () => {
    const versions = parseNightlyIndex(FIXTURE);
    for (const v of versions) {
      expect(v.filename).toMatch(/-win64\.7z$/);
      expect(v.filename).not.toMatch(/-winarm64\./);
      expect(v.filename).not.toMatch(/\.dmg$/);
    }
  });

  it('returns multiple historical versions in mtime order', () => {
    const versions = parseNightlyIndex(FIXTURE);
    expect(versions.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < versions.length; i++) {
      expect(versions[i - 1]!.publishedAt.getTime()).toBeGreaterThanOrEqual(
        versions[i]!.publishedAt.getTime(),
      );
    }
  });

  it('returns an empty array for unrelated HTML', () => {
    expect(parseNightlyIndex('<html><body>nothing here</body></html>')).toEqual([]);
  });

  it('builds tag as <patch>.<gitHash>', () => {
    const v = parseNightlyIndex(FIXTURE)[0]!;
    expect(v.tag).toBe(`${v.patch}.${v.gitHash}`);
  });
});

describe('LatestNightlyStrategy', () => {
  it('returns the first Win64 entry from the fetched listing', async () => {
    const strategy = new LatestNightlyStrategy(async () => FIXTURE);
    const v = await strategy.resolveCurrent();
    expect(v.patch).toBe('1205.01');
    expect(v.gitHash).toBe('d6f091a');
  });

  it('throws when the listing has no Win64 entries', async () => {
    const strategy = new LatestNightlyStrategy(async () => '<html></html>');
    await expect(strategy.resolveCurrent()).rejects.toThrow(/No Win64 nightly/);
  });

  it('propagates fetcher errors', async () => {
    const strategy = new LatestNightlyStrategy(async () => {
      throw new Error('network down');
    });
    await expect(strategy.resolveCurrent()).rejects.toThrow(/network down/);
  });
});

describe('mostRecentMondayBoundary', () => {
  it('returns this Monday 23:00 UTC when called Tuesday morning', () => {
    // 2026-04-28 (Tue) 03:00 UTC → boundary 2026-04-27 (Mon) 23:00 UTC
    const out = mostRecentMondayBoundary(new Date('2026-04-28T03:00:00Z'));
    expect(out.toISOString()).toBe('2026-04-27T23:00:00.000Z');
  });

  it('returns previous Monday 23:00 UTC when called Monday before the boundary hour', () => {
    // 2026-04-27 (Mon) 22:00 UTC → boundary 2026-04-20 (prev Mon) 23:00 UTC
    const out = mostRecentMondayBoundary(new Date('2026-04-27T22:00:00Z'));
    expect(out.toISOString()).toBe('2026-04-20T23:00:00.000Z');
  });

  it('returns this Monday 23:00 UTC when called Monday after the boundary hour', () => {
    // 2026-04-27 (Mon) 23:30 UTC → boundary same day's 23:00
    const out = mostRecentMondayBoundary(new Date('2026-04-27T23:30:00Z'));
    expect(out.toISOString()).toBe('2026-04-27T23:00:00.000Z');
  });

  it('returns previous Monday when called Sunday', () => {
    // 2026-05-03 (Sun) 12:00 UTC → boundary 2026-04-27 (Mon) 23:00 UTC
    const out = mostRecentMondayBoundary(new Date('2026-05-03T12:00:00Z'));
    expect(out.toISOString()).toBe('2026-04-27T23:00:00.000Z');
  });

  it('respects a custom boundary hour', () => {
    const out = mostRecentMondayBoundary(new Date('2026-04-28T03:00:00Z'), 6);
    expect(out.toISOString()).toBe('2026-04-27T06:00:00.000Z');
  });
});

describe('MondayWeeklyStrategy', () => {
  it('picks the most recent nightly published at or before the Monday boundary', async () => {
    // Fixture's most recent nightly is 2026-05-01 (Friday).
    // If clock is 2026-05-04 (Mon) 23:30 UTC, boundary is 2026-05-04 23:00 UTC.
    // Both 04-29 and 05-01 are before that boundary; should pick 05-01 (newest).
    const clock = () => new Date('2026-05-04T23:30:00Z');
    const strategy = new MondayWeeklyStrategy(async () => FIXTURE, clock);
    const v = await strategy.resolveCurrent();
    expect(v.patch).toBe('1205.01');
  });

  it('skips nightlies published after the most recent Monday boundary', async () => {
    // If clock is 2026-04-28 (Tue) 03:00 UTC, boundary is 2026-04-27 (Mon) 23:00 UTC.
    // The 2026-05-01 nightly is AFTER the boundary, so we should skip it
    // and return the next-latest pre-boundary entry. Looking at the fixture,
    // pre-2026-04-27 23:00 the latest Win64 was 2026-02-12 (1125.01) —
    // since 2026-04-29 was also published Wed-after-boundary.
    const clock = () => new Date('2026-04-28T03:00:00Z');
    const strategy = new MondayWeeklyStrategy(async () => FIXTURE, clock);
    const v = await strategy.resolveCurrent();
    expect(v.publishedAt.getTime()).toBeLessThanOrEqual(
      new Date('2026-04-27T23:00:00Z').getTime(),
    );
    expect(v.patch).toBe('1125.01');
  });

  it('falls back to the oldest entry when every nightly is after the boundary', async () => {
    // If clock is far in the past (year 2000), every fixture entry is "in the future"
    // relative to the boundary — we should fall back to the oldest entry.
    const clock = () => new Date('2000-01-15T00:00:00Z');
    const strategy = new MondayWeeklyStrategy(async () => FIXTURE, clock);
    const v = await strategy.resolveCurrent();
    const all = parseNightlyIndex(FIXTURE);
    expect(v.tag).toBe(all[all.length - 1]!.tag);
  });

  it('throws when the listing has no Win64 entries', async () => {
    const strategy = new MondayWeeklyStrategy(async () => '<html></html>');
    await expect(strategy.resolveCurrent()).rejects.toThrow(/No Win64 nightly/);
  });
});
