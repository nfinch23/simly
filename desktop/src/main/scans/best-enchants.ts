/**
 * best_enchants scan — pick the best permanent enchant per slot.
 *
 * Each WoW slot has a small set of permanent-enchant options. The
 * stat profile of each enchant varies (haste / crit / mast / vers /
 * primary), so the right choice depends on the player's gear + spec.
 * We sim every candidate per slot and surface a per-slot winner.
 *
 * v1 candidate set: legs + main_hand only — the two slots with the
 * highest DPS variance between enchants. Head/shoulder/feet/ring/back
 * deltas are typically <0.3%; deferring those keeps the prescan
 * runtime down. Schema is per-slot so future slices can extend
 * without changing it.
 *
 * Candidate IDs sourced from SimC's `permanent_enchant.inc` on the
 * Midnight branch.
 *
 * Like best_gems, this scan lives outside the SCANS registry — its
 * profilesets need the parsed export to re-emit item lines with
 * different enchant_ids.
 */
import type { BestConsumableResult } from '@simly/shared';
import type { ParsedExport, ParsedItem } from '../simc-export-parser';
import type { SimcRunResult } from '../simc-runner';
import { roundTo } from './index';

/** One enchant option for a given slot. */
export interface EnchantCandidate {
  key: string;
  enchant_id: number;
  name: string;
}

/**
 * Per-slot candidate map. Sim every candidate against the player's
 * current item-line context — the profileset re-emits that slot's
 * item with the candidate enchant_id, everything else inherits from
 * the base actor.
 *
 * Slot keys match `ParsedItem.slot` (SimC's canonical names).
 */
export const ENCHANT_CANDIDATES_BY_SLOT: Readonly<Record<string, readonly EnchantCandidate[]>> = {
  legs: [
    { key: 'sunfire_silk', enchant_id: 7935, name: 'Sunfire Silk Spellthread' },
    { key: 'arcanoweave', enchant_id: 7937, name: 'Arcanoweave Spellthread' },
    { key: 'forest_hunters', enchant_id: 8159, name: "Forest Hunter's Armor Kit" },
    { key: 'thalassian_scout', enchant_id: 8161, name: 'Thalassian Scout Armor Kit' },
    { key: 'blood_knights', enchant_id: 8163, name: "Blood Knight's Armor Kit" },
  ],
  main_hand: [
    { key: 'acuity_rendorei', enchant_id: 8039, name: "Acuity of the Ren'dorei" },
    { key: 'arcane_mastery', enchant_id: 8041, name: 'Arcane Mastery' },
    { key: 'janalais_precision', enchant_id: 7981, name: "Jan'alai's Precision" },
    { key: 'berserkers_rage', enchant_id: 7983, name: "Berserker's Rage" },
  ],
};

/**
 * Result schema: one BestConsumableResult per scanned slot. The addon
 * iterates the per_slot map and renders each slot's winner.
 */
export interface BestEnchantsResult {
  label: string;
  per_slot: Record<string, BestConsumableResult>;
}

const PREFIX = 'enchant';

/**
 * Replace enchant_id in an item line with the candidate's ID. Adds
 * a new enchant_id field if the original line lacked one (some bag
 * items might be in this state). Returns the modified line.
 */
export function rewriteItemEnchant(itemLine: string, candidateId: number): string {
  if (/enchant_id=[0-9]+/.test(itemLine)) {
    return itemLine.replace(/enchant_id=[0-9]+/, `enchant_id=${candidateId}`);
  }
  // No enchant_id — append it. Splice it in right after the id= field
  // for consistency with other item lines.
  return itemLine.replace(/(id=\d+)/, `$1,enchant_id=${candidateId}`);
}

/**
 * Synthesize a SimC item line from a ParsedItem with the enchant_id
 * overridden to the candidate's value. Preserves all other fields
 * (bonus_id, gem_id, crafted_stats, etc.).
 */
export function synthesizeItemLineWithEnchant(item: ParsedItem, enchantIdOverride: number): string {
  const parts: string[] = [`${item.slot}=,id=${item.item_id}`];
  parts.push(`enchant_id=${enchantIdOverride}`);
  // Preserve gem_id from extras when present.
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

/**
 * Build enchant profilesets for every (slot, candidate) the player can
 * use. Skips slots not in ENCHANT_CANDIDATES_BY_SLOT or where the
 * player doesn't have the slot equipped.
 *
 * Profileset names follow `enchant_<slot>_<candidate.key>` so the
 * parser can group by slot.
 */
export function buildEnchantsProfilesetLines(parsed: ParsedExport): string {
  const blocks: string[] = [];
  for (const [slot, candidates] of Object.entries(ENCHANT_CANDIDATES_BY_SLOT)) {
    const item = parsed.equipped.find((i) => i.slot === slot);
    if (!item) continue;
    for (const candidate of candidates) {
      const itemLine = synthesizeItemLineWithEnchant(item, candidate.enchant_id);
      blocks.push(`profileset."${PREFIX}_${slot}_${candidate.key}"+="${itemLine}"`);
    }
  }
  return blocks.join('\n');
}

/**
 * Parse the enchant profilesets out of a SimC run and group them by
 * slot. Each slot gets its own BestConsumableResult.
 */
export function parseBestEnchants(run: SimcRunResult): BestEnchantsResult | undefined {
  const per_slot: Record<string, BestConsumableResult> = {};
  for (const [slot, candidates] of Object.entries(ENCHANT_CANDIDATES_BY_SLOT)) {
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
