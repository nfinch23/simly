import { describe, expect, it } from 'vitest';
import { getItemName, getNameCoverage, hasItemName } from './item-names';

describe('item-names', () => {
  it('resolves known M+/raid loot to real names (sourced from SimC item_data.inc)', () => {
    // 251085 = Mantle of Dark Devotion (shoulder, from raids.json mythic pool).
    // Anchor a few items to catch a regression if regen drops them.
    const known: Record<number, string> = {
      251085: 'Mantle of Dark Devotion',
      251120: 'Wraps of Umbral Descent',
      249343: 'Gaze of the Alnseer',
    };
    for (const [id, expected] of Object.entries(known)) {
      expect(getItemName(Number(id))).toBe(expected);
    }
  });

  it('returns "Item #<id>" fallback for ids missing from item_data.inc', () => {
    // 1 is reserved / dummy; not in our pools and not in item_data.inc.
    expect(getItemName(1)).toBe('Item #1');
    expect(getItemName(99999999)).toBe('Item #99999999');
  });

  it('hasItemName correctly discriminates real vs fallback', () => {
    expect(hasItemName(251085)).toBe(true);
    expect(hasItemName(99999999)).toBe(false);
  });

  it('getNameCoverage surfaces the data file metadata', () => {
    const c = getNameCoverage();
    expect(c.count).toBeGreaterThan(200);
    expect(c.source).toContain('simulationcraft/simc');
  });
});
