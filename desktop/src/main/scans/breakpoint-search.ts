/**
 * Breakpoint phase — runs after greedy convergence to catch multi-item
 * synergies greedy can't see (e.g. two haste pieces that together cross
 * the GCD floor when neither alone is an upgrade).
 *
 * v1 ships exhaustive 2-and-3 cartesian over greedy's rejected items.
 * For typical bag sizes (5-15 rejects) this is 20-300 sims, much
 * cheaper than the old full cartesian. Heuristic narrowing for huge
 * rejected pools (15+) is a follow-up slice — capping the cartesian to
 * top-K-by-ilvl is the simple guard rail in this slice.
 *
 * Combos must use items from different slots (you can't swap two
 * chests in simultaneously — they'd compete and degrade to a single-
 * item swap, which greedy already handled). Rings and trinkets are an
 * exception: a pair of rings in `finger1`+`finger2` IS a valid 2-item
 * combo because each occupies a different physical slot.
 */

import type { ParsedItem, SlotName } from '../simc-export-parser';
import { formatItemLine } from '../simc-export-parser';
import type { BestLoadoutSlot } from '../gear-catalog';
import { runSimc, type RunnerPaths, type SimcRunResult } from '../simc-runner';
import { MAX_BREAKPOINT_COMBOS } from '../gear-config';
import {
  buildDiagnosticEntry,
  buildStatVectorDiagnosticEntry,
  predictComboDps,
  predictDpsFromAggregatedStatDelta,
  type DiagnosticEntry,
  type StatWeightsLike,
} from './pruner-diagnostic';

const BASELINE_NAME = 'bp_baseline';
const MAX_REJECTED_FOR_TRIPLES = 15;
const MAX_REJECTED_FOR_PAIRS = 30;

export interface BreakpointCombo {
  /** Stable id used as the profileset name; deterministic from member identities. */
  id: string;
  /**
   * The items that swap into the converged loadout for this combo.
   * Map from physical slot (the combo's swap target) to item.
   */
  swaps: Record<string, ParsedItem>;
}

export interface BreakpointResult {
  /** Converged-baseline DPS measured by the breakpoint sim. */
  baseline_dps: number;
  /** Per-combo result, sorted by mean_dps descending. */
  combos: Array<{
    combo: BreakpointCombo;
    mean_dps: number;
    delta_pct: number;
  }>;
  /** Winner combo if any beat the converged baseline by more than the tie window. */
  winner: BreakpointCombo | undefined;
  /** Diagnostic entries (one per combo simmed). */
  diagnostics: DiagnosticEntry[];
}

export interface RunBreakpointSearchOptions {
  paths: RunnerPaths;
  baseProfile: string;
  converged: Record<string, ParsedItem>;
  rejected: readonly ParsedItem[];
  iterations?: number;
  /** Tie window for "is_winner" determination; default 0.1 %. */
  tieWindowPct?: number;
  dpsPerIlvlPct: number;
  /**
   * Per-stat DPS-per-+1 weights. When present AND every item involved in
   * a combo (incumbents + candidates) carries `raw_stats`, the diagnostic
   * line uses the precise stat-vector prediction (matching greedy). Falls
   * back to ilvl-proxy on a per-combo basis when stats are missing.
   */
  weights?: StatWeightsLike;
  /**
   * Estimated converged-loadout DPS. Used by `prioritizeCombos` to
   * convert ilvl-proxy deltas into commensurate absolute DPS for
   * ordering. The catalog's `best_loadout_dps` is the natural source;
   * a missing or zero value just disables ilvl-score scaling, leaving
   * stat-vector scores intact and ilvl scores all at 0 (stable order
   * among ilvl-only combos). Default 0.
   */
  estimatedBaselineDps?: number;
  /**
   * Override for `MAX_BREAKPOINT_COMBOS`. Tests pass a small value (e.g.
   * 2) to force the cap to bite without generating hundreds of items.
   */
  maxCombos?: number;
  onProgress?: Parameters<typeof runSimc>[0]['onProgress'];
}

/**
 * Generate every valid 2-item and 3-item combo from the rejected pool.
 *
 * Validity rules:
 *   - Items in a combo must occupy DIFFERENT physical slots, with the
 *     ring/trinket exception (a finger1 ring + a finger2 ring IS a
 *     valid 2-combo even though they're both rings).
 *   - Triples are skipped when |rejected| > MAX_REJECTED_FOR_TRIPLES
 *     to keep total combo count reasonable.
 *   - Pairs are capped at MAX_REJECTED_FOR_PAIRS — items beyond that
 *     are dropped entirely (call site should top-K by ilvl first if
 *     this matters).
 */
export function generateCombos(rejected: readonly ParsedItem[]): BreakpointCombo[] {
  const items = rejected.slice(0, MAX_REJECTED_FOR_PAIRS);
  const combos: BreakpointCombo[] = [];

  // Pairs.
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]!;
      const b = items[j]!;
      const swaps = pairSwaps(a, b);
      if (!swaps) continue;
      combos.push({ id: `bp2_${comboHash([a, b])}`, swaps });
    }
  }

  // Triples — only when rejected pool is small enough.
  if (items.length <= MAX_REJECTED_FOR_TRIPLES) {
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        for (let k = j + 1; k < items.length; k++) {
          const a = items[i]!;
          const b = items[j]!;
          const c = items[k]!;
          const swaps = tripleSwaps(a, b, c);
          if (!swaps) continue;
          combos.push({ id: `bp3_${comboHash([a, b, c])}`, swaps });
        }
      }
    }
  }

  return combos;
}

/**
 * Best-available predicted DPS delta for a combo against the converged
 * loadout. Returns the stat-vector estimate when every involved item
 * (both incumbents and candidates) carries `raw_stats` AND weights are
 * supplied; otherwise falls back to the ilvl-proxy estimate. Pure
 * function — no I/O, no SimC.
 *
 * Used to ORDER combos before the SimC sim runs so that:
 *   - when a cap bites (rejected pool large), we keep the predicted
 *     strongest combos rather than just the first ones the index
 *     iteration produced;
 *   - even within the cap, SimC streams progress in our chosen order,
 *     so the early profilesets are the most likely upgrades — the user
 *     sees DPS movement on the strongest combos first.
 *
 * Stat-vector predictions are an approximation (proc effects, breakpoint
 * thresholds invisible) so the ordering is heuristic — the sim still
 * decides the winner.
 */
export function predictComboScore(args: {
  combo: BreakpointCombo;
  converged: Record<string, ParsedItem>;
  weights?: StatWeightsLike;
  dpsPerIlvlPct: number;
  baseline_dps: number;
}): number {
  const swapsForPredict = Object.entries(args.combo.swaps).map(([slot, item]) => ({
    candidate_ilvl: item.ilvl,
    incumbent_ilvl: args.converged[slot]?.ilvl ?? item.ilvl,
  }));
  const ilvlScore = predictComboDps({
    swaps: swapsForPredict,
    baseline_dps: args.baseline_dps,
    dps_per_ilvl_pct: args.dpsPerIlvlPct,
  });

  if (!args.weights) return ilvlScore;
  const incRaw: NonNullable<ParsedItem['raw_stats']>[] = [];
  const candRaw: NonNullable<ParsedItem['raw_stats']>[] = [];
  for (const [slot, candItem] of Object.entries(args.combo.swaps)) {
    const incItem = args.converged[slot];
    if (!candItem.raw_stats || !incItem?.raw_stats) return ilvlScore;
    candRaw.push(candItem.raw_stats);
    incRaw.push(incItem.raw_stats);
  }
  const { predicted_delta_dps } = predictDpsFromAggregatedStatDelta({
    incumbents: incRaw,
    candidates: candRaw,
    weights: args.weights,
  });
  return predicted_delta_dps;
}

/**
 * Score every generated combo, sort descending by predicted delta, and
 * truncate to `maxCombos`. Returns the ordered subset SimC should sim,
 * each annotated with the predicted score it was selected on.
 *
 * Used as the bridge between `generateCombos` (which produces all valid
 * pair/triple combos from the rejected pool) and `buildBreakpointScript`
 * (which emits profilesets for whatever it's handed). When the rejected
 * pool is small, every combo survives and ordering becomes a pure UX
 * win (progress bar shows strong combos first). When the pool is large,
 * the cap drops the predicted weakest before any sim time is spent.
 *
 * The `baseline_dps` argument is the expected DPS of the converged
 * loadout — used to convert ilvl-proxy deltas into absolute DPS so
 * stat-vector and ilvl scores are roughly commensurate. Pass the
 * catalog's `best_loadout_dps` (or any reasonable estimate) — a wrong
 * value just shifts ilvl-proxy scores uniformly, preserving relative
 * order between ilvl-scored combos.
 */
export function prioritizeCombos(args: {
  combos: readonly BreakpointCombo[];
  converged: Record<string, ParsedItem>;
  weights?: StatWeightsLike;
  dpsPerIlvlPct: number;
  baseline_dps: number;
  maxCombos?: number;
}): Array<{ combo: BreakpointCombo; predicted_score: number }> {
  const scored = args.combos.map((combo) => ({
    combo,
    predicted_score: predictComboScore({
      combo,
      converged: args.converged,
      weights: args.weights,
      dpsPerIlvlPct: args.dpsPerIlvlPct,
      baseline_dps: args.baseline_dps,
    }),
  }));
  scored.sort((a, b) => b.predicted_score - a.predicted_score);
  const cap = args.maxCombos ?? MAX_BREAKPOINT_COMBOS;
  return scored.slice(0, cap);
}

/** Returns the swap map for a 2-item combo, or null if items can't co-exist. */
function pairSwaps(a: ParsedItem, b: ParsedItem): Record<string, ParsedItem> | null {
  // Same physical slot, neither ring nor trinket → invalid.
  if (a.slot === b.slot && !isPaired(a.slot)) return null;
  // Two rings → assign one to finger1, the other to finger2.
  if (isRing(a.slot) && isRing(b.slot)) {
    return { finger1: a, finger2: b };
  }
  // Two trinkets → assign to trinket1/trinket2.
  if (isTrinket(a.slot) && isTrinket(b.slot)) {
    return { trinket1: a, trinket2: b };
  }
  // One paired + one regular OR two regulars in different slots.
  return { [a.slot]: a, [b.slot]: b };
}

function tripleSwaps(
  a: ParsedItem,
  b: ParsedItem,
  c: ParsedItem,
): Record<string, ParsedItem> | null {
  // Triple slot allocation gets messy with paired slots — be conservative.
  // Drop triples that contain duplicate non-paired slots OR more than
  // 2 ring/trinket instances.
  const items = [a, b, c];
  const ringCount = items.filter((i) => isRing(i.slot)).length;
  const trinketCount = items.filter((i) => isTrinket(i.slot)).length;
  if (ringCount > 2) return null;
  if (trinketCount > 2) return null;

  const out: Record<string, ParsedItem> = {};
  let ringSlotsUsed = 0;
  let trinketSlotsUsed = 0;
  for (const it of items) {
    if (isRing(it.slot)) {
      const target = ringSlotsUsed === 0 ? 'finger1' : 'finger2';
      if (out[target]) return null; // shouldn't happen given ringCount cap
      out[target] = it;
      ringSlotsUsed += 1;
    } else if (isTrinket(it.slot)) {
      const target = trinketSlotsUsed === 0 ? 'trinket1' : 'trinket2';
      if (out[target]) return null;
      out[target] = it;
      trinketSlotsUsed += 1;
    } else {
      if (out[it.slot]) return null; // duplicate non-paired slot
      out[it.slot] = it;
    }
  }
  return out;
}

function isRing(slot: string): boolean {
  return slot === 'finger1' || slot === 'finger2';
}
function isTrinket(slot: string): boolean {
  return slot === 'trinket1' || slot === 'trinket2';
}
function isPaired(slot: string): boolean {
  return isRing(slot) || isTrinket(slot);
}

function comboHash(items: readonly ParsedItem[]): string {
  // Sort by identity so order doesn't change the hash.
  const sorted = [...items].map((i) => i.identity).sort();
  let h = 0x811c9dc5;
  for (const id of sorted) {
    for (let i = 0; i < id.length; i++) {
      h ^= id.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  }
  return (h >>> 0).toString(36);
}

export interface BuildBreakpointScriptResult {
  script: string;
  combos: BreakpointCombo[];
  baselineName: string;
}

/**
 * Build a SimC profileset script with one baseline + one profileset
 * per combo. Each profileset spells out every loadout slot, overriding
 * the combo's slots with the combo's items.
 */
export function buildBreakpointScript(
  converged: Record<string, ParsedItem>,
  combos: readonly BreakpointCombo[],
): BuildBreakpointScriptResult {
  const lines: string[] = [];

  // Baseline: spell out the full converged loadout.
  for (const [slot, item] of Object.entries(converged)) {
    lines.push(`profileset."${BASELINE_NAME}"+="${formatItemLine(item, slot as SlotName)}"`);
  }

  for (const combo of combos) {
    for (const [slot, item] of Object.entries(converged)) {
      // Override slots that this combo replaces; pass through everything else.
      const override = combo.swaps[slot];
      const lineItem = override ?? item;
      lines.push(`profileset."${combo.id}"+="${formatItemLine(lineItem, slot as SlotName)}"`);
    }
    // Edge case: a combo's swap targets a slot the loadout doesn't have
    // (e.g. converged is a 2H wielder but the combo includes an off-hand).
    // For now we skip those slots — converged's structure wins.
  }

  return { script: lines.join('\n'), combos: [...combos], baselineName: BASELINE_NAME };
}

export function parseBreakpointResult(args: {
  run: SimcRunResult;
  build: BuildBreakpointScriptResult;
  tieWindowPct: number;
}): {
  baseline_dps: number;
  combos: BreakpointResult['combos'];
  winner: BreakpointCombo | undefined;
} {
  const psByName = new Map<string, number>();
  for (const ps of args.run.profilesets) psByName.set(ps.name, ps.mean);
  const baseline_dps = psByName.get(args.build.baselineName) ?? 0;

  const combos = args.build.combos
    .map((combo) => {
      const mean_dps = psByName.get(combo.id) ?? 0;
      const delta_pct = baseline_dps > 0
        ? ((mean_dps - baseline_dps) / baseline_dps) * 100
        : 0;
      return { combo, mean_dps, delta_pct };
    })
    .filter((c) => c.mean_dps > 0)
    .sort((a, b) => b.mean_dps - a.mean_dps);

  const winner = combos.length > 0 && combos[0]!.delta_pct > args.tieWindowPct
    ? combos[0]!.combo
    : undefined;

  return { baseline_dps, combos, winner };
}

export async function runBreakpointSearch(
  opts: RunBreakpointSearchOptions,
): Promise<BreakpointResult> {
  const tieWindowPct = opts.tieWindowPct ?? 0.1;
  const allCombos = generateCombos(opts.rejected);

  // Empty case — nothing to test.
  if (allCombos.length === 0) {
    return {
      baseline_dps: 0,
      combos: [],
      winner: undefined,
      diagnostics: [],
    };
  }

  // Score-and-truncate: sort by best-available predicted delta, drop
  // anything beyond the cap. Profilesets land in SimC in this order so
  // even when no truncation happens, progress shows strong combos first.
  const prioritized = prioritizeCombos({
    combos: allCombos,
    converged: opts.converged,
    weights: opts.weights,
    dpsPerIlvlPct: opts.dpsPerIlvlPct,
    baseline_dps: opts.estimatedBaselineDps ?? 0,
    maxCombos: opts.maxCombos,
  });
  const orderedCombos = prioritized.map((p) => p.combo);

  const build = buildBreakpointScript(opts.converged, orderedCombos);
  const profileScript = [opts.baseProfile.trim(), '', build.script].join('\n');
  const run = await runSimc({
    paths: opts.paths,
    profileScript,
    iterations: opts.iterations ?? 3000,
    scratchTag: `breakpoint-${Date.now()}`,
    onProgress: opts.onProgress,
  });

  const parsed = parseBreakpointResult({ run, build, tieWindowPct });

  const diagnostics = buildBreakpointDiagnostics({
    combos: parsed.combos,
    baseline_dps: parsed.baseline_dps,
    winnerId: parsed.winner?.id,
    converged: opts.converged,
    weights: opts.weights,
    dpsPerIlvlPct: opts.dpsPerIlvlPct,
    tieWindowPct,
  });

  return {
    baseline_dps: parsed.baseline_dps,
    combos: parsed.combos,
    winner: parsed.winner,
    diagnostics,
  };
}

/**
 * Pure helper: build per-combo diagnostic entries from a breakpoint sim's
 * parsed results. Mirrors greedy-search's stat-vector path — when every
 * item involved in a combo (incumbents AND candidates) has `raw_stats`
 * AND weights are supplied, emits a `buildStatVectorDiagnosticEntry`
 * with `unexplained_pp` populated. Otherwise falls back to the legacy
 * ilvl-proxy entry. Decision is per-combo, not per-batch.
 *
 * Extracted from runBreakpointSearch so it can be unit-tested without
 * mocking SimC.
 */
export function buildBreakpointDiagnostics(args: {
  combos: BreakpointResult['combos'];
  baseline_dps: number;
  winnerId: string | undefined;
  converged: Record<string, ParsedItem>;
  weights?: StatWeightsLike;
  dpsPerIlvlPct: number;
  tieWindowPct: number;
}): DiagnosticEntry[] {
  return args.combos.map((entry) => {
    const swapsForPredict = Object.entries(entry.combo.swaps).map(([slot, item]) => ({
      candidate_ilvl: item.ilvl,
      incumbent_ilvl: args.converged[slot]?.ilvl ?? item.ilvl,
    }));
    const predicted_delta_dps_ilvl = predictComboDps({
      swaps: swapsForPredict,
      baseline_dps: args.baseline_dps,
      dps_per_ilvl_pct: args.dpsPerIlvlPct,
    });
    const isWinner = args.winnerId === entry.combo.id;
    const isUpgrade = entry.delta_pct > args.tieWindowPct;
    const outcome: DiagnosticEntry['outcome'] = isWinner ? 'winner' : isUpgrade ? 'accepted' : 'loser';
    const label = `breakpoint ${labelForCombo(entry.combo)}`;

    // Stat-vector path: every involved item (both sides) needs raw_stats
    // AND we need weights. Otherwise fall back to ilvl-proxy for this
    // combo. The fallback is per-combo, not per-batch — mixed batches
    // are fine.
    const incRaw: NonNullable<ParsedItem['raw_stats']>[] = [];
    const candRaw: NonNullable<ParsedItem['raw_stats']>[] = [];
    let allHaveStats = !!args.weights;
    for (const [slot, candItem] of Object.entries(entry.combo.swaps)) {
      const incItem = args.converged[slot];
      if (!candItem.raw_stats || !incItem?.raw_stats) {
        allHaveStats = false;
        break;
      }
      candRaw.push(candItem.raw_stats);
      incRaw.push(incItem.raw_stats);
    }

    if (allHaveStats && args.weights) {
      const { predicted_delta_dps } = predictDpsFromAggregatedStatDelta({
        incumbents: incRaw,
        candidates: candRaw,
        weights: args.weights,
      });
      return buildStatVectorDiagnosticEntry({
        label,
        baseline_dps: args.baseline_dps,
        candidate_dps: entry.mean_dps,
        predicted_delta_dps_ilvl,
        predicted_delta_dps_stat_vector: predicted_delta_dps,
        outcome,
      });
    }

    return buildDiagnosticEntry({
      label,
      baseline_dps: args.baseline_dps,
      candidate_dps: entry.mean_dps,
      predicted_delta_dps: predicted_delta_dps_ilvl,
      outcome,
    });
  });
}

function labelForCombo(combo: BreakpointCombo): string {
  const parts = Object.entries(combo.swaps).map(
    ([slot, item]) => `${slot}=${item.name}`,
  );
  const size = parts.length === 2 ? 'pair' : parts.length === 3 ? 'triple' : 'combo';
  return `${size} {${parts.join(', ')}}`;
}

/**
 * Apply a winning breakpoint combo to the converged loadout, returning
 * a new loadout with the combo's swaps applied.
 */
export function applyComboToLoadout(
  converged: Record<string, ParsedItem>,
  combo: BreakpointCombo,
): Record<string, ParsedItem> {
  const next = { ...converged };
  for (const [slot, item] of Object.entries(combo.swaps)) {
    next[slot] = item;
  }
  return next;
}

/** Convert a loadout to BestLoadoutSlot for catalog/composer integration. */
export function loadoutToBestLoadoutSlots(
  loadout: Record<string, ParsedItem>,
): Record<string, BestLoadoutSlot> {
  const out: Record<string, BestLoadoutSlot> = {};
  for (const [slot, item] of Object.entries(loadout)) {
    out[slot] = {
      slot,
      item_id: item.item_id,
      name: item.name,
      identity: item.identity,
      ilvl: item.ilvl,
    };
  }
  return out;
}
