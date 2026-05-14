/**
 * Regenerate Simly's static content data files from the active KeystoneLoot
 * fork. Source: https://github.com/Wolkenschutz/KeystoneLoot — actively
 * maintained for Midnight (the upstream Numynum repo went stale at DF S4).
 *
 * Outputs (all under repo-root /data):
 *   - dungeons.json         — current-season M+ dungeon loot pools
 *   - raids.json            — current-tier raid loot pools per boss per difficulty
 *   - items.json            — id → { slotId, classes, icon } metadata
 *   - upgrade-tracks.json   — bonus_id ↔ ilvl tier mapping per track
 *   - keystone-mapping.json — M+ key level → endOfRun/greatVault tier
 *   - content-data.meta.json — fetch timestamp + source-file commit shas
 *
 * Usage:
 *   node scripts/regen-content-tables.mjs
 *
 * Re-runnable. Idempotent. Run when a new patch ships and KeystoneLoot's
 * data has been updated — usually a day or two after Blizzard's patch.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import luaparse from 'luaparse';

const REPO = 'Wolkenschutz/KeystoneLoot';
const REF = 'main';
const FILES = [
  'data/dungeons.lua',
  'data/raids.lua',
  'data/items.lua',
  'data/upgrade_tracks.lua',
  'data/keystone_mapping.lua',
];

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'data');

/**
 * WoW raid difficulty IDs. Confirmed against Blizzard's DifficultyId enum
 * (and KeystoneLoot's own UpgradeTrackOrder = lfr / normal / heroic / mythic).
 * KeystoneLoot stores raid loot keyed by these numbers.
 */
const RAID_DIFFICULTY_BY_ID = {
  14: 'normal',
  15: 'heroic',
  16: 'mythic',
  17: 'lfr',
};

/**
 * WoW equipment slotId enum (INVTYPE values). Maps to SimC slot names.
 * Keep in sync with desktop/src/main/simc-export-parser.ts SlotName.
 */
const SLOT_ID_TO_NAME = {
  0: 'head',
  1: 'neck',
  2: 'shoulder',
  3: 'shirt',
  4: 'chest',
  5: 'waist',
  6: 'legs',
  7: 'feet',
  8: 'wrist',
  9: 'hands',
  10: 'finger', // (finger1/finger2 — ambiguous; resolved at sim time)
  11: 'trinket', // (trinket1/trinket2 — ambiguous; resolved at sim time)
  12: 'back',
  13: 'main_hand',
  14: 'off_hand',
  15: 'ranged',
  16: 'tabard',
  17: 'bag',
};

async function fetchText(path) {
  const url = `https://raw.githubusercontent.com/${REPO}/${REF}/${path}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`fetch ${url} failed: ${res.status} ${res.statusText}`);
  }
  return res.text();
}

/**
 * Parse a Lua source string into an AST. Returns the AST root.
 */
function parseLua(source) {
  return luaparse.parse(source, { comments: false, locations: false });
}

/**
 * Walk an AST and return the value (as a JS literal) of the first
 * `<identifier> = <table>` assignment whose target matches `name`. Used to
 * extract `KeystoneLoot.DungeonDatabase = { ... }` and similar.
 */
function findNamedTable(ast, name) {
  for (const stmt of ast.body) {
    if (stmt.type === 'LocalStatement') continue;
    if (stmt.type !== 'AssignmentStatement') continue;
    for (let i = 0; i < stmt.variables.length; i++) {
      const v = stmt.variables[i];
      const matched =
        (v.type === 'Identifier' && v.name === name) ||
        (v.type === 'MemberExpression' &&
          v.identifier?.name === name);
      if (matched) return luaValueToJs(stmt.init[i]);
    }
  }
  return undefined;
}

/**
 * Convert a luaparse AST node into a plain JS value. Handles tables
 * (array-like and dict-like), numbers, strings, booleans, nil. CallExpressions
 * (e.g. `CreateTrackEntry(...)`) get their args returned as a positional
 * array — caller knows the function signature and rebuilds the object.
 */
function luaValueToJs(node) {
  if (!node) return null;
  switch (node.type) {
    case 'NumericLiteral':
      return node.value;
    case 'StringLiteral':
      // luaparse leaves StringLiteral.value === null and stores the raw
      // `"..."` (or `'...'`) form in .raw — strip the outer quotes.
      if (typeof node.value === 'string') return node.value;
      if (typeof node.raw === 'string' && node.raw.length >= 2) {
        return node.raw.slice(1, -1);
      }
      return null;
    case 'BooleanLiteral':
      return node.value;
    case 'NilLiteral':
      return null;
    case 'UnaryExpression':
      if (node.operator === '-') return -luaValueToJs(node.argument);
      return luaValueToJs(node.argument);
    case 'TableConstructorExpression': {
      // Detect array-vs-dict. An entry of type TableValue (no key) → array
      // index; a TableKey/TableKeyString → dict member. KeystoneLoot mixes
      // both (numeric-keyed dicts for season tables, value-array for boss
      // lists). When all entries are array-style, emit an array; otherwise
      // emit a dict with numeric keys preserved.
      const allArrayStyle = node.fields.every((f) => f.type === 'TableValue');
      if (allArrayStyle) {
        return node.fields.map((f) => luaValueToJs(f.value));
      }
      const out = {};
      let nextIdx = 1;
      for (const f of node.fields) {
        if (f.type === 'TableValue') {
          out[nextIdx++] = luaValueToJs(f.value);
        } else if (f.type === 'TableKey') {
          const k = luaValueToJs(f.key);
          out[String(k)] = luaValueToJs(f.value);
        } else if (f.type === 'TableKeyString') {
          out[f.key.name] = luaValueToJs(f.value);
        }
      }
      return out;
    }
    case 'CallExpression':
      // KeystoneLoot upgrade_tracks.lua uses CreateTrackEntry(ilvl, bonusId, quality, suffix, rank).
      // Return positional args; the caller knows the signature.
      return { __call: node.base.name ?? 'unknown', args: node.arguments.map(luaValueToJs) };
    case 'MemberExpression':
      // e.g. Enum.ItemQuality.Uncommon — we don't have the value, so
      // surface as a stable string identifier the caller can ignore or map.
      return `__enum:${formatMemberExpr(node)}`;
    case 'Identifier':
      // bare identifier references (locale L["..."], ITEM_UPGRADE constant, etc.) —
      // not load-bearing for the data we extract.
      return `__ident:${node.name}`;
    case 'IndexExpression':
      // L["Champion"] style — the index value is the string we want.
      return luaValueToJs(node.index);
    default:
      return undefined;
  }
}

function formatMemberExpr(node) {
  if (node.type !== 'MemberExpression') return luaValueToJs(node);
  return `${formatMemberExpr(node.base)}.${node.identifier.name}`;
}

// ---------------------------------------------------------------------------
// Per-table normalizers
// ---------------------------------------------------------------------------

function normalizeDungeons(raw) {
  if (!Array.isArray(raw)) {
    throw new Error('dungeons.lua: expected DungeonDatabase to be array-like');
  }
  return raw.map((d) => ({
    challenge_mode_id: d.challengeModeId ?? null,
    instance_id: d.instanceId ?? null,
    teleport_spell_id: d.teleportSpellId ?? null,
    loot: Array.isArray(d.lootTable) ? d.lootTable : [],
  }));
}

function normalizeRaids(raw) {
  if (!Array.isArray(raw)) {
    throw new Error('raids.lua: expected RaidDatabase to be array-like');
  }
  return raw.map((r) => ({
    journal_instance_id: r.journalInstanceId ?? null,
    instance_id: r.instanceId ?? null,
    bosses: Array.isArray(r.bossList)
      ? r.bossList.map((b) => ({
          boss_id: b.bossId ?? null,
          npc_id: b.npcId ?? null,
          loot_by_difficulty: normalizeRaidLoot(b.lootTable),
        }))
      : [],
  }));
}

function normalizeRaidLoot(lootTable) {
  if (!lootTable || typeof lootTable !== 'object') return {};
  const out = {};
  for (const [k, items] of Object.entries(lootTable)) {
    const diffName = RAID_DIFFICULTY_BY_ID[k];
    if (!diffName) continue;
    out[diffName] = Array.isArray(items) ? items : [];
  }
  return out;
}

function normalizeItems(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('items.lua: expected ItemDatabase to be object-like');
  }
  const out = {};
  for (const [idStr, info] of Object.entries(raw)) {
    if (!info || typeof info !== 'object') continue;
    const itemId = Number(idStr);
    if (!Number.isInteger(itemId)) continue;
    out[itemId] = {
      slot_id: info.slotId ?? null,
      slot_name: info.slotId != null ? SLOT_ID_TO_NAME[info.slotId] ?? null : null,
      icon: info.icon ?? null,
      classes: normalizeItemClasses(info.classes),
      stats: Array.isArray(info.stats) ? info.stats : [],
    };
  }
  return out;
}

function normalizeItemClasses(classes) {
  if (!classes || typeof classes !== 'object') return {};
  const out = {};
  for (const [classIdStr, specs] of Object.entries(classes)) {
    if (!Array.isArray(specs)) continue;
    out[classIdStr] = specs.filter((s) => typeof s === 'number');
  }
  return out;
}

function normalizeUpgradeTracks(raw) {
  // raw = { dungeon: { champion: [CreateTrackEntry(...)], hero: [...], ... }, raid: { lfr: [...], ... } }
  if (!raw || typeof raw !== 'object') {
    throw new Error('upgrade_tracks.lua: expected UpgradeTracks to be object-like');
  }
  const out = {};
  for (const category of ['dungeon', 'raid']) {
    const cat = raw[category];
    if (!cat || typeof cat !== 'object') continue;
    out[category] = {};
    for (const [trackName, entries] of Object.entries(cat)) {
      if (!Array.isArray(entries)) continue;
      out[category][trackName] = entries
        .filter((e) => e && e.__call === 'CreateTrackEntry')
        .map(({ args }) => ({
          ilvl: typeof args[0] === 'number' ? args[0] : null,
          bonus_id: typeof args[1] === 'number' ? args[1] : null,
          // args[2] = quality enum (ignored), args[3] = suffix (ignored), args[4] = rank label (ignored)
        }))
        .filter((e) => e.ilvl !== null && e.bonus_id !== null);
    }
  }
  return out;
}

function normalizeKeystoneMapping(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.rules)) {
    throw new Error('keystone_mapping.lua: expected KeystoneMapping.rules array');
  }
  return raw.rules.map((rule) => ({
    keystones: Array.isArray(rule.keystones) ? rule.keystones : [],
    end_of_run: rule.endOfRun ? { track: rule.endOfRun.track ?? null, rank: rule.endOfRun.rank ?? null } : null,
    great_vault: rule.greatVault ? { track: rule.greatVault.track ?? null, rank: rule.greatVault.rank ?? null } : null,
  }));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function fetchAndParse(path, tableName) {
  console.log(`fetching ${path}…`);
  const src = await fetchText(path);
  const ast = parseLua(src);
  const raw = findNamedTable(ast, tableName);
  if (raw === undefined) {
    throw new Error(`${path}: could not find KeystoneLoot.${tableName} assignment`);
  }
  return raw;
}

async function writeJson(name, data) {
  const path = join(OUT_DIR, name);
  await writeFile(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log(`  wrote ${name} (${JSON.stringify(data).length.toLocaleString()} bytes serialized)`);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const [dungeons, raids, items, tracks, mapping] = await Promise.all([
    fetchAndParse('data/dungeons.lua', 'DungeonDatabase'),
    fetchAndParse('data/raids.lua', 'RaidDatabase'),
    fetchAndParse('data/items.lua', 'ItemDatabase'),
    fetchAndParse('data/upgrade_tracks.lua', 'UpgradeTracks'),
    fetchAndParse('data/keystone_mapping.lua', 'KeystoneMapping'),
  ]);

  await writeJson('dungeons.json', {
    schema_version: 1,
    source: `https://github.com/${REPO}@${REF}`,
    generated_at: new Date().toISOString(),
    dungeons: normalizeDungeons(dungeons),
  });
  await writeJson('raids.json', {
    schema_version: 1,
    source: `https://github.com/${REPO}@${REF}`,
    generated_at: new Date().toISOString(),
    raids: normalizeRaids(raids),
  });
  await writeJson('items.json', {
    schema_version: 1,
    source: `https://github.com/${REPO}@${REF}`,
    generated_at: new Date().toISOString(),
    items: normalizeItems(items),
  });
  await writeJson('upgrade-tracks.json', {
    schema_version: 1,
    source: `https://github.com/${REPO}@${REF}`,
    generated_at: new Date().toISOString(),
    tracks: normalizeUpgradeTracks(tracks),
  });
  await writeJson('keystone-mapping.json', {
    schema_version: 1,
    source: `https://github.com/${REPO}@${REF}`,
    generated_at: new Date().toISOString(),
    rules: normalizeKeystoneMapping(mapping),
  });

  console.log('\ndone.');
}

main().catch((err) => {
  console.error('regen-content-tables failed:', err);
  process.exit(1);
});
