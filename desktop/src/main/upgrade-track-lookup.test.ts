import { describe, expect, it } from 'vitest';
import {
  detectItemTrack,
  nextRankIn,
  rewriteToNextRank,
} from './upgrade-track-lookup';

describe('detectItemTrack', () => {
  it("identifies felfriend's head as Myth track rank 1 (bonus_id 12801, ilvl 272)", () => {
    // Real fixture from desktop/src/main/__fixtures__/felfriend-export.simc:
    //   head=,id=250042,bonus_id=6652/12801/13534/13440/13338/13575/3157
    // 12801 is the upgrade-track marker (greatvault rank 1 = 272 ilvl).
    // Other bonus_ids encode source (6652), stat allocation (13338/13575),
    // and item context (13440/13534/3157) — none are track markers.
    const pos = detectItemTrack([6652, 12801, 13534, 13440, 13338, 13575, 3157]);
    expect(pos).not.toBeNull();
    expect(pos!.category).toBe('dungeon');
    expect(pos!.track).toBe('greatvault');
    expect(pos!.rank).toBe(1);
    expect(pos!.current_ilvl).toBe(272);
  });

  it("identifies a Hero 6/6 item (bonus_id 12798, ilvl 276)", () => {
    const pos = detectItemTrack([6652, 12798, 13440]);
    expect(pos).not.toBeNull();
    expect(pos!.track).toBe('hero');
    expect(pos!.rank).toBe(6);
    expect(pos!.current_ilvl).toBe(276);
  });

  it("identifies a Hero 1/6 item (bonus_id 12793, ilvl 259)", () => {
    const pos = detectItemTrack([12793]);
    expect(pos!.track).toBe('hero');
    expect(pos!.rank).toBe(1);
    expect(pos!.current_ilvl).toBe(259);
  });

  it("identifies a Champion 3/6 (bonus_id 12787, ilvl 253)", () => {
    const pos = detectItemTrack([12787]);
    expect(pos!.track).toBe('champion');
    expect(pos!.rank).toBe(3);
    expect(pos!.current_ilvl).toBe(253);
  });

  it('identifies a Mythic-raid 6/6 (12806 → 289 ilvl, Greatvault/Myth)', () => {
    const pos = detectItemTrack([12806]);
    expect(pos!.current_ilvl).toBe(289);
    expect(pos!.rank).toBe(6);
  });

  it('returns null when no bonus_id is a known track marker', () => {
    // 6652, 13440, 13577 etc. are non-track bonus_ids (item sources, stat allocs).
    const pos = detectItemTrack([6652, 13440, 13577, 3157]);
    expect(pos).toBeNull();
  });

  it('returns null for an empty bonus_ids list', () => {
    expect(detectItemTrack([])).toBeNull();
  });
});

describe('nextRankIn', () => {
  it('returns +1 rank within a track (Champion 4 → 5)', () => {
    const pos = detectItemTrack([12788])!; // Champion rank 4 = 256
    const next = nextRankIn(pos);
    expect(next).not.toBeNull();
    expect(next!.ilvl).toBe(259); // Champion rank 5
    expect(next!.bonus_id).toBe(12789);
  });

  it('returns null when item is at the track ceiling (Champion 6/6)', () => {
    const pos = detectItemTrack([12790])!;
    expect(nextRankIn(pos)).toBeNull();
  });

  it('the per-rank delta is small (3-4 ilvl), not +13', () => {
    // Champion ranks: 246, 250, 253, 256, 259, 263 — deltas: 4, 3, 3, 3, 4
    const pos = detectItemTrack([12785])!; // rank 1, ilvl 246
    const next = nextRankIn(pos)!;
    expect(next.ilvl - pos.current_ilvl).toBe(4); // 250 - 246
  });
});

describe('rewriteToNextRank', () => {
  it("swaps the rank's bonus_id and preserves others", () => {
    const result = rewriteToNextRank([6652, 12787, 13577, 3157])!;
    expect(result.position.track).toBe('champion');
    expect(result.position.rank).toBe(3);
    expect(result.next.bonus_id).toBe(12788); // Champion rank 4
    expect(result.next.ilvl).toBe(256);
    expect(result.bonus_ids).toEqual([6652, 12788, 13577, 3157]);
  });

  it('returns null when item is at the ceiling', () => {
    expect(rewriteToNextRank([12790])).toBeNull(); // Champion 6/6
    expect(rewriteToNextRank([12798])).toBeNull(); // Hero 6/6
    expect(rewriteToNextRank([12806])).toBeNull(); // Myth 6/6
  });

  it('returns null when no track marker is present', () => {
    expect(rewriteToNextRank([6652, 13440])).toBeNull();
  });
});
