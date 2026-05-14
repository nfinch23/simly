import { describe, expect, it } from 'vitest';
import {
  CONTENT_PREFS_DEFAULTS,
  SETTINGS_DEFAULTS,
  mergeContentPrefs,
  type ContentPrefs,
} from './settings';

describe('CONTENT_PREFS_DEFAULTS', () => {
  it('opts every raid difficulty in by default', () => {
    for (const raid of ['voidspire', 'dreamrift', 'march_on_queldanas'] as const) {
      const d = CONTENT_PREFS_DEFAULTS.raids[raid];
      expect(d.lfr).toBe(true);
      expect(d.normal).toBe(true);
      expect(d.heroic).toBe(true);
      expect(d.mythic).toBe(true);
    }
  });

  it('enables M+ at max picker level (10)', () => {
    expect(CONTENT_PREFS_DEFAULTS.mplus.enabled).toBe(true);
    expect(CONTENT_PREFS_DEFAULTS.mplus.max_level).toBe(10);
  });

  it('enables world content at max delve (11) + max ritual (5)', () => {
    expect(CONTENT_PREFS_DEFAULTS.world.enabled).toBe(true);
    expect(CONTENT_PREFS_DEFAULTS.world.max_delve_tier).toBe(11);
    expect(CONTENT_PREFS_DEFAULTS.world.max_ritual_tier).toBe(5);
  });

  it('is included in SETTINGS_DEFAULTS so getSettings exposes it', () => {
    expect(SETTINGS_DEFAULTS.contentPrefs).toBe(CONTENT_PREFS_DEFAULTS);
  });
});

describe('mergeContentPrefs', () => {
  it('returns defaults when stored is undefined', () => {
    const merged = mergeContentPrefs(undefined);
    expect(merged).toEqual(CONTENT_PREFS_DEFAULTS);
  });

  it('returns defaults when stored is empty', () => {
    const merged = mergeContentPrefs({});
    expect(merged).toEqual(CONTENT_PREFS_DEFAULTS);
  });

  it('preserves explicit raid-difficulty overrides', () => {
    const stored: Partial<ContentPrefs> = {
      raids: {
        voidspire: { lfr: false, normal: false, heroic: true, mythic: true },
        // dreamrift + march_on_queldanas omitted — should default to all-on
      } as ContentPrefs['raids'],
    };
    const merged = mergeContentPrefs(stored);
    expect(merged.raids.voidspire).toEqual({
      lfr: false,
      normal: false,
      heroic: true,
      mythic: true,
    });
    // Defaults kick in for omitted raids
    expect(merged.raids.dreamrift).toEqual(CONTENT_PREFS_DEFAULTS.raids.dreamrift);
    expect(merged.raids.march_on_queldanas).toEqual(
      CONTENT_PREFS_DEFAULTS.raids.march_on_queldanas,
    );
  });

  it('fills in missing per-difficulty fields with defaults', () => {
    // Older app build wrote only lfr; new build expects all four difficulties.
    const stored = {
      raids: {
        voidspire: { lfr: false } as ContentPrefs['raids']['voidspire'],
      },
    } as Partial<ContentPrefs>;
    const merged = mergeContentPrefs(stored);
    expect(merged.raids.voidspire).toEqual({
      lfr: false,
      normal: true,
      heroic: true,
      mythic: true,
    });
  });

  it('preserves mplus overrides', () => {
    const merged = mergeContentPrefs({ mplus: { enabled: false, max_level: 5 } });
    expect(merged.mplus).toEqual({ enabled: false, max_level: 5 });
    // world untouched
    expect(merged.world).toEqual(CONTENT_PREFS_DEFAULTS.world);
  });

  it('preserves world overrides', () => {
    const merged = mergeContentPrefs({
      world: { enabled: false, max_delve_tier: 4, max_ritual_tier: 2 },
    });
    expect(merged.world).toEqual({
      enabled: false,
      max_delve_tier: 4,
      max_ritual_tier: 2,
    });
    // raids untouched
    expect(merged.raids).toEqual(CONTENT_PREFS_DEFAULTS.raids);
  });

  it('fills in missing world fields with defaults', () => {
    const merged = mergeContentPrefs({
      world: { enabled: false } as ContentPrefs['world'],
    });
    expect(merged.world).toEqual({
      enabled: false,
      max_delve_tier: 11,
      max_ritual_tier: 5,
    });
  });
});
