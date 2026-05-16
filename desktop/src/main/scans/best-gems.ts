/**
 * best_gems scan — pick the best 2-stat gem allocation for the build.
 *
 * Midnight gems provide TWO secondary stats: a primary (color-coded)
 * and a secondary (adjective-coded). e.g. "Flawless Quick Amethyst"
 * is Mastery-primary + Haste-secondary; "Flawless Masterful Peridot"
 * is Haste-primary + Mastery-secondary. The same stat pair has two
 * distinct gems depending on which stat dominates.
 *
 * Candidate set is loaded from `data/gems.json` (regenerated from
 * SimC's gem_data.inc + item_data.inc on the midnight branch — see
 * scripts/regen-gems.mjs). v1 of this scan filters to Flawless-tier
 * 2-stat gems, deduplicating to one canonical item id per
 * stat-allocation (12 unique combinations).
 *
 * Per-patch maintenance: `node scripts/regen-gems.mjs` after SimC
 * pushes new gem data. Works across expansions as long as SimC's
 * data-file shape is unchanged.
 *
 * SimC mechanics: profilesets re-emit every socketed item line with
 * the candidate's gem_id substituted in every socket position
 * (gem_id=A or gem_id=A/B for multi-socket items). Other slots
 * inherit from the base actor.
 */
import type { BestConsumableResult } from '@simly/shared';
import type { ParsedExport, ParsedItem } from '../simc-export-parser';
import type { SimcRunResult } from '../simc-runner';
import { matchProfilesetsByPrefix, roundTo } from './index';
import gemsData from '../../../../data/gems.json';

export type BestGemsResult = BestConsumableResult;

export interface GemCandidate {
  key: string;
  item_id: number;
  name: string;
  /** Decoded stats from SimC's gem_data.inc — exactly 2 secondaries. */
  stats: readonly string[];
}

interface GemDataRow {
  id: number;
  name: string;
  gem_property_id: number;
  color_mask: string;
  stats: string[];
}

/**
 * Build the candidate set: every Flawless 2-stat allocation, one ID
 * per unique (primary, secondary) pair.
 *
 * The pairs are ORDER-SENSITIVE — "Mastery + Haste" (Amethyst) and
 * "Haste + Mastery" (Peridot) are different gems with different stat
 * allocations. Both ship as candidates so the sim can decide which
 * fits the player's stat priorities.
 */
function buildCandidateSet(rows: readonly GemDataRow[]): GemCandidate[] {
  const flawless = rows.filter(
    (g) => g.name.startsWith('Flawless') && g.stats.length === 2,
  );
  // Dedupe by stat-pair signature, keeping the LOWER item_id (stable
  // pick across runs). The two paired IDs per allocation differ only
  // in some binding flag, not in stats.
  const byKey = new Map<string, GemDataRow>();
  for (const g of flawless) {
    const key = `${g.stats[0]}+${g.stats[1]}`;
    const prior = byKey.get(key);
    if (!prior || g.id < prior.id) byKey.set(key, g);
  }
  return Array.from(byKey.values()).map((g) => ({
    key: `${g.stats[0]!.toLowerCase().replace(/\s+/g, '_')}_${g.stats[1]!.toLowerCase().replace(/\s+/g, '_')}`,
    item_id: g.id,
    name: `${g.name} (${g.stats.join(' + ')})`,
    stats: g.stats,
  }));
}

export const GEM_CANDIDATES: readonly GemCandidate[] = buildCandidateSet(
  (gemsData.gems ?? []) as GemDataRow[],
);

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

export function buildGemsProfilesetLines(parsed: ParsedExport): string {
  const socketedEquipped: ParsedItem[] = parsed.equipped.filter(
    (i) => i.extras?.['gem_id'] || i.extras?.['gem_id'] === '0',
  );
  if (socketedEquipped.length === 0) return '';

  const blocks: string[] = [];
  for (const candidate of GEM_CANDIDATES) {
    for (const item of socketedEquipped) {
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
  if (item.extras?.['enchant_id']) {
    parts.push(`enchant_id=${item.extras['enchant_id']}`);
  }
  return parts.join(',');
}

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
    label: 'Best gem allocation',
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
