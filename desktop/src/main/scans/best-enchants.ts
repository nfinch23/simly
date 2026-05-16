/**
 * best_enchants scan — pick the best permanent enchant per slot.
 *
 * Slice G4 catalog: Raidbots' canonical Q2 DPS enchant whitelist.
 * 4 slots covered (weapon, chest, legs, ring); tank/healer-only
 * enchants are deferred to a per-spec-logic future slice.
 *
 * Slot totals:
 *   - weapon (7 DPS options) — sim'd for main_hand; dual-wield specs
 *     also for off_hand. SimC's weapon enchants live with
 *     item_class=2 / slot_mask=0.
 *   - chest (4 Mark variants)
 *   - legs (6 — armor kits + spellthreads)
 *   - ring (9 — applies to both finger1 and finger2)
 *
 * Data flow:
 *   - scripts/regen-enchants.mjs pulls SimC's permanent_enchant.inc +
 *     spell_item_enchantment.inc on the midnight branch, emits
 *     data/enchants.json.
 *   - We import that JSON, then match each Raidbots-whitelisted
 *     simc_name to its row. The whitelist's display name is what
 *     surfaces in the UI (canonical apostrophes/casing the regen
 *     script can't fully reconstruct for armor-kit/spellthread types).
 *
 * Per-patch maintenance: re-run regen-enchants.mjs; if Blizzard adds
 * new DPS enchants, append the simc_name + display_name to
 * RAIDBOTS_WHITELIST below.
 */
import type { BestConsumableResult } from '@simly/shared';
import type { ParsedExport, ParsedItem } from '../simc-export-parser';
import type { SimcRunResult } from '../simc-runner';
import { roundTo } from './index';
import enchantsData from '../../../../data/enchants.json';

export interface EnchantCandidate {
  key: string;
  enchant_id: number;
  name: string;
}

export interface BestEnchantsResult {
  label: string;
  per_slot: Record<string, BestConsumableResult>;
}

interface EnchantDataRow {
  id: number;
  simc_name: string;
  display_name: string;
  slot: string;
  slot_mask: string;
  item_class: number;
}

/**
 * Raidbots' DPS-only whitelist, keyed by SimC slot then by
 * `simc_name -> display_name`. Tank/healer enchants (e.g. weapon
 * worldsoul_aegis / worldsoul_cradle) are intentionally excluded;
 * per-spec custom logic is a future slice.
 */
const RAIDBOTS_WHITELIST: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  weapon: {
    enchant_weapon__acuity_of_the_rendorei: "Acuity of the Ren'dorei",
    enchant_weapon__arcane_mastery: 'Arcane Mastery',
    enchant_weapon__berserkers_rage: "Berserker's Rage",
    enchant_weapon__flames_of_the_sindorei: "Flames of the Sin'dorei",
    enchant_weapon__janalais_precision: "Jan'alai's Precision",
    enchant_weapon__strength_of_halazzi: 'Strength of Halazzi',
    enchant_weapon__worldsoul_tenacity: 'Worldsoul Tenacity',
  },
  chest: {
    enchant_chest__mark_of_nalorakk: 'Mark of Nalorakk',
    enchant_chest__mark_of_the_magister: 'Mark of the Magister',
    enchant_chest__mark_of_the_rootwarden: 'Mark of the Rootwarden',
    enchant_chest__mark_of_the_worldsoul: 'Mark of the Worldsoul',
  },
  legs: {
    bright_linen_spellthread: 'Bright Linen Spellthread',
    blood_knights_armor_kit: "Blood Knight's Armor Kit",
    arcanoweave_spellthread: 'Arcanoweave Spellthread',
    sunfire_silk_spellthread: 'Sunfire Silk Spellthread',
    forest_hunters_armor_kit: "Forest Hunter's Armor Kit",
    thalassian_scout_armor_kit: 'Thalassian Scout Armor Kit',
  },
  ring: {
    enchant_ring__eyes_of_the_eagle: 'Eyes of the Eagle',
    enchant_ring__natures_fury: "Nature's Fury",
    enchant_ring__silvermoons_tenacity: "Silvermoon's Tenacity",
    enchant_ring__silvermoons_alacrity: "Silvermoon's Alacrity",
    enchant_ring__zuljins_mastery: "Zul'jin's Mastery",
    enchant_ring__thalassian_haste: 'Thalassian Haste',
    enchant_ring__thalassian_versatility: 'Thalassian Versatility',
    enchant_ring__amani_mastery: 'Amani Mastery',
    enchant_ring__natures_wrath: "Nature's Wrath",
  },
};

/**
 * Build the per-slot candidate map by joining the whitelist against
 * the regenerated enchant data. Weapon enchants apply to main_hand
 * AND off_hand (dual-wield specs); rings apply to both finger
 * slots. Other slots map one-to-one.
 *
 * For slots where SimC's row exists but the whitelist key doesn't
 * match (data drift / typo), the candidate is dropped — better to
 * skip than emit a broken profileset.
 */
function buildSlotCandidates(rows: readonly EnchantDataRow[]): Record<string, EnchantCandidate[]> {
  // Lower-id deduplication: SimC sometimes has multiple ranks for the
  // same enchant. Keep the highest enchant_id since that's the highest
  // tier (rank 3 > rank 2 > rank 1).
  const byKey = new Map<string, EnchantDataRow>();
  for (const row of rows) {
    const prior = byKey.get(row.simc_name);
    if (!prior || row.id > prior.id) byKey.set(row.simc_name, row);
  }

  const out: Record<string, EnchantCandidate[]> = {};
  for (const [simcSlot, whitelist] of Object.entries(RAIDBOTS_WHITELIST)) {
    const slotKey = simcSlot;
    out[slotKey] = [];
    for (const [simcName, displayName] of Object.entries(whitelist)) {
      const row = byKey.get(simcName);
      if (!row) {
        console.warn(
          `[best-enchants] whitelist entry not found in data/enchants.json: ${simcName}`,
        );
        continue;
      }
      out[slotKey]!.push({
        key: simcName.replace(/^enchant_[a-z]+__/, '').replace(/[^a-z0-9_]/g, ''),
        enchant_id: row.id,
        name: displayName,
      });
    }
  }
  return out;
}

const SLOT_CANDIDATES = buildSlotCandidates(
  (enchantsData.enchants ?? []) as EnchantDataRow[],
);

/**
 * The actual ENCHANT_CANDIDATES_BY_SLOT map used by build/parse
 * helpers. Maps ParsedItem slot names (head, shoulder, legs,
 * main_hand, off_hand, finger1, finger2, chest) to candidate lists.
 *
 * Weapon enchants apply to both main_hand + off_hand; ring enchants
 * apply to both finger slots.
 */
export const ENCHANT_CANDIDATES_BY_SLOT: Readonly<Record<string, readonly EnchantCandidate[]>> = {
  head: [],
  shoulder: [],
  chest: SLOT_CANDIDATES['chest'] ?? [],
  back: [],
  wrist: [],
  hands: [],
  legs: SLOT_CANDIDATES['legs'] ?? [],
  feet: [],
  finger1: SLOT_CANDIDATES['ring'] ?? [],
  finger2: SLOT_CANDIDATES['ring'] ?? [],
  main_hand: SLOT_CANDIDATES['weapon'] ?? [],
  off_hand: SLOT_CANDIDATES['weapon'] ?? [],
};

const PREFIX = 'enchant';

/**
 * Replace enchant_id in an item line with the candidate's ID. Adds
 * a new enchant_id field if the original line lacked one.
 */
export function rewriteItemEnchant(itemLine: string, candidateId: number): string {
  if (/enchant_id=[0-9]+/.test(itemLine)) {
    return itemLine.replace(/enchant_id=[0-9]+/, `enchant_id=${candidateId}`);
  }
  return itemLine.replace(/(id=\d+)/, `$1,enchant_id=${candidateId}`);
}

/**
 * Synthesize a SimC item line from a ParsedItem with the enchant_id
 * overridden to the candidate's value. Preserves all other fields.
 */
export function synthesizeItemLineWithEnchant(item: ParsedItem, enchantIdOverride: number): string {
  const parts: string[] = [`${item.slot}=,id=${item.item_id}`];
  parts.push(`enchant_id=${enchantIdOverride}`);
  if (item.extras?.['gem_id']) {
    parts.push(`gem_id=${item.extras['gem_id']}`);
  }
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

export function buildEnchantsProfilesetLines(parsed: ParsedExport): string {
  const blocks: string[] = [];
  for (const [slot, candidates] of Object.entries(ENCHANT_CANDIDATES_BY_SLOT)) {
    if (candidates.length === 0) continue;
    const item = parsed.equipped.find((i) => i.slot === slot);
    if (!item) continue;
    for (const candidate of candidates) {
      const itemLine = synthesizeItemLineWithEnchant(item, candidate.enchant_id);
      blocks.push(`profileset."${PREFIX}_${slot}_${candidate.key}"+="${itemLine}"`);
    }
  }
  return blocks.join('\n');
}

export function parseBestEnchants(run: SimcRunResult): BestEnchantsResult | undefined {
  const per_slot: Record<string, BestConsumableResult> = {};
  for (const [slot, candidates] of Object.entries(ENCHANT_CANDIDATES_BY_SLOT)) {
    if (candidates.length === 0) continue;
    const slotResults: Array<{ candidate: EnchantCandidate; mean: number }> = [];
    for (const candidate of candidates) {
      const name = `${PREFIX}_${slot}_${candidate.key}`;
      const ps = run.profilesets.find((p) => p.name === name);
      if (ps) slotResults.push({ candidate, mean: ps.mean });
    }
    if (slotResults.length === 0) continue;
    slotResults.sort((a, b) => b.mean - a.mean);
    const winner = slotResults[0]!;
    per_slot[slot] = {
      label: `Best ${slot} enchant`,
      best: {
        item_id: winner.candidate.enchant_id,
        name: winner.candidate.name,
        dps: Math.round(winner.mean),
      },
      alternatives: slotResults.slice(1).map((s) => ({
        item_id: s.candidate.enchant_id,
        name: s.candidate.name,
        dps: Math.round(s.mean),
        delta_pct: roundTo(((s.mean - winner.mean) / winner.mean) * 100, 2),
      })),
    };
  }
  if (Object.keys(per_slot).length === 0) return undefined;
  return {
    label: 'Best enchants per slot',
    per_slot,
  };
}
