import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LatestNightlyStrategy,
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
