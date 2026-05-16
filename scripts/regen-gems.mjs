/**
 * Regenerate data/gems.json from SimC's authoritative gem tables.
 *
 * Sources (Midnight branch):
 *   - engine/dbc/generated/item_data.inc — item rows including a
 *     gem_property_id column for gem items (> 0 for gems, 0 for
 *     everything else).
 *   - engine/dbc/generated/gem_data.inc — gem_property_data_t rows
 *     mapping gem_property_id → enchant_id, color_mask, and a
 *     descriptive comment listing the stats.
 *
 * The comments on gem_data.inc rows include the stat decode in a
 * predictable shape:
 *
 *   { 4380, 8137, 0x0000000e, 14278 }, // +$k1 Mastery & +$k2 Haste
 *
 * We use the comment as the stat-decode oracle — simpler than joining
 * spell_item_enchantment.inc, and stable across SimC versions because
 * the comment format hasn't changed.
 *
 * Output: data/gems.json
 *   {
 *     schema_version: 1,
 *     source: "...",
 *     generated_at: "...",
 *     gems: [
 *       { id, name, gem_property_id, color_mask, stats: ["Mastery", "Haste"] },
 *       ...
 *     ]
 *   }
 *
 * Run with: node scripts/regen-gems.mjs
 *
 * Per-patch maintenance: re-run after SimC rolls a new branch for a
 * new WoW expansion. The same script works as long as SimC keeps the
 * same data-file shape (stable for 5+ years).
 */
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');

const SIMC_BRANCH = 'midnight';
const ITEM_DATA_URL = `https://raw.githubusercontent.com/simulationcraft/simc/${SIMC_BRANCH}/engine/dbc/generated/item_data.inc`;
const GEM_DATA_URL = `https://raw.githubusercontent.com/simulationcraft/simc/${SIMC_BRANCH}/engine/dbc/generated/gem_data.inc`;

/**
 * Match a gem-bearing item_data row. The gem_property_id is the
 * integer immediately following the `{ 0, 0, 0 }` sub-array.
 * Non-gem rows have 0 there; gems have a positive integer.
 */
const ITEM_GEM_RE =
  /\{\s*"((?:[^"\\]|\\.)*)"\s*,\s*(\d+)\s*,[^{]+\{\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\}\s*,\s*([1-9]\d*)\s*,/;

/**
 * Match a gem_data row + its trailing comment (the stat description).
 */
const GEM_DATA_RE =
  /\{\s*(\d+)\s*,\s*(\d+)\s*,\s*(0x[0-9a-fA-F]+)\s*,\s*(\d+)\s*\}\s*,\s*\/\/\s*(.+?)\s*$/;

/**
 * Extract the stat names from a gem_data comment like
 * "+$k1 Mastery & +$k2 Haste" or "+$k1 Intellect".
 *
 * Returns an array of canonical stat names (Title Case). Unknown
 * tokens are dropped — defensive against comment-format drift.
 */
const KNOWN_STATS = new Set([
  'Strength',
  'Agility',
  'Intellect',
  'Stamina',
  'Critical Strike',
  'Haste',
  'Mastery',
  'Versatility',
  'Avoidance',
  'Speed',
  'Leech',
  'Indestructible',
]);
function parseStatsFromComment(comment) {
  // Replace "Critical Strike" first so it doesn't get split on " S".
  // Then split on '&' or '+'.
  const normalized = comment.replace(/Critical Strike/g, 'Critical_Strike');
  const tokens = normalized.split(/[&+]/);
  const stats = [];
  for (const token of tokens) {
    // Strip "$kN " prefixes + leading/trailing whitespace.
    const m = token.match(/\$k\d+\s+(.+?)$/);
    if (!m) continue;
    const stat = m[1].trim().replace('Critical_Strike', 'Critical Strike');
    if (KNOWN_STATS.has(stat)) stats.push(stat);
  }
  return stats;
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return await res.text();
}

async function main() {
  console.log(`[regen-gems] fetching item_data.inc from SimC ${SIMC_BRANCH} branch...`);
  const itemData = await fetchText(ITEM_DATA_URL);
  console.log(`[regen-gems] fetching gem_data.inc...`);
  const gemData = await fetchText(GEM_DATA_URL);

  // Step 1: parse gem_data → map gem_property_id → { enchant_id, color_mask, stats }.
  const propMap = new Map();
  let propCount = 0;
  for (const line of gemData.split(/\r?\n/)) {
    const m = line.match(GEM_DATA_RE);
    if (!m) continue;
    const propId = Number(m[1]);
    const enchantId = Number(m[2]);
    const colorMask = m[3];
    const comment = m[5];
    const stats = parseStatsFromComment(comment);
    propMap.set(propId, { enchant_id: enchantId, color_mask: colorMask, stats });
    propCount++;
  }
  console.log(`[regen-gems] indexed ${propCount} gem properties from gem_data.inc`);

  // Step 2: walk item_data rows; for each row with a positive gem_property_id,
  // join with the propMap and collect.
  const gems = [];
  let itemCount = 0;
  for (const line of itemData.split(/\r?\n/)) {
    const m = line.match(ITEM_GEM_RE);
    if (!m) continue;
    const name = m[1];
    const id = Number(m[2]);
    const gemPropId = Number(m[3]);
    const prop = propMap.get(gemPropId);
    if (!prop) continue; // Item has gem_property_id but no matching gem_data row — skip.
    gems.push({
      id,
      name,
      gem_property_id: gemPropId,
      color_mask: prop.color_mask,
      stats: prop.stats,
    });
    itemCount++;
  }
  // Sort by id for deterministic output.
  gems.sort((a, b) => a.id - b.id);
  console.log(`[regen-gems] joined ${itemCount} gem items with property data`);

  const out = {
    schema_version: 1,
    source: `simulationcraft/simc@${SIMC_BRANCH}`,
    generated_at: new Date().toISOString(),
    gems,
  };
  const outPath = join(DATA_DIR, 'gems.json');
  await writeFile(outPath, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`[regen-gems] wrote ${outPath} (${gems.length} gems)`);
}

main().catch((err) => {
  console.error('[regen-gems] failed:', err);
  process.exit(1);
});
