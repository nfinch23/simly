/**
 * Phase 7 — upgrade track lookup.
 *
 * Given a parsed item's bonus_ids, find which upgrade track it sits in
 * and at which rank (1..6). Used to translate "this item is at 4/6" into
 * "the +1 rank is at ilvl <N>" for the upgrade-priority scan, replacing
 * the original +13-ilvl approximation with the real per-rank delta from
 * `data/upgrade-tracks.json`.
 *
 * Real ilvl gain per rank is typically +3 or +4 within a track — the
 * +13 figure was the gap BETWEEN tracks (Champion 6/6 → Hero 6/6), not
 * within. The approximation was over-projecting upgrade gains 3-4×.
 *
 * Caveats:
 * - Crafted items, world-quest rewards, and other non-track sources
 *   will return null. Callers fall back gracefully.
 * - When an item is at rank 6/6 (the track's ceiling), there's no
 *   "+1 rank" — callers should skip these.
 */
import tracksData from '../../../data/upgrade-tracks.json';

export type TrackCategory = 'dungeon' | 'raid';

/** A single rank within an upgrade track. */
export interface TrackRank {
  bonus_id: number;
  ilvl: number;
}

/** An item's resolved position within an upgrade track. */
export interface ItemTrackPosition {
  category: TrackCategory;
  track: string;
  rank: number; // 1-based; 1 = lowest, 6 = ceiling
  current_bonus_id: number;
  current_ilvl: number;
  /** All ranks in the track, ordered from lowest to highest. */
  all_ranks: TrackRank[];
}

interface TrackEntry {
  category: TrackCategory;
  trackName: string;
  ranks: TrackRank[];
  /** bonus_id → 1-based rank for this track. */
  rankByBonusId: Map<number, number>;
}

let _index: Map<number, TrackEntry[]> | null = null;
let _trackByName: Map<string, TrackEntry> | null = null;

/**
 * Build an index from bonus_id → list of (track, rank) entries that
 * contain it. Most upgrade-track bonus_ids are unique to a single track,
 * but the index is a list to be defensive — KeystoneLoot's data may
 * reuse bonus_ids across categories in edge cases.
 */
function buildIndex(): { byBonusId: Map<number, TrackEntry[]>; byName: Map<string, TrackEntry> } {
  const byBonusId = new Map<number, TrackEntry[]>();
  const byName = new Map<string, TrackEntry>();

  for (const category of ['dungeon', 'raid'] as const) {
    const cat = (tracksData.tracks as Record<string, Record<string, TrackRank[]>>)[category];
    if (!cat) continue;
    for (const [trackName, ranks] of Object.entries(cat)) {
      if (!Array.isArray(ranks) || ranks.length === 0) continue;
      const rankByBonusId = new Map<number, number>();
      ranks.forEach((r, i) => {
        rankByBonusId.set(r.bonus_id, i + 1);
      });
      const entry: TrackEntry = { category, trackName, ranks, rankByBonusId };
      byName.set(`${category}:${trackName}`, entry);
      for (const r of ranks) {
        const list = byBonusId.get(r.bonus_id);
        if (list) list.push(entry);
        else byBonusId.set(r.bonus_id, [entry]);
      }
    }
  }
  return { byBonusId, byName };
}

function index(): Map<number, TrackEntry[]> {
  if (_index === null) {
    const { byBonusId, byName } = buildIndex();
    _index = byBonusId;
    _trackByName = byName;
  }
  return _index;
}

/**
 * Find which upgrade track + rank an item is currently at. Scans its
 * bonus_ids and returns the first match found in the upgrade-tracks
 * index. Returns null when the item has no recognizable track marker
 * (typical for crafted gear, world quests, very old items).
 *
 * When multiple bonus_ids on the same item match upgrade tracks (rare,
 * possibly never happens in practice — kept for defensiveness), the
 * first match wins. Order of `bonus_ids` is preserved from the SimC
 * export, which mirrors WoW's bonus_id ordering.
 */
export function detectItemTrack(bonus_ids: number[]): ItemTrackPosition | null {
  const idx = index();
  for (const bid of bonus_ids) {
    const tracks = idx.get(bid);
    if (!tracks || tracks.length === 0) continue;
    const t = tracks[0]!;
    const rank = t.rankByBonusId.get(bid)!;
    const rankEntry = t.ranks[rank - 1]!;
    return {
      category: t.category,
      track: t.trackName,
      rank,
      current_bonus_id: bid,
      current_ilvl: rankEntry.ilvl,
      all_ranks: t.ranks,
    };
  }
  return null;
}

/**
 * Return the next rank's `{bonus_id, ilvl}` for the given item position,
 * or null when the item is already at the track's ceiling (rank ===
 * ranks.length). The ilvl delta is read directly from the track data —
 * typically +3 or +4 within a track.
 */
export function nextRankIn(position: ItemTrackPosition): TrackRank | null {
  if (position.rank >= position.all_ranks.length) return null;
  return position.all_ranks[position.rank]!; // 0-based: ranks[rank] is the (rank+1)-th
}

/**
 * Rewrite an item's `bonus_ids` list to the next-rank bonus_id within
 * the same track. The current-rank bonus_id is replaced; all other
 * bonus_ids (which encode source, stat allocation, etc.) are preserved.
 * Returns null when no upgrade is possible (item at max rank, or no
 * track detected).
 */
export function rewriteToNextRank(bonus_ids: number[]): {
  bonus_ids: number[];
  position: ItemTrackPosition;
  next: TrackRank;
} | null {
  const position = detectItemTrack(bonus_ids);
  if (!position) return null;
  const next = nextRankIn(position);
  if (!next) return null;
  const rewritten = bonus_ids.map((b) =>
    b === position.current_bonus_id ? next.bonus_id : b,
  );
  return { bonus_ids: rewritten, position, next };
}

/** Test-only: reset cached indices. */
export function _resetIndexForTests(): void {
  _index = null;
  _trackByName = null;
}
