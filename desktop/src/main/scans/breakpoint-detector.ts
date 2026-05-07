/**
 * Breakpoint heuristic — decides which stats are "live" (i.e. likely
 * sitting near a non-linearity) at the converged greedy baseline.
 *
 * The heuristic uses one signal in this slice: the change in a stat's
 * weight between the original (equipped) baseline and the converged
 * (post-greedy) baseline. A stat-weight that drops sharply means
 * diminishing returns kicked in faster than the linear estimate
 * predicted — a sign the stat is near a knee in the curve. Items
 * heavy in OTHER stats are likely now relatively more valuable than
 * greedy thought when it rejected them, so they're worth re-testing in
 * combination.
 *
 * Future signals (TODO when there's data to calibrate against):
 *   - Hardcoded known breakpoints per spec (haste GCD floor, etc.).
 *     Avoided this slice because expansion-specific values churn.
 *   - Cross-stat trade signals (e.g. mastery DR plus crit cap on the
 *     same item == strong breakpoint candidate).
 */

import type { StatWeights } from '@simly/shared';

const SECONDARY_STATS = [
  'haste',
  'crit',
  'mastery',
  'versatility',
] as const;

export interface DetectLiveStatsOptions {
  weightsOriginal: StatWeights;
  weightsConverged: StatWeights;
  /** A stat is flagged when |Δweight| / |original_weight| exceeds this fraction. Default 0.2 (20%). */
  weightShiftFraction?: number;
}

/**
 * Compute which secondary stats look "live" — i.e. their weight changed
 * meaningfully between the original baseline and the converged baseline.
 * Returns an array of stat names from {haste, crit, mastery, versatility}.
 */
export function detectLiveStats(opts: DetectLiveStatsOptions): string[] {
  const threshold = opts.weightShiftFraction ?? 0.2;
  const live = new Set<string>();

  for (const stat of SECONDARY_STATS) {
    const orig = opts.weightsOriginal[stat] ?? 0;
    const conv = opts.weightsConverged[stat] ?? 0;
    if (orig === 0 && conv === 0) continue;
    if (orig === 0) {
      // Stat went from "irrelevant" to "non-zero" — definitely live.
      live.add(stat);
      continue;
    }
    const fractionalShift = Math.abs(conv - orig) / Math.abs(orig);
    if (fractionalShift > threshold) {
      live.add(stat);
    }
  }

  return [...live];
}

/**
 * Score how well an item's stats push the live-stat axis. Used to pick
 * top-K candidates for the heuristic breakpoint cartesian. The score is
 * the SUM of the item's known stat values for each live stat.
 *
 * NOTE: this slice doesn't have per-item stat vectors (those live in
 * SimC's report, not the export). As a proxy we use ilvl as a uniform
 * stat-budget signal — items with higher ilvl push more total stat
 * budget, and assuming the item's stats are roughly proportional to
 * its slot's typical stat allocation, that's a reasonable rank. A
 * follow-up slice that parses buffed_stats per profileset can replace
 * this with the precise stat-vector dot product.
 */
export function scoreItemForLiveStats(args: {
  itemIlvl: number;
  liveStats: readonly string[];
}): number {
  // Without per-item stats: any live stat → score == ilvl. Gives us a
  // stable ordering by ilvl-budget when liveStats is non-empty, and 0
  // when it's empty (no breakpoint phase needed).
  if (args.liveStats.length === 0) return 0;
  return args.itemIlvl;
}

/**
 * Pick the top K items by live-stat score. Returns at most `k` items,
 * sorted descending by score (then by name for stability).
 */
export function pickTopKForBreakpointPhase<T extends { ilvl: number; name: string }>(
  items: readonly T[],
  liveStats: readonly string[],
  k: number,
): T[] {
  if (liveStats.length === 0 || k <= 0) return [];
  const scored = items.map((it) => ({
    item: it,
    score: scoreItemForLiveStats({ itemIlvl: it.ilvl, liveStats }),
  }));
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.item.name.localeCompare(b.item.name);
  });
  return scored.slice(0, k).map((s) => s.item);
}
