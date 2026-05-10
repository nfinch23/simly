/**
 * Parse a SimulationCraft addon export string into a typed gear pool.
 *
 * The export looks like:
 *
 *   # Felfriend - Demonology - 2026-05-02 12:57 - US/Zul'jin
 *   ...
 *   warlock="Felfriend"
 *   level=90
 *   spec=demonology
 *
 *   # Abyssal Immolator's Smoldering Flames (272)
 *   head=,id=250042,bonus_id=6652/12801/13534/13440/13338/13575/3157
 *   ...
 *
 *   ### Gear from Bags
 *   #
 *   # Lightbinder Shoulderguards (272)
 *   # shoulder=,id=258578,bonus_id=12801/13440/6652/13577/12699
 *   ...
 *
 * Each item line has:
 *   <slot>=,id=<id>,bonus_id=<a/b/c>[,crafted_stats=<x/y>][,crafting_quality=<n>][,drop_level=<n>]
 *
 * The comment line directly above each item gives the human-readable
 * name and item level: `# <Name> (<ilvl>)`.
 *
 * Bag items are the same shape but commented out, gated by the
 * `### Gear from Bags` section header.
 *
 * What we surface is the minimum Phase 4d needs: per-slot pool of
 * equipped + bag items with stable identity hashes for the ignore list.
 * Talents, professions, currencies, etc. are skipped — they fall through
 * to the raw profile string, which still drives the sim.
 */

export type SlotName =
  | 'head'
  | 'neck'
  | 'shoulder'
  | 'back'
  | 'chest'
  | 'wrist'
  | 'hands'
  | 'waist'
  | 'legs'
  | 'feet'
  | 'finger1'
  | 'finger2'
  | 'trinket1'
  | 'trinket2'
  | 'main_hand'
  | 'off_hand'
  | 'ranged'
  | 'tabard'
  | 'shirt';

const KNOWN_SLOTS: ReadonlySet<string> = new Set<SlotName>([
  'head',
  'neck',
  'shoulder',
  'back',
  'chest',
  'wrist',
  'hands',
  'waist',
  'legs',
  'feet',
  'finger1',
  'finger2',
  'trinket1',
  'trinket2',
  'main_hand',
  'off_hand',
  'ranged',
  'tabard',
  'shirt',
]);

export interface ParsedItem {
  /** Slot the addon emitted the line for. Rings/trinkets carry their numbered slot (finger1/finger2). */
  slot: SlotName;
  /** Item ID — the integer after `id=`. */
  item_id: number;
  /** Human-readable name from the `# <Name> (<ilvl>)` line, or empty if missing. */
  name: string;
  /** Item level from the `# <Name> (<ilvl>)` line, or 0 if missing. */
  ilvl: number;
  /** Bonus IDs from `bonus_id=a/b/c`. Empty array if absent. */
  bonus_ids: number[];
  /** Optional `crafted_stats=x/y`. */
  crafted_stats?: number[];
  /** Optional `crafting_quality=N`. */
  crafting_quality?: number;
  /** Optional `drop_level=N`. */
  drop_level?: number;
  /** True if the line was uncommented (equipped). False = bag item. */
  is_equipped: boolean;
  /** Stable identity used by the ignore list — same item upgraded with crests gets a new identity (different bonus_ids). */
  identity: string;
  /** Other key=value pairs we don't yet model, kept for round-trip-ish completeness. */
  extras: Record<string, string>;
  /**
   * Per-item raw stat block, parsed from the addon-emitted `simly_stats=`
   * line. Raw = pre-buff (the values shown in the WoW item tooltip).
   * SimC's stat-weights are computed at the buffed-actor level by adding
   * +1 to a raw stat and measuring the DPS change, so `raw_delta × weight`
   * is a precise DPS-gain prediction without needing to convert to buffed.
   * Undefined when the addon didn't emit stats (older addon version, cache miss).
   */
  raw_stats?: ItemRawStats;
}

/**
 * Per-item raw stats parsed from the addon's `simly_stats=` annotation.
 * Pre-buff values; matches what GetItemStats() returns in the WoW client.
 */
export interface ItemRawStats {
  intellect: number;
  strength: number;
  agility: number;
  haste_rating: number;
  crit_rating: number;
  mastery_rating: number;
  versatility_rating: number;
}

export interface ParsedCharacter {
  /** "warlock" / "mage" / etc. — the leading class= line, lowercase. */
  class: string;
  name?: string;
  level?: number;
  race?: string;
  region?: string;
  server?: string;
  spec?: string;
  role?: string;
}

export interface ParsedExport {
  character: ParsedCharacter;
  /** All equipped items (everything outside the bags section that has a slot= line). */
  equipped: ParsedItem[];
  /** All items found under `### Gear from Bags`. */
  bag: ParsedItem[];
  /** Equipped + bag merged, grouped by slot. Useful for "what can I equip in this slot?" queries. */
  poolBySlot: Record<SlotName, ParsedItem[]>;
}

/** Top-level entry point. */
export function parseSimcExport(source: string): ParsedExport {
  const lines = source.split(/\r?\n/);
  const character = parseCharacterHeader(lines);
  const bagsHeaderIdx = lines.findIndex((l) => /^###\s*Gear from Bags/i.test(l));

  const equipped: ParsedItem[] = [];
  const bag: ParsedItem[] = [];

  const equippedEnd = bagsHeaderIdx >= 0 ? bagsHeaderIdx : lines.length;
  for (let i = 0; i < equippedEnd; i++) {
    const item = tryParseItemLine(lines[i]!, false, lines, i);
    if (item) equipped.push(item);
  }

  if (bagsHeaderIdx >= 0) {
    for (let i = bagsHeaderIdx + 1; i < lines.length; i++) {
      const item = tryParseItemLine(lines[i]!, true, lines, i);
      if (item) bag.push(item);
    }
  }

  const poolBySlot = buildPoolBySlot(equipped, bag);
  return { character, equipped, bag, poolBySlot };
}

function parseCharacterHeader(lines: string[]): ParsedCharacter {
  const out: ParsedCharacter = { class: '' };
  for (const line of lines) {
    if (line.startsWith('#') || line.trim() === '') continue;

    const classMatch = line.match(/^([a-z_]+)="([^"]*)"\s*$/);
    if (classMatch && KNOWN_CLASSES.has(classMatch[1]!)) {
      out.class = classMatch[1]!;
      out.name = classMatch[2]!;
      continue;
    }

    const kv = line.match(/^([a-z_]+)=(.*)$/);
    if (!kv) continue;
    const key = kv[1]!;
    const value = kv[2]!.trim();
    switch (key) {
      case 'level':
        out.level = Number(value);
        break;
      case 'race':
        out.race = value;
        break;
      case 'region':
        out.region = value;
        break;
      case 'server':
        out.server = value;
        break;
      case 'spec':
        out.spec = value;
        break;
      case 'role':
        out.role = value;
        break;
    }

    // Stop scanning the header once we hit any item line; everything
    // we care about for `character` lives above the gear list.
    if (KNOWN_SLOTS.has(key)) break;
  }
  return out;
}

const KNOWN_CLASSES: ReadonlySet<string> = new Set([
  'death_knight',
  'demon_hunter',
  'druid',
  'evoker',
  'hunter',
  'mage',
  'monk',
  'paladin',
  'priest',
  'rogue',
  'shaman',
  'warlock',
  'warrior',
]);

/**
 * Try to parse `line` as an item line. `expectComment` switches between
 * the equipped form (no leading `#`) and the bag form (leading `# `).
 *
 * `lines` and `idx` are passed so we can look at the line above this one
 * for the `# <Name> (<ilvl>)` annotation.
 */
function tryParseItemLine(
  line: string,
  expectComment: boolean,
  lines: string[],
  idx: number,
): ParsedItem | undefined {
  // Strip optional leading `# ` if we're in bag mode; reject if we're
  // in equipped mode and the line is commented (avoids false positives
  // on commented-out alt loadouts in the equipped section).
  let body = line;
  if (expectComment) {
    const stripped = line.match(/^#\s+(.*)$/);
    if (!stripped) return undefined;
    body = stripped[1]!;
  } else {
    if (line.startsWith('#')) return undefined;
  }

  const m = body.match(/^([a-z_][a-z0-9_]*)=,id=(\d+)(.*)$/i);
  if (!m) return undefined;
  const slot = m[1]! as SlotName;
  if (!KNOWN_SLOTS.has(slot)) return undefined;
  const item_id = Number(m[2]!);
  const rest = m[3]!;

  const extras: Record<string, string> = {};
  const known = new Set(['bonus_id', 'crafted_stats', 'crafting_quality', 'drop_level', 'simly_stats']);
  let bonus_ids: number[] = [];
  let crafted_stats: number[] | undefined;
  let crafting_quality: number | undefined;
  let drop_level: number | undefined;
  let raw_stats: ItemRawStats | undefined;

  // Split on `,` — the rest looks like `,key=value,key=value,...`. The
  // very first char is the leading comma when present; ignore empty
  // tokens.
  for (const token of rest.split(',')) {
    const t = token.trim();
    if (t.length === 0) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const key = t.slice(0, eq);
    const value = t.slice(eq + 1);
    if (known.has(key)) {
      switch (key) {
        case 'bonus_id':
          bonus_ids = value.split('/').map((s) => Number(s)).filter((n) => Number.isFinite(n));
          break;
        case 'crafted_stats':
          crafted_stats = value.split('/').map((s) => Number(s)).filter((n) => Number.isFinite(n));
          break;
        case 'crafting_quality':
          crafting_quality = Number(value);
          break;
        case 'drop_level':
          drop_level = Number(value);
          break;
        case 'simly_stats':
          raw_stats = parseSimlyStats(value);
          break;
      }
    } else {
      extras[key] = value;
    }
  }

  // Look at the line above this one for the human-readable name + ilvl.
  let name = '';
  let ilvl = 0;
  if (idx > 0) {
    const prev = lines[idx - 1]!;
    const named = prev.match(/^#\s+(.+?)\s+\((\d+)\)\s*$/);
    if (named) {
      name = named[1]!.trim();
      ilvl = Number(named[2]!);
    }
  }

  return {
    slot,
    item_id,
    name,
    ilvl,
    bonus_ids,
    crafted_stats,
    crafting_quality,
    drop_level,
    is_equipped: !expectComment,
    identity: makeItemIdentity(item_id, bonus_ids, crafted_stats),
    extras,
    raw_stats,
  };
}

/**
 * Parse the addon's `simly_stats=int=N/str=N/agi=N/haste=N/crit=N/mast=N/vers=N`
 * value into an ItemRawStats. Missing fields default to 0. Returns
 * undefined if the value is malformed.
 *
 * Inner delimiter is `/` (not `,`) so SimC's comma-as-field-separator
 * doesn't chop the value at the first internal comma — same convention
 * `bonus_id=` uses. Falls back to comma-split for backward compat with
 * the original (broken) format if any old exports linger.
 */
export function parseSimlyStats(value: string): ItemRawStats | undefined {
  const out: ItemRawStats = {
    intellect: 0,
    strength: 0,
    agility: 0,
    haste_rating: 0,
    crit_rating: 0,
    mastery_rating: 0,
    versatility_rating: 0,
  };
  let sawAny = false;
  // Prefer slash-delimited (current); fall back to comma-delimited (legacy).
  const tokens = value.includes('/') ? value.split('/') : value.split(',');
  for (const token of tokens) {
    const t = token.trim();
    if (t.length === 0) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const key = t.slice(0, eq);
    const num = Number(t.slice(eq + 1));
    if (!Number.isFinite(num)) continue;
    switch (key) {
      case 'int': out.intellect = num; sawAny = true; break;
      case 'str': out.strength = num; sawAny = true; break;
      case 'agi': out.agility = num; sawAny = true; break;
      case 'haste': out.haste_rating = num; sawAny = true; break;
      case 'crit': out.crit_rating = num; sawAny = true; break;
      case 'mast': out.mastery_rating = num; sawAny = true; break;
      case 'vers': out.versatility_rating = num; sawAny = true; break;
    }
  }
  return sawAny ? out : undefined;
}

/**
 * Stable item identity hash. Sorts bonus_ids so order doesn't matter.
 * Includes crafted_stats since it materially changes the item. Same
 * physical item upgraded with crests gets new bonus_ids → new identity,
 * which is what we want for the ignore list ("upgraded item is fresh").
 */
export function makeItemIdentity(
  item_id: number,
  bonus_ids: readonly number[],
  crafted_stats: readonly number[] | undefined,
): string {
  const bonuses = [...bonus_ids].sort((a, b) => a - b).join('/');
  const crafted = crafted_stats?.length ? crafted_stats.slice().sort((a, b) => a - b).join('/') : '';
  return `${item_id}:${bonuses}:${crafted}`;
}

function buildPoolBySlot(
  equipped: readonly ParsedItem[],
  bag: readonly ParsedItem[],
): Record<SlotName, ParsedItem[]> {
  const out = {} as Record<SlotName, ParsedItem[]>;
  for (const item of [...equipped, ...bag]) {
    const list = out[item.slot] ?? (out[item.slot] = []);
    list.push(item);
  }
  return out;
}

/**
 * Render a parsed item back to a SimC `<slot>=,id=...,bonus_id=...`
 * line. Used by the trinket pre-scan and gear ladder to inject items
 * into profileset bodies. `slotOverride` lets callers force a specific
 * slot (the addon emits both finger1 / finger2 for ring drops, but
 * for sim purposes either slot accepts the item — caller picks).
 */
export function formatItemLine(item: ParsedItem, slotOverride?: SlotName): string {
  const slot = slotOverride ?? item.slot;
  const parts: string[] = [`${slot}=,id=${item.item_id}`];
  if (item.bonus_ids.length > 0) {
    parts.push(`bonus_id=${item.bonus_ids.join('/')}`);
  }
  if (item.crafted_stats?.length) {
    parts.push(`crafted_stats=${item.crafted_stats.join('/')}`);
  }
  if (item.crafting_quality !== undefined) {
    parts.push(`crafting_quality=${item.crafting_quality}`);
  }
  if (item.drop_level !== undefined) {
    parts.push(`drop_level=${item.drop_level}`);
  }
  return parts.join(',');
}

/**
 * Pull the unique trinket pool from a parsed export. Both trinket1 and
 * trinket2 lists are merged and deduped by identity — same trinket may
 * appear in both lists since the addon emits whatever slot it found
 * the item in. Different ilvl variants of the same trinket are kept
 * separate (different bonus_ids = different identity).
 */
export function getTrinketPool(parsed: ParsedExport): ParsedItem[] {
  const all = [
    ...(parsed.poolBySlot.trinket1 ?? []),
    ...(parsed.poolBySlot.trinket2 ?? []),
  ];
  const byIdentity = new Map<string, ParsedItem>();
  for (const t of all) {
    if (!byIdentity.has(t.identity)) byIdentity.set(t.identity, t);
  }
  return Array.from(byIdentity.values());
}

/**
 * Generate all unordered pairs of items from `arr` (n choose 2). Used
 * by the trinket and ring pre-scans. Yields tuples in stable order:
 * (arr[i], arr[j]) where i < j.
 */
export function* allUnorderedPairs<T>(arr: readonly T[]): Generator<[T, T]> {
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) {
      yield [arr[i]!, arr[j]!];
    }
  }
}
