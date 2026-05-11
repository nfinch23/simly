/**
 * Predicted-vs-actual diagnostic helpers for the greedy gear search.
 *
 * Reuses `computeDpsPerIlvlPct` from gear-pruner.ts as the "predicted"
 * estimate. For each simmed item swap or combo, we know the actual DPS
 * change. The diagnostic compares the two and emits a console line so
 * the user can see how reliable stat-weight predictions are in practice.
 *
 * Once enough diagnostic data accumulates we know how aggressive the
 * pruner can safely be — that's the input to a future "lower the
 * multiplier" follow-up slice.
 *
 * NOTE: this slice uses ilvl-based prediction (the existing pruner math)
 * rather than per-stat-vector prediction. A future extension could parse
 * `buffed_stats` per profileset out of SimC's JSON report and compute
 * stat-weight × stat-delta for a more precise estimate. For first-cut
 * calibration the ilvl proxy is good enough — primary scales 1:1 with
 * ilvl and secondary budget is roughly proportional too.
 */

export interface DiagnosticEntry {
  /** Human-friendly description, e.g. "greedy iter 2: chest=Lightbinder Shoulderguards" or "breakpoint pair: {chest_haste, gloves_haste}". */
  label: string;
  /** Predicted DPS gain in absolute DPS (positive = upgrade). */
  predicted_delta_dps: number;
  /** Actual DPS gain in absolute DPS (positive = upgrade). */
  actual_delta_dps: number;
  /** Predicted gain as a percentage of baseline DPS. */
  predicted_pct: number;
  /** Actual gain as a percentage of baseline DPS. */
  actual_pct: number;
  /**
   * Error in percentage points: predicted_pct - actual_pct.
   * Positive = stat-weights over-predicted (pruner could be safer to be
   * more aggressive). Negative = stat-weights under-predicted (we found
   * a hidden gain — possible breakpoint or proc effect we didn't model).
   */
  error_pp: number;
  /** Status tag the formatter renders, e.g. "ACCEPTED", "REJECTED", "WINNER". */
  outcome: 'accepted' | 'rejected' | 'winner' | 'loser' | 'baseline';
  /**
   * Precise stat-vector × stat-weights prediction in DPS. Populated when
   * the addon-supplied raw_stats are available for both incumbent + candidate.
   * Different from `predicted_delta_dps` (which uses the ilvl-proxy fallback
   * when raw_stats are missing). When both are present, exposes
   * `unexplained_dps` = actual - stat_vector_predicted as the "structural gap"
   * — weapon damage / procs / set bonuses that stat weights can't see.
   */
  predicted_delta_dps_stat_vector?: number;
  /** Stat-vector prediction as a percentage of baseline DPS. */
  predicted_pct_stat_vector?: number;
  /** actual_delta_dps - predicted_delta_dps_stat_vector. Positive = unexplained gain. */
  unexplained_dps?: number;
  /** unexplained_dps as percentage points of baseline_dps. */
  unexplained_pp?: number;
}

/**
 * Build a DiagnosticEntry from a baseline DPS, a candidate's actual DPS,
 * and the predicted delta (computed externally from ilvl × dpsPerIlvlPct
 * or stat × stat_weights). All inputs are absolute DPS numbers.
 */
export function buildDiagnosticEntry(args: {
  label: string;
  baseline_dps: number;
  candidate_dps: number;
  predicted_delta_dps: number;
  outcome: DiagnosticEntry['outcome'];
}): DiagnosticEntry {
  const actual_delta_dps = args.candidate_dps - args.baseline_dps;
  const predicted_pct = args.baseline_dps > 0
    ? (args.predicted_delta_dps / args.baseline_dps) * 100
    : 0;
  const actual_pct = args.baseline_dps > 0
    ? (actual_delta_dps / args.baseline_dps) * 100
    : 0;
  const error_pp = predicted_pct - actual_pct;
  return {
    label: args.label,
    predicted_delta_dps: args.predicted_delta_dps,
    actual_delta_dps,
    predicted_pct,
    actual_pct,
    error_pp,
    outcome: args.outcome,
  };
}

/**
 * Predicted DPS gain for swapping a candidate item into a slot whose
 * incumbent has `incumbent_ilvl`. Uses the ilvl × dpsPerIlvlPct formula
 * from gear-pruner — primary scales 1:1, secondary roughly linearly.
 *
 * Returns absolute DPS, signed (positive = upgrade prediction).
 */
export function predictItemSwapDps(args: {
  candidate_ilvl: number;
  incumbent_ilvl: number;
  baseline_dps: number;
  dps_per_ilvl_pct: number;
}): number {
  const ilvl_delta = args.candidate_ilvl - args.incumbent_ilvl;
  const predicted_pct = ilvl_delta * args.dps_per_ilvl_pct;
  return args.baseline_dps * (predicted_pct / 100);
}

/**
 * Predicted DPS gain for a multi-item combo swap. Sums the per-item
 * ilvl deltas (each measured against the slot's current incumbent) and
 * applies dps_per_ilvl_pct to the total. This is the same linear model
 * the pruner uses for its scoring — adequate for first-cut diagnostic.
 */
export function predictComboDps(args: {
  swaps: Array<{ candidate_ilvl: number; incumbent_ilvl: number }>;
  baseline_dps: number;
  dps_per_ilvl_pct: number;
}): number {
  const total_ilvl_delta = args.swaps.reduce(
    (sum, s) => sum + (s.candidate_ilvl - s.incumbent_ilvl),
    0,
  );
  const predicted_pct = total_ilvl_delta * args.dps_per_ilvl_pct;
  return args.baseline_dps * (predicted_pct / 100);
}

/**
 * Stat-vector × stat-weights DPS prediction. Used when the addon
 * supplied raw_stats per item via the `simly_stats=` annotation.
 *
 * Math: sum over each stat of (delta × weight). The "delta" is RAW
 * stat delta (pre-buff), but SimC's --scale_factors weights are
 * computed by adding +1 RAW stat to the buffed actor and measuring
 * DPS change, so `raw_delta × weight` is correct DPS — no buff
 * multiplier needed.
 *
 * The "structural gap" the caller computes (actual - predicted) is the
 * always-sim signal: large gap → weapon damage / proc / set bonus /
 * embellishment that isn't expressible as a stat.
 */
export interface ItemRawStatsLike {
  intellect: number;
  strength: number;
  agility: number;
  haste_rating: number;
  crit_rating: number;
  mastery_rating: number;
  versatility_rating: number;
}

export interface StatWeightsLike {
  intellect?: number;
  strength?: number;
  agility?: number;
  haste?: number;
  crit?: number;
  mastery?: number;
  versatility?: number;
}

export function predictDpsFromStatDelta(args: {
  incumbent: ItemRawStatsLike;
  candidate: ItemRawStatsLike;
  weights: StatWeightsLike;
}): {
  predicted_delta_dps: number;
  per_stat_contributions: Record<string, number>;
} {
  return predictDpsFromAggregatedStatDelta({
    incumbents: [args.incumbent],
    candidates: [args.candidate],
    weights: args.weights,
  });
}

/**
 * Multi-item version of `predictDpsFromStatDelta` for swaps that lose
 * AND/OR gain more than one item simultaneously. The two cases that
 * actually matter today:
 *   - 2H weapon replacing 1H + OH:    incumbents=[mh, oh], candidates=[2h]
 *   - 1H + OH replacing 2H weapon:    incumbents=[2h], candidates=[mh, oh]
 *
 * Sums raw_stats across each side, then runs the same per-stat
 * (delta × weight) math as the single-item path. An incumbent set with
 * length 1 and candidate set with length 1 is exactly equivalent to
 * `predictDpsFromStatDelta` (which now delegates here).
 *
 * Empty input arrays are valid (treated as zero-stat sets), so e.g.
 * "remove an off-hand without replacement" can be expressed as
 * incumbents=[oh], candidates=[].
 */
export function predictDpsFromAggregatedStatDelta(args: {
  incumbents: readonly ItemRawStatsLike[];
  candidates: readonly ItemRawStatsLike[];
  weights: StatWeightsLike;
}): {
  predicted_delta_dps: number;
  per_stat_contributions: Record<string, number>;
} {
  const sumStats = (items: readonly ItemRawStatsLike[]): ItemRawStatsLike => {
    const acc: ItemRawStatsLike = {
      intellect: 0, strength: 0, agility: 0,
      haste_rating: 0, crit_rating: 0, mastery_rating: 0, versatility_rating: 0,
    };
    for (const i of items) {
      acc.intellect += i.intellect;
      acc.strength += i.strength;
      acc.agility += i.agility;
      acc.haste_rating += i.haste_rating;
      acc.crit_rating += i.crit_rating;
      acc.mastery_rating += i.mastery_rating;
      acc.versatility_rating += i.versatility_rating;
    }
    return acc;
  };

  const inc = sumStats(args.incumbents);
  const cand = sumStats(args.candidates);
  const dInt = cand.intellect - inc.intellect;
  const dStr = cand.strength - inc.strength;
  const dAgi = cand.agility - inc.agility;
  const dHaste = cand.haste_rating - inc.haste_rating;
  const dCrit = cand.crit_rating - inc.crit_rating;
  const dMastery = cand.mastery_rating - inc.mastery_rating;
  const dVers = cand.versatility_rating - inc.versatility_rating;
  const c_int = dInt * (args.weights.intellect ?? 0);
  const c_str = dStr * (args.weights.strength ?? 0);
  const c_agi = dAgi * (args.weights.agility ?? 0);
  const c_haste = dHaste * (args.weights.haste ?? 0);
  const c_crit = dCrit * (args.weights.crit ?? 0);
  const c_mastery = dMastery * (args.weights.mastery ?? 0);
  const c_vers = dVers * (args.weights.versatility ?? 0);
  return {
    predicted_delta_dps: c_int + c_str + c_agi + c_haste + c_crit + c_mastery + c_vers,
    per_stat_contributions: {
      intellect: c_int, strength: c_str, agility: c_agi,
      haste: c_haste, crit: c_crit, mastery: c_mastery, versatility: c_vers,
    },
  };
}

/**
 * Build a DiagnosticEntry that includes both the legacy ilvl-proxy
 * prediction AND a precise stat-vector prediction. Exposes `unexplained_pp`
 * — the structural gap, the always-sim signal.
 */
export function buildStatVectorDiagnosticEntry(args: {
  label: string;
  baseline_dps: number;
  candidate_dps: number;
  predicted_delta_dps_ilvl: number;
  predicted_delta_dps_stat_vector: number;
  outcome: DiagnosticEntry['outcome'];
}): DiagnosticEntry {
  const actual_delta_dps = args.candidate_dps - args.baseline_dps;
  const pct = (n: number): number =>
    args.baseline_dps > 0 ? (n / args.baseline_dps) * 100 : 0;
  const predicted_pct = pct(args.predicted_delta_dps_ilvl);
  const actual_pct = pct(actual_delta_dps);
  const predicted_pct_stat_vector = pct(args.predicted_delta_dps_stat_vector);
  // Unexplained: positive = sim found gain stat-vector couldn't account for.
  const unexplained_dps = actual_delta_dps - args.predicted_delta_dps_stat_vector;
  const unexplained_pp = actual_pct - predicted_pct_stat_vector;
  return {
    label: args.label,
    predicted_delta_dps: args.predicted_delta_dps_ilvl,
    actual_delta_dps,
    predicted_pct,
    actual_pct,
    error_pp: predicted_pct - actual_pct,
    outcome: args.outcome,
    predicted_delta_dps_stat_vector: args.predicted_delta_dps_stat_vector,
    predicted_pct_stat_vector,
    unexplained_dps,
    unexplained_pp,
  };
}

/**
 * Format a single diagnostic entry as a one-line console string with
 * the [diagnostic] prefix. Matches the format in the slice plan:
 *   [diagnostic] {label}  predicted={X%} ({+N dps})  actual={Y%} ({+M dps})  error={Z}pp  →  {OUTCOME}
 */
export function formatDiagnosticLine(entry: DiagnosticEntry): string {
  const fmt_pct = (n: number): string =>
    `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
  const fmt_dps = (n: number): string =>
    `${n >= 0 ? '+' : ''}${Math.round(n)} dps`;
  const fmt_pp = (n: number): string =>
    `${n >= 0 ? '+' : ''}${n.toFixed(2)}pp`;
  const outcome_tag = entry.outcome.toUpperCase();

  if (entry.predicted_pct_stat_vector !== undefined && entry.unexplained_pp !== undefined) {
    return (
      `[diagnostic] ${entry.label}  ` +
      `predicted (stat-vector)=${fmt_pct(entry.predicted_pct_stat_vector)} (${fmt_dps(entry.predicted_delta_dps_stat_vector ?? 0)})  ` +
      `actual=${fmt_pct(entry.actual_pct)} (${fmt_dps(entry.actual_delta_dps)})  ` +
      `unexplained=${fmt_pp(entry.unexplained_pp)} (${fmt_dps(entry.unexplained_dps ?? 0)})  →  ${outcome_tag}`
    );
  }

  return (
    `[diagnostic] ${entry.label}  ` +
    `predicted=${fmt_pct(entry.predicted_pct)} (${fmt_dps(entry.predicted_delta_dps)})  ` +
    `actual=${fmt_pct(entry.actual_pct)} (${fmt_dps(entry.actual_delta_dps)})  ` +
    `error=${fmt_pp(entry.error_pp)}  →  ${outcome_tag}`
  );
}

export interface DiagnosticSummary {
  label: string;
  count: number;
  mean_error_pp: number;
  p50_error_pp: number;
  p90_error_pp: number;
  max_abs_error_pp: number;
}

/**
 * Aggregate a batch of diagnostic entries into per-stage summary stats.
 * Used to print a one-line summary at the end of greedy / breakpoint
 * stages so the user gets a trend at a glance without scrolling through
 * every combo.
 *
 * Metric source: prefers `unexplained_pp` (stat-vector prediction error)
 * over `error_pp` (legacy ilvl-proxy error) on a per-entry basis. The
 * field names on the returned summary keep the legacy `_error_pp` suffix
 * for back-compat, but their *meaning* tracks whichever signal each
 * entry made available — stat-vector when the addon supplied raw_stats
 * + weights are known, ilvl-proxy otherwise. For weapon swaps the ilvl
 * proxy is structurally wrong (sums ilvls across slots), inflating
 * `max_abs` to ~13pp; the truth lives in unexplained_pp.
 */
export function summarizeDiagnostics(
  entries: readonly DiagnosticEntry[],
  label: string,
): DiagnosticSummary {
  if (entries.length === 0) {
    return {
      label,
      count: 0,
      mean_error_pp: 0,
      p50_error_pp: 0,
      p90_error_pp: 0,
      max_abs_error_pp: 0,
    };
  }
  const errors = entries.map((e) =>
    e.unexplained_pp !== undefined ? e.unexplained_pp : e.error_pp,
  );
  const sorted_errors = [...errors].sort((a, b) => a - b);
  const sorted_abs = [...errors].map(Math.abs).sort((a, b) => a - b);
  const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
  const p50 = sorted_errors[Math.floor(sorted_errors.length / 2)] ?? 0;
  const p90_idx = Math.min(sorted_abs.length - 1, Math.floor(sorted_abs.length * 0.9));
  const p90 = sorted_abs[p90_idx] ?? 0;
  const max_abs = sorted_abs[sorted_abs.length - 1] ?? 0;
  return {
    label,
    count: entries.length,
    mean_error_pp: mean,
    p50_error_pp: p50,
    p90_error_pp: p90,
    max_abs_error_pp: max_abs,
  };
}

export function formatDiagnosticSummary(s: DiagnosticSummary): string {
  const fmt = (n: number): string =>
    `${n >= 0 ? '+' : ''}${n.toFixed(2)}pp`;
  return (
    `[diagnostic] ${s.label} summary: ${s.count} sims, ` +
    `mean_error=${fmt(s.mean_error_pp)}, ` +
    `p50=${fmt(s.p50_error_pp)}, ` +
    `p90_abs=${s.p90_error_pp.toFixed(2)}pp, ` +
    `max_abs=${s.max_abs_error_pp.toFixed(2)}pp`
  );
}
