/**
 * Per-MH off-hand picker.
 *
 * When greedy is testing a 1H main_hand candidate, the OH partner
 * matters — different MHs prefer different OHs depending on stat-mix
 * synergy. This module's job: given a specific MH candidate and the
 * pool of OH-eligible items in the bag (plus the currently-equipped OH
 * if it's a 1H+OH baseline), pick the OH that maximizes predicted DPS
 * for that specific MH using stat-vector × stat-weights.
 *
 * Pure pre-filter — no SimC roundtrip. The picked (MH, best_OH) tuple
 * goes into the swap-test as ONE profileset; if multiple OHs were
 * close-call we'd need a sub-sim, but that's a follow-up — picking
 * the highest-stat-vector-predicted OH cuts the dominant case (1H
 * paired with OBVIOUSLY-best OH) without spending sim budget.
 *
 * For 2H MH candidates, returns `bestOH = null` immediately — the
 * weapon swap clears the off-hand slot regardless of bag contents.
 */

import type { ParsedItem } from '../simc-export-parser';
import type { StatWeights } from '@simly/shared';
import { canPairAsOH, classifyWeapon } from './weapon-config';
import { predictDpsFromAggregatedStatDelta } from './pruner-diagnostic';

export interface PickBestOHOptions {
  /** Main_hand candidate the OH is being chosen for. */
  mh: ParsedItem;
  /** Pool of items eligible to fill the off-hand slot. The function
   * filters internally via `canPairAsOH` so callers can pass the full
   * bag pool + current OH; non-eligible items are ignored. */
  ohCandidates: readonly ParsedItem[];
  /** Stat weights from the stat_weights stage. */
  weights: StatWeights;
}

export interface OHRanking {
  oh: ParsedItem;
  /** Predicted DPS contribution of (mh + oh) relative to a zero-OH baseline. Higher = better OH for this MH. */
  predicted_score: number;
}

export interface PickBestOHResult {
  /** Null when MH is 2H (slot locked out) OR no eligible OH exists. */
  bestOH: ParsedItem | null;
  /** All eligible OHs ranked highest → lowest by predicted_score. Useful for diagnostics or future sub-sim. */
  rankedScores: OHRanking[];
}

/**
 * Pick the best OH for a specific MH candidate.
 *
 * Math: for each eligible OH candidate, compute the stat-vector
 * prediction of `(mh + oh)` against an EMPTY incumbent (so the score
 * is the absolute predicted DPS contribution of the pair, not a delta).
 * The best OH is the one that maximizes that score.
 *
 * Items without `raw_stats` (addon hadn't loaded yet, cache miss, etc.)
 * fall back to ilvl-based ordering — pick the highest-ilvl OH.
 */
export function pickBestOHForMH(opts: PickBestOHOptions): PickBestOHResult {
  // 2H MH locks the off-hand slot — no OH possible.
  if (classifyWeapon(opts.mh) === '2H') {
    return { bestOH: null, rankedScores: [] };
  }

  // Filter to eligible OHs (drop accidentally-passed 2H items, non-weapons, etc.).
  const eligible = opts.ohCandidates.filter(canPairAsOH);
  if (eligible.length === 0) {
    return { bestOH: null, rankedScores: [] };
  }

  // Score each eligible OH. Prefer stat-vector prediction; fall back to
  // ilvl ordering when raw_stats are missing on either MH or the OH.
  const canUseStatVector = !!opts.mh.raw_stats;
  const ranked: OHRanking[] = [];
  for (const oh of eligible) {
    let score: number;
    if (canUseStatVector && oh.raw_stats) {
      const { predicted_delta_dps } = predictDpsFromAggregatedStatDelta({
        incumbents: [],                                            // zero-stat baseline
        candidates: [opts.mh.raw_stats!, oh.raw_stats],            // (MH + this OH) total stats
        weights: opts.weights,
      });
      score = predicted_delta_dps;
    } else {
      // ilvl fallback. We want highest-ilvl OH; encode as "score" so the
      // sort below picks the right one.
      score = oh.ilvl;
    }
    ranked.push({ oh, predicted_score: score });
  }

  ranked.sort((a, b) => b.predicted_score - a.predicted_score);
  return { bestOH: ranked[0]!.oh, rankedScores: ranked };
}
