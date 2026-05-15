/**
 * Regenerate data/item-names.json from SimC's authoritative item_data.inc.
 *
 * Source: https://github.com/simulationcraft/simc/blob/midnight/engine/dbc/generated/item_data.inc
 * (~26MB, 65K+ items). We only need the names for items that appear in our
 * dungeon/raid loot tables (~360 items total), so the regen filters to that
 * set and emits a compact `{ id → name }` JSON.
 *
 * Why SimC instead of Wowhead:
 *   - Same data source we already trust (item_bonus.inc is also from here).
 *   - No rate limits / scraping concerns.
 *   - Names are well-formatted English with no markup.
 *   - Deterministic — re-run produces identical output for the same patch.
 *
 * Usage:
 *   node scripts/regen-item-names.mjs
 *
 * Re-runnable. Idempotent. Run after `regen-content-tables.mjs` so we know
 * which item IDs need names.
 */
import { writeFile, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');

const SOURCE_URL =
  'https://raw.githubusercontent.com/simulationcraft/simc/midnight/engine/dbc/generated/item_data.inc';

/**
 * Extract every (id, name) pair where id is in our needed-set. Matches the
 * canonical row shape:
 *
 *   { "Item Name",     <id>, 0x..., ...,  },
 *
 * The name field is the first quoted string on each row; id is the first
 * unsigned integer after it. There may be embedded `,` or escapes in the
 * name, but SimC's generator escapes them (`\"`) — the regex tolerates
 * both unescaped and escaped quotes.
 */
const ROW_RE = /^\s*\{\s*"((?:[^"\\]|\\.)*)"\s*,\s*(\d+)\s*,/;

async function loadNeededIds() {
  const needed = new Set();
  const dungeons = JSON.parse(await readFile(join(DATA_DIR, 'dungeons.json'), 'utf8'));
  const raids = JSON.parse(await readFile(join(DATA_DIR, 'raids.json'), 'utf8'));
  for (const d of dungeons.dungeons) for (const id of d.loot) needed.add(id);
  for (const r of raids.raids) {
    for (const b of r.bosses) {
      for (const diff of Object.values(b.loot_by_difficulty)) {
        for (const id of diff) needed.add(id);
      }
    }
  }
  return needed;
}

async function fetchSource() {
  console.log(`fetching ${SOURCE_URL}…`);
  const res = await fetch(SOURCE_URL);
  if (!res.ok) {
    throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
  }
  return res.text();
}

function extractNames(source, needed) {
  const out = {};
  let matched = 0;
  for (const line of source.split('\n')) {
    const m = ROW_RE.exec(line);
    if (!m) continue;
    const name = m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    const id = Number(m[2]);
    if (needed.has(id)) {
      out[id] = name;
      matched++;
    }
  }
  return { out, matched };
}

async function main() {
  const needed = await loadNeededIds();
  console.log(`need names for ${needed.size} item ids (from dungeons + raids)`);

  const source = await fetchSource();
  console.log(`parsing ${source.length.toLocaleString()} chars…`);
  const { out, matched } = extractNames(source, needed);

  const missing = [...needed].filter((id) => !(id in out));
  if (missing.length > 0) {
    console.warn(
      `  warning: ${missing.length} ids had no name in item_data.inc ` +
        `(probably very-recent additions); first 5: ${missing.slice(0, 5).join(', ')}`,
    );
  }

  const payload = {
    schema_version: 1,
    source: 'https://github.com/simulationcraft/simc@midnight/engine/dbc/generated/item_data.inc',
    generated_at: new Date().toISOString(),
    count: matched,
    names: out,
  };
  const outPath = join(DATA_DIR, 'item-names.json');
  await writeFile(outPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log(
    `wrote item-names.json — ${matched} names (${missing.length} missing)`,
  );
}

main().catch((err) => {
  console.error('regen-item-names failed:', err);
  process.exit(1);
});
