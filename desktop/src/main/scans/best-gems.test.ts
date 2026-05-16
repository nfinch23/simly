import { describe, expect, it } from 'vitest';
import type { ParsedExport, ParsedItem } from '../simc-export-parser';
import type { SimcRunResult } from '../simc-runner';
import {
  buildGemsProfilesetLines,
  GEM_CANDIDATES,
  parseBestGems,
  pickWinningGemItemId,
  rewriteItemGems,
  synthesizeItemLine,
} from './best-gems';

function mkRun(profilesets: Array<{ name: string; mean: number }>): SimcRunResult {
  return {
    simcVersion: '1205-01',
    gitRevision: 'd6f091a0000000000000000000000000',
    buildDate: '2026-04-30',
    profilesets: profilesets.map((p) => ({
      name: p.name,
      mean: p.mean,
      stddev: 10,
      iterations: 1000,
    })),
    rawJsonPath: '/tmp/fake.json',
    rawJson: {},
  };
}

function mkItem(slot: ParsedItem['slot'], gemIdRaw: string | undefined, overrides: Partial<ParsedItem> = {}): ParsedItem {
  return {
    slot,
    item_id: 250060,
    name: 'Item',
    ilvl: 280,
    bonus_ids: [1, 2, 3],
    is_equipped: true,
    identity: `${slot}-id`,
    extras: gemIdRaw !== undefined ? { gem_id: gemIdRaw } : {},
    ...overrides,
  };
}

function mkExport(equipped: ParsedItem[]): ParsedExport {
  return {
    character: { class: 'mage' },
    equipped,
    bag: [],
    poolBySlot: {} as ParsedExport['poolBySlot'],
    equipped_talents: null,
    saved_loadouts: [],
  };
}

describe('GEM_CANDIDATES (loaded from data/gems.json)', () => {
  it('contains at least the 6 unique two-stat combinations', () => {
    // 4-choose-2 = 6 distinct stat pairs; each pair has 2 orientations
    // (primary/secondary) for 12 distinct gem allocations.
    expect(GEM_CANDIDATES.length).toBeGreaterThanOrEqual(6);
  });

  it('every candidate has a positive item_id', () => {
    for (const c of GEM_CANDIDATES) {
      expect(c.item_id).toBeGreaterThan(0);
    }
  });

  it('every candidate is two-stat (decoded from SimC data)', () => {
    for (const c of GEM_CANDIDATES) {
      expect(c.stats).toHaveLength(2);
    }
  });

  it('candidate name includes the stat decode in parens', () => {
    for (const c of GEM_CANDIDATES) {
      expect(c.name).toMatch(/\(.+ \+ .+\)/);
    }
  });
});

describe('rewriteItemGems', () => {
  it('replaces a single gem_id', () => {
    const line = 'head=,id=250060,gem_id=240983,bonus_id=1/2/3';
    expect(rewriteItemGems(line, 240900)).toBe(
      'head=,id=250060,gem_id=240900,bonus_id=1/2/3',
    );
  });

  it('preserves socket count for multi-socket items', () => {
    const line = 'trinket1=,id=12345,gem_id=240906/240906/240900,bonus_id=1';
    expect(rewriteItemGems(line, 240898)).toBe(
      'trinket1=,id=12345,gem_id=240898/240898/240898,bonus_id=1',
    );
  });

  it('returns undefined when the line has no gem_id', () => {
    expect(rewriteItemGems('back=,id=999,bonus_id=1/2', 240900)).toBeUndefined();
  });
});

describe('synthesizeItemLine', () => {
  it('emits gem_id with socket count derived from extras.gem_id', () => {
    const item = mkItem('finger1', '240983');
    const out = synthesizeItemLine(item, 240900);
    expect(out).toContain('gem_id=240900');
    expect(out).not.toContain('240900/');
  });

  it('repeats gem_id for multi-socket items', () => {
    const item = mkItem('trinket1', '240906/240906/240900');
    const out = synthesizeItemLine(item, 240898);
    expect(out).toContain('gem_id=240898/240898/240898');
  });

  it('preserves bonus_id + crafted_stats + enchant_id from the original item', () => {
    const item = mkItem('neck', '240898', {
      bonus_ids: [12214, 13667],
      crafted_stats: [32, 40],
      crafting_quality: 5,
      extras: { gem_id: '240898', enchant_id: '7967' },
    });
    const out = synthesizeItemLine(item, 240900);
    expect(out).toContain('bonus_id=12214/13667');
    expect(out).toContain('crafted_stats=32/40');
    expect(out).toContain('crafting_quality=5');
    expect(out).toContain('enchant_id=7967');
  });
});

describe('buildGemsProfilesetLines', () => {
  it('returns empty string when the player has no socketed items', () => {
    const xport = mkExport([mkItem('back', undefined), mkItem('chest', undefined)]);
    expect(buildGemsProfilesetLines(xport)).toBe('');
  });

  it('emits one profileset block per candidate × socketed item', () => {
    const xport = mkExport([
      mkItem('finger1', '240983'),
      mkItem('finger2', '240898'),
      mkItem('back', undefined), // no sockets — skipped
    ]);
    const out = buildGemsProfilesetLines(xport);
    const lines = out.split('\n');
    // N candidates × 2 socketed items.
    expect(lines).toHaveLength(GEM_CANDIDATES.length * 2);
    for (const candidate of GEM_CANDIDATES) {
      expect(out).toContain(`profileset."gems_${candidate.key}"+="finger1`);
      expect(out).toContain(`profileset."gems_${candidate.key}"+="finger2`);
    }
  });

  it('does not touch the bonus_id of unrelated items', () => {
    const xport = mkExport([
      mkItem('neck', '240898', { bonus_ids: [12214, 13667] }),
    ]);
    const out = buildGemsProfilesetLines(xport);
    expect(out).toContain('bonus_id=12214/13667');
  });
});

describe('parseBestGems', () => {
  it('picks the highest mean DPS as the winner', () => {
    // Use whatever the first two candidates' keys actually are at
    // load time — keeps the test resilient to data updates.
    const c1 = GEM_CANDIDATES[0]!;
    const c2 = GEM_CANDIDATES[1]!;
    const run = mkRun([
      { name: `gems_${c1.key}`, mean: 640 },
      { name: `gems_${c2.key}`, mean: 700 },
    ]);
    const result = parseBestGems(run);
    expect(result?.best.name).toBe(c2.name);
    expect(result?.best.dps).toBe(700);
  });

  it('returns undefined when no profilesets match known gem keys', () => {
    expect(parseBestGems(mkRun([{ name: 'flask_magisters', mean: 9999 }]))).toBeUndefined();
  });
});

describe('pickWinningGemItemId', () => {
  it("returns the winner's item_id", () => {
    const c1 = GEM_CANDIDATES[0]!;
    const c2 = GEM_CANDIDATES[1]!;
    const run = mkRun([
      { name: `gems_${c1.key}`, mean: 640 },
      { name: `gems_${c2.key}`, mean: 700 },
    ]);
    expect(pickWinningGemItemId(run)).toBe(c2.item_id);
  });
});
