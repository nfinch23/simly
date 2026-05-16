/**
 * Regenerate data/enchants.json from SimC's authoritative enchant tables.
 *
 * Sources (Midnight branch):
 *   - engine/dbc/generated/permanent_enchant.inc — 1059 rows of
 *     { enchant_id, ?, item_class, slot_mask, ?, "simc_name" }.
 *   - engine/dbc/generated/spell_item_enchantment.inc — full enchantment
 *     data including display names like "Enchant Weapon - Acuity of the
 *     Ren'dorei" (with the canonical apostrophes/casing).
 *
 * We emit every enchant from permanent_enchant.inc enriched with the
 * display name from spell_item_enchantment.inc, plus a derived slot
 * label. Consumer code (best-enchants.ts) applies a Raidbots whitelist
 * to narrow to DPS-relevant options per slot.
 *
 * Output: data/enchants.json
 *   {
 *     schema_version: 1,
 *     source: "simulationcraft/simc@midnight",
 *     generated_at: "...",
 *     enchants: [
 *       { id, simc_name, display_name, slot, slot_mask, item_class },
 *       ...
 *     ]
 *   }
 *
 * Per-patch maintenance: re-run after SimC pushes a new expansion
 * branch. Same pattern as regen-gems.mjs.
 */
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');

const SIMC_BRANCH = 'midnight';
const PERMANENT_URL = `https://raw.githubusercontent.com/simulationcraft/simc/${SIMC_BRANCH}/engine/dbc/generated/permanent_enchant.inc`;
const SPELL_URL = `https://raw.githubusercontent.com/simulationcraft/simc/${SIMC_BRANCH}/engine/dbc/generated/spell_item_enchantment.inc`;

/**
 * permanent_enchant.inc row:
 *   { 8039, 2, 2, 0x00000000, 0x000ebfff, "enchant_weapon__acuity_of_the_rendorei" },
 *
 * Capture: enchant_id, item_class, slot_mask (hex), simc_name.
 */
const PERMANENT_RE =
  /\{\s*(\d+)\s*,\s*\d+\s*,\s*(-?\d+)\s*,\s*(0x[0-9a-fA-F]+)\s*,\s*(?:0x[0-9a-fA-F]+|\d+)\s*,\s*"([^"]+)"\s*\}/;

/**
 * spell_item_enchantment.inc row — multi-line in source, but each row
 * occupies a single physical line. We only need the leading id + the
 * trailing description string.
 *
 *   { 8039, ..., "Enchant Weapon - Acuity of the Ren'dorei |A:..." },
 */
const SPELL_RE = /\{\s*(\d+)\s*,[^"]*"([^"]*)"\s*\}/;

/**
 * Pull a clean display name from an enchant description.
 *
 * Patterns we see in spell_item_enchantment.inc:
 *   - "Enchant Weapon - Acuity of the Ren'dorei |A:..."  → "Acuity of the Ren'dorei"
 *   - "+$k1 Intellect & +$k2 Stamina |A:..."             → stat text (not useful as a name)
 *   - "Sunfire Silk Spellthread |A:..."                  → "Sunfire Silk Spellthread"
 *
 * Strip the trailing icon marker, then if there's an "Enchant X - "
 * prefix, drop it. Otherwise return the rest as-is.
 */
function cleanDisplayName(desc) {
  // Strip trailing icon marker (Wowhead/Blizz tooltip rendering).
  let s = desc.replace(/\s*\|A:[^|]+\|a\s*$/, '').trim();
  // Strip "Enchant <slot> - " prefix when present.
  const m = s.match(/^Enchant\s+[A-Za-z ]+\s+-\s+(.+)$/);
  if (m) return m[1].trim();
  return s;
}

/**
 * Derive a slot label from slot_mask + item_class. Bitmasks correspond
 * to inventory_type IDs in WoW's item table. Weapons use slot_mask=0
 * with item_class=2 (Weapon); armor enchants use slot_mask bits.
 *
 * Returns 'unknown' for rows we don't recognise — they're filtered
 * out by best-enchants.ts's whitelist anyway.
 */
function deriveSlot(slotMaskHex, itemClass) {
  if (itemClass === 2) return 'weapon';
  const mask = parseInt(slotMaskHex, 16);
  if (mask & 0x00000002) return 'head';
  if (mask & 0x00000008) return 'shoulder';
  if (mask & 0x00000004) return 'neck';
  if (mask & 0x00000010) return 'shirt';
  if (mask & 0x00100020) return 'chest';
  if (mask & 0x00000040) return 'waist';
  if (mask & 0x00000080) return 'legs';
  if (mask & 0x00000100) return 'feet';
  if (mask & 0x00000200) return 'wrist';
  if (mask & 0x00000400) return 'hands';
  if (mask & 0x00000800) return 'ring';
  if (mask & 0x00001000) return 'trinket';
  if (mask & 0x00004000) return 'back';
  if (mask & 0x40000000) return 'offhand';
  return 'unknown';
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return await res.text();
}

async function main() {
  console.log(`[regen-enchants] fetching permanent_enchant.inc...`);
  const permanent = await fetchText(PERMANENT_URL);
  console.log(`[regen-enchants] fetching spell_item_enchantment.inc...`);
  const spell = await fetchText(SPELL_URL);

  // Build the spell_item_enchantment lookup: id → display_name.
  const displayByEnchantId = new Map();
  for (const line of spell.split(/\r?\n/)) {
    const m = line.match(SPELL_RE);
    if (!m) continue;
    const id = Number(m[1]);
    const desc = m[2];
    displayByEnchantId.set(id, cleanDisplayName(desc));
  }
  console.log(`[regen-enchants] indexed ${displayByEnchantId.size} enchant descriptions`);

  // Build the enchant entries from permanent_enchant.inc.
  const enchants = [];
  for (const line of permanent.split(/\r?\n/)) {
    const m = line.match(PERMANENT_RE);
    if (!m) continue;
    const id = Number(m[1]);
    const itemClass = Number(m[2]);
    const slotMask = m[3];
    const simcName = m[4];
    const slot = deriveSlot(slotMask, itemClass);
    const display = displayByEnchantId.get(id) ?? simcName;
    enchants.push({
      id,
      simc_name: simcName,
      display_name: display,
      slot,
      slot_mask: slotMask,
      item_class: itemClass,
    });
  }
  enchants.sort((a, b) => a.id - b.id);
  console.log(`[regen-enchants] joined ${enchants.length} enchants with descriptions`);

  const out = {
    schema_version: 1,
    source: `simulationcraft/simc@${SIMC_BRANCH}`,
    generated_at: new Date().toISOString(),
    enchants,
  };
  const outPath = join(DATA_DIR, 'enchants.json');
  await writeFile(outPath, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`[regen-enchants] wrote ${outPath} (${enchants.length} enchants)`);
}

main().catch((err) => {
  console.error('[regen-enchants] failed:', err);
  process.exit(1);
});
