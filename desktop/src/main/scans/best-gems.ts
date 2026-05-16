/**
 * best_gems scan — pick the best socket gem stat for the player's build.
 *
 * Unlike flask/food/potion, gems are slotted per-item via `gem_id=N` on
 * the item line. To compare gem-stat options we re-emit every socketed
 * item line with a different gem_id under each profileset. Multi-socket
 * items (`gem_id=A/B`) get the same candidate repeated across all
 * sockets — we don't optimize per-socket in v1.
 *
 * Candidate set (4 secondary-stat options):
 *   - Haste — Flawless Quick Amethyst (240900)
 *   - Crit  — Flawless Deadly Amethyst (240898)
 *   - Mast  — Flawless Masterful Garnet (240908)
 *   - Vers  — Flawless Versatile Amethyst (240902)
 *
 * Item IDs sourced from SimC's `item_data.inc` (Midnight branch); the
 * naming convention is well-established WoW lore (Quick=Haste etc.).
 * Meta-gem variants (Eversong Diamonds 240967 / 240983) are deferred —
 * they have special effects beyond raw stats and need their own pass.
 *
 * Why this scan lives outside SCANS registry: buildLines() in the
 * standard Scan interface is parameterless, but gem profilesets need
 * the parsed export to know which items have sockets. Scan-queue calls
 * `buildGemsProfilesetLines(parsed)` directly when running the
 * consumables prescan.
 */
import type { BestConsumableResult } from '@simly/shared';
import type { ParsedExport, ParsedItem } from '../simc-export-parser';
import type { SimcRunResult } from '../simc-runner';
import { matchProfilesetsByPrefix, roundTo } from './index';

export type BestGemsResult = BestConsumableResult;

export interface GemCandidate {
  key: string;
  item_id: number;
  name: string;
  /** The stat the gem provides — surfaced in result.best.name. */
  stat: 'haste' | 'crit' | 'mastery' | 'versatility';
}

export const GEM_CANDIDATES: readonly GemCandidate[] = [
  { key: 'haste', item_id: 240900, name: 'Quick gems (haste)', stat: 'haste' },
  { key: 'crit', item_id: 240898, name: 'Deadly gems (crit)', stat: 'crit' },
  { key: 'mastery', item_id: 240908, name: 'Masterful gems (mastery)', stat: 'mastery' },
  { key: 'versatility', item_id: 240902, name: 'Versatile gems (versatility)', stat: 'versatility' },
];

const PREFIX = 'gems';

/**
 * Re-emit one item line with gem_id replaced by the candidate gem ID
 * (repeated to match the socket count from the original line). Returns
 * undefined when the item has no gem_id field.
 */
export function rewriteItemGems(itemLine: string, candidateId: number): string | undefined {
  const match = itemLine.match(/gem_id=([0-9]+(?:\/[0-9]+)*)/);
  if (!match) return undefined;
  const socketCount = match[1]!.split('/').length;
  const replacement = `gem_id=${Array(socketCount).fill(candidateId).join('/')}`;
  return itemLine.replace(/gem_id=[0-9]+(?:\/[0-9]+)*/, replacement);
}

/**
 * Build the gem profileset block. One profileset per candidate; each
 * contains re-emitted item lines (one per socketed equipped item) with
 * the candidate's gem_id substituted.
 *
 * Returns an empty string when the player has no sockets — SimC would
 * choke on a profileset with no `+=` lines.
 */
export function buildGemsProfilesetLines(parsed: ParsedExport): string {
  // Find every equipped item that currently has a gem. Re-using the
  // raw item line shape requires reconstructing it from ParsedItem;
  // since the player's export already had a line per equipped item,
  // we synthesize the override from the parser's fields.
  const socketedEquipped: ParsedItem[] = parsed.equipped.filter(
    (i) => i.extras?.['gem_id'] || i.extras?.['gem_id'] === '0',
  );
  if (socketedEquipped.length === 0) return '';

  const blocks: string[] = [];
  for (const candidate of GEM_CANDIDATES) {
    for (const item of socketedEquipped) {
      // Re-emit the item line with the original bonus_id + gem_id
      // replaced by the candidate. We keep all other fields (item_id,
      // bonus_id, enchant_id, crafted_stats, etc.) intact.
      const itemLine = synthesizeItemLine(item, candidate.item_id);
      blocks.push(`profileset."${PREFIX}_${candidate.key}"+="${itemLine}"`);
    }
  }
  return blocks.join('\n');
}

/**
 * Build a SimC item line from a ParsedItem with gem_id overridden.
 * Exported for tests.
 */
export function synthesizeItemLine(item: ParsedItem, gemIdOverride: number): string {
  const parts: string[] = [`${item.slot}=,id=${item.item_id}`];
  // Determine original socket count from the parsed gem_id field.
  // ParsedItem.extras holds `gem_id` as a raw string (slash-separated
  // when multi-socket).
  const origGemRaw = item.extras?.['gem_id'] ?? '';
  const socketCount = origGemRaw ? origGemRaw.split('/').length : 1;
  parts.push(`gem_id=${Array(socketCount).fill(gemIdOverride).join('/')}`);
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
  // Preserve enchant_id from extras since the parser tucks it there.
  if (item.extras?.['enchant_id']) {
    parts.push(`enchant_id=${item.extras['enchant_id']}`);
  }
  return parts.join(',');
}

/**
 * Pick the winning gem candidate's item_id from a SimC run.
 */
export function pickWinningGemItemId(run: SimcRunResult): number | undefined {
  const matched = matchProfilesetsByPrefix(run, PREFIX, GEM_CANDIDATES);
  if (matched.length === 0) return undefined;
  matched.sort((a, b) => b.mean - a.mean);
  return matched[0]!.candidate.item_id;
}

export function parseBestGems(run: SimcRunResult): BestGemsResult | undefined {
  const matched = matchProfilesetsByPrefix(run, PREFIX, GEM_CANDIDATES);
  if (matched.length === 0) return undefined;

  matched.sort((a, b) => b.mean - a.mean);
  const winner = matched[0]!;
  const winnerDps = winner.mean;

  return {
    label: 'Best gem stat',
    best: {
      item_id: winner.candidate.item_id,
      name: winner.candidate.name,
      dps: Math.round(winnerDps),
    },
    alternatives: matched.slice(1).map((m) => ({
      item_id: m.candidate.item_id,
      name: m.candidate.name,
      dps: Math.round(m.mean),
      delta_pct: roundTo(((m.mean - winnerDps) / winnerDps) * 100, 2),
    })),
  };
}
