/**
 * Phase 7 — content pool resolver.
 *
 * Given the user's `contentPrefs` (which content they're willing to run),
 * their class/spec, and the static KeystoneLoot data, return the list of
 * candidate items that could drop for them — with each item's projected
 * max-upgrade ilvl (v1 still assumes infinite crests).
 *
 * The `best_content` scan consumes the output: for each candidate it
 * sims a profileset where the candidate's slot is overridden with
 * `id=<itemId>,ilevel=<targetIlvl>`, then ranks by ΔDPS vs baseline.
 *
 * No SimC calls live here — this module is pure data filtering, fully
 * unit-testable.
 */
import dungeonsData from '../../../data/dungeons.json';
import raidsData from '../../../data/raids.json';
import itemsData from '../../../data/items.json';
import tracksData from '../../../data/upgrade-tracks.json';
import keystoneData from '../../../data/keystone-mapping.json';
import type { ContentPrefs } from './settings';

// ---------------------------------------------------------------------------
// Static reference data
// ---------------------------------------------------------------------------

/**
 * SimC class string → WoW classId (matches KeystoneLoot's `classes` keys).
 * The SimC export emits class names lowercase as `warrior=, paladin=, …`.
 */
export const CLASS_ID_BY_NAME: Readonly<Record<string, number>> = {
  warrior: 1,
  paladin: 2,
  hunter: 3,
  rogue: 4,
  priest: 5,
  deathknight: 6,
  death_knight: 6,
  shaman: 7,
  mage: 8,
  warlock: 9,
  monk: 10,
  druid: 11,
  demonhunter: 12,
  demon_hunter: 12,
  evoker: 13,
};

/**
 * SimC spec key → Blizzard specId. SimC stores spec as `spec=demonology`
 * (lowercased one word). Same name space as `specialization=`.
 *
 * Source: the spec IDs from WoW's `GetSpecializationInfo` map directly to
 * KeystoneLoot's `classes[classId] = [specId...]` arrays. Hardcoded
 * because there are ~40 of them and they don't change between patches.
 */
export const SPEC_ID_BY_KEY: Readonly<Record<string, number>> = {
  // Warrior
  arms: 71,
  fury: 72,
  protection_warrior: 73,
  // Paladin
  holy_paladin: 65,
  protection_paladin: 66,
  retribution: 70,
  // Hunter
  beast_mastery: 253,
  marksmanship: 254,
  survival: 255,
  // Rogue
  assassination: 259,
  outlaw: 260,
  subtlety: 261,
  // Priest
  discipline: 256,
  holy_priest: 257,
  shadow: 258,
  // Death Knight
  blood: 250,
  frost_dk: 251,
  unholy: 252,
  // Shaman
  elemental: 262,
  enhancement: 263,
  restoration_shaman: 264,
  // Mage
  arcane: 62,
  fire: 63,
  frost: 64,
  // Warlock
  affliction: 265,
  demonology: 266,
  destruction: 267,
  // Monk
  brewmaster: 268,
  mistweaver: 270,
  windwalker: 269,
  // Druid
  balance: 102,
  feral: 103,
  guardian: 104,
  restoration_druid: 105,
  // Demon Hunter
  havoc: 577,
  vengeance: 581,
  aldrachi_reaver: 1480, // currently unused per KeystoneLoot data
  // Evoker
  devastation: 1467,
  preservation: 1468,
  augmentation: 1473,
};

/**
 * Some SimC spec strings collide between classes (e.g. `frost` for both
 * mage and DK). Resolve to the variant matching the given classId.
 */
export function resolveSpecId(specRaw: string, classId: number): number | undefined {
  const key = specRaw.toLowerCase().replace(/\s+/g, '_');
  // Disambiguate ambiguous keys by class.
  const disambig: Record<string, Record<number, number>> = {
    holy: { 2: 65, 5: 257 },
    protection: { 1: 73, 2: 66 },
    frost: { 6: 251, 8: 64 },
    restoration: { 7: 264, 11: 105 },
  };
  const byClass = disambig[key];
  if (byClass && byClass[classId]) return byClass[classId];
  return SPEC_ID_BY_KEY[key];
}

// ---------------------------------------------------------------------------
// Data accessors
// ---------------------------------------------------------------------------

type Items = typeof itemsData extends { items: infer I } ? I : never;
type ItemMeta = Items extends Record<string, infer V> ? V : never;

/** Lookup an item's metadata from the items.json table. */
export function getItemMeta(itemId: number): ItemMeta | undefined {
  return (itemsData.items as Record<string, ItemMeta>)[String(itemId)];
}

/**
 * True if an item is class+spec relevant per KeystoneLoot's classes gating.
 * Items with no spec-list for the player's class are excluded.
 */
export function isItemRelevant(
  itemId: number,
  classId: number,
  specId: number,
): boolean {
  const meta = getItemMeta(itemId);
  if (!meta) return false;
  const classes = meta.classes as Record<string, number[]> | undefined;
  const specs = classes?.[String(classId)];
  if (!Array.isArray(specs)) return false;
  return specs.includes(specId);
}

/**
 * Return the max-upgrade ilvl for a given track name (e.g. 'champion',
 * 'hero', 'greatvault', 'lfr', 'normal', 'heroic', 'mythic'). Pulls the
 * last entry of each track's upgrade list — that's the 6/6 ceiling.
 */
export function maxIlvlForTrack(
  category: 'dungeon' | 'raid',
  trackName: string,
): number | undefined {
  const cat = (tracksData.tracks as Record<string, Record<string, Array<{ ilvl: number; bonus_id: number }>>>)[category];
  const entries = cat?.[trackName];
  if (!Array.isArray(entries) || entries.length === 0) return undefined;
  return entries[entries.length - 1]!.ilvl;
}

// ---------------------------------------------------------------------------
// Candidate resolution
// ---------------------------------------------------------------------------

export interface ContentCandidate {
  item_id: number;
  /** SimC slot name (head, neck, …). Resolved from items.json. Ambiguous slots (finger/trinket) inherit the bare name and the scan picks finger1/trinket1 by default. */
  slot: string;
  /** Projected max-upgrade ilvl from this source. */
  target_ilvl: number;
  /** Human-readable label, e.g. "M+ +10" or "Heroic raid". */
  source_label: string;
  /** Source category for downstream grouping. */
  source_category: 'mplus' | 'raid';
}

export interface ResolveContentOptions {
  prefs: ContentPrefs;
  /** Class name from the SimC export (e.g. "warlock"). */
  className: string;
  /** Spec key from the SimC export (e.g. "demonology"). */
  specKey: string;
}

/**
 * Walk every loot pool enabled in `prefs`, filter to class+spec relevant
 * items, project each to its max-upgrade ilvl. Dedupes across sources by
 * keeping the highest target_ilvl per item_id.
 */
export function resolveContentPool(opts: ResolveContentOptions): ContentCandidate[] {
  const classId = CLASS_ID_BY_NAME[opts.className.toLowerCase()];
  if (!classId) return [];
  const specId = resolveSpecId(opts.specKey, classId);
  if (!specId) return [];

  const byItemId = new Map<number, ContentCandidate>();

  // ── Mythic+ ──────────────────────────────────────────────────────────────
  if (opts.prefs.mplus.enabled) {
    const lvl = clamp(opts.prefs.mplus.max_level, 1, 10);
    const rule = keystoneData.rules.find((r) => r.keystones?.includes(lvl));
    // Use end_of_run (the actual drop, not the great-vault projection) and
    // its track's rank-6 ceiling. v1 assumes infinite crests → max upgrade.
    const trackName = rule?.end_of_run?.track ?? 'hero';
    const ilvl = maxIlvlForTrack('dungeon', trackName);
    if (ilvl !== undefined) {
      for (const dungeon of dungeonsData.dungeons) {
        for (const itemId of dungeon.loot ?? []) {
          if (!isItemRelevant(itemId, classId, specId)) continue;
          mergeCandidate(byItemId, itemId, {
            target_ilvl: ilvl,
            source_label: `M+ +${lvl}`,
            source_category: 'mplus',
          });
        }
      }
    }
  }

  // ── Raids ────────────────────────────────────────────────────────────────
  for (const raid of raidsData.raids) {
    for (const boss of raid.bosses ?? []) {
      for (const [difficulty, items] of Object.entries(boss.loot_by_difficulty ?? {})) {
        if (!isRaidDifficultyEnabled(opts.prefs, difficulty)) continue;
        const ilvl = maxIlvlForTrack('raid', difficulty);
        if (ilvl === undefined) continue;
        for (const itemId of items as number[]) {
          if (!isItemRelevant(itemId, classId, specId)) continue;
          mergeCandidate(byItemId, itemId, {
            target_ilvl: ilvl,
            source_label: `${capitalize(difficulty)} raid`,
            source_category: 'raid',
          });
        }
      }
    }
  }

  return Array.from(byItemId.values()).sort((a, b) => b.target_ilvl - a.target_ilvl);
}

function mergeCandidate(
  map: Map<number, ContentCandidate>,
  itemId: number,
  partial: Pick<ContentCandidate, 'target_ilvl' | 'source_label' | 'source_category'>,
): void {
  const meta = getItemMeta(itemId);
  const slotName = meta?.slot_name;
  // 'other' is KeystoneLoot's catch-all for cosmetic/miscellaneous items
  // (shirts, tabards, etc.) — exclude them from sim candidates since they
  // contribute no stats. Any future slot name we don't recognize is also
  // silently dropped.
  if (!slotName || slotName === 'other') return;
  const prior = map.get(itemId);
  if (prior && prior.target_ilvl >= partial.target_ilvl) return; // keep best source
  map.set(itemId, { item_id: itemId, slot: slotName, ...partial });
}

function isRaidDifficultyEnabled(prefs: ContentPrefs, difficulty: string): boolean {
  const key = difficulty as keyof ContentPrefs['raids'][keyof ContentPrefs['raids']];
  for (const raidId of Object.keys(prefs.raids) as Array<keyof ContentPrefs['raids']>) {
    if (prefs.raids[raidId]?.[key]) return true;
  }
  return false;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}
