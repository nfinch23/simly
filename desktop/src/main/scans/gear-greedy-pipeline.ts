/**
 * Gear-search pipeline: greedy + breakpoint + polish.
 *
 * Orchestrates the new (post-PR-#10) gear search:
 *   1. Build initial loadout from equipped items.
 *   2. Build bag pool, filtering catalog-classified `trash`.
 *   3. Run iterative greedy until convergence.
 *   4. Run exhaustive 2-and-3 breakpoint cartesian over rejected items.
 *   5. (Optional) high-iter polish on the final winner — single-combo
 *      sim at FINAL_ITERATIONS for high-confidence DPS.
 *   6. Wrap in a GearScanResult shape the composer + catalog consume.
 *
 * The result is written to `scans.gear_final` so the composer
 * (gear_final → gear_refined → gear_coarse fallback) picks it up
 * without changes. Catalog updates use synthetic GearComboResult
 * entries built from greedy and breakpoint observations.
 */

import type { ParsedItem, ParsedExport, SlotName } from '../simc-export-parser';
import type { GearScanResult, GearComboResult, StatWeights } from '@simly/shared';
import type { TrinketLock } from './gear-pruner';
import type { RunnerPaths } from '../simc-runner';
import type { GearCatalogEntry } from '../gear-catalog';
import {
  filterTrashFromBag,
  runGreedyGearSearch,
  type SwapTestRunner,
} from './greedy-search';
import { runBreakpointSearch, applyComboToLoadout } from './breakpoint-search';
import {
  computeDpsPerIlvlPct,
} from './gear-pruner';
import {
  buildDiagnosticEntry,
  formatDiagnosticLine,
  formatDiagnosticSummary,
  predictItemSwapDps,
  summarizeDiagnostics,
  type DiagnosticEntry,
} from './pruner-diagnostic';
import { runSwapTest } from '../swap-test';
import { GEAR_LADDER_SLOTS } from './gear-pruner';

export interface RunGreedyPipelineOptions {
  paths: RunnerPaths;
  baseProfile: string;
  parsed: ParsedExport;
  weights: StatWeights;
  trinketLock?: TrinketLock;
  catalog?: GearCatalogEntry;
  bestLoadoutDps: number;
  greedyIterations: number;
  breakpointIterations: number;
  tieWindowPct?: number;
  onProgress?: Parameters<typeof runSwapTest>[0]['onProgress'];
}

export interface GreedyPipelineResult {
  /** Result wrapped in the GearScanResult shape the composer reads. */
  result: GearScanResult;
  /** Number of greedy iterations consumed. */
  greedyIterations: number;
  /** Number of breakpoint combos simmed. */
  breakpointCombos: number;
  /** All diagnostic entries (greedy + breakpoint), in chronological order. */
  diagnostics: DiagnosticEntry[];
  /** Final converged + breakpoint-applied loadout. */
  finalLoadout: Record<string, ParsedItem>;
  /** Final DPS measured for the winning loadout. */
  finalDps: number;
}

/**
 * Build the initial equipped loadout from a ParsedExport. Walks the
 * equipped items list and indexes by canonical slot name. Skips slots
 * not in GEAR_LADDER_SLOTS (cosmetic/non-DPS slots).
 */
export function buildInitialLoadoutFromExport(
  parsed: ParsedExport,
): Record<string, ParsedItem> {
  const out: Record<string, ParsedItem> = {};
  const ladderSet = new Set<string>(GEAR_LADDER_SLOTS);
  for (const item of parsed.equipped) {
    if (!ladderSet.has(item.slot)) continue;
    out[item.slot] = item;
  }
  return out;
}

/**
 * Build the bag pool eligible for greedy testing: bag items in any
 * GEAR_LADDER slot, with catalog-classified `trash` filtered out.
 * Trinkets are excluded (they have their own pre-scan path) and
 * weapons are kept simple (no 2H/1H mixing — caller should ensure the
 * bag and equipped agree on weapon config or skip weapons).
 */
export function buildBagPool(
  parsed: ParsedExport,
  catalog: GearCatalogEntry | undefined,
): ParsedItem[] {
  const ladderSet = new Set<string>(GEAR_LADDER_SLOTS);
  const candidates = parsed.bag.filter(
    (i) =>
      ladderSet.has(i.slot) &&
      i.slot !== 'trinket1' &&
      i.slot !== 'trinket2',
  );
  return filterTrashFromBag(candidates, catalog);
}

/**
 * Build a synthetic GearComboResult for the final winning loadout.
 * Used as the GearScanResult.winner the composer reads.
 */
function buildWinnerCombo(
  loadout: Record<string, ParsedItem>,
  mean_dps: number,
  combo_id = 'greedy_winner',
): GearComboResult {
  const items = Object.entries(loadout).map(([slot, item]) => ({
    slot,
    item: {
      item_id: item.item_id,
      name: item.name,
      ilvl: item.ilvl,
      identity: item.identity,
    },
  }));
  return { combo_id, items, mean_dps, delta_pct: 0 };
}

/**
 * Stamp ilvl-only synthetic combo entries for diagnostic / catalog
 * inspection. Each combo's `items` field reflects ONE swap relative to
 * the converged loadout, so seen_items classification can read per-
 * item delta_pct directly.
 */
function syntheticComboFromGreedyDiagnostic(
  d: DiagnosticEntry,
  baseline_dps: number,
  baseline: Record<string, ParsedItem>,
  bag: readonly ParsedItem[],
  index: number,
): GearComboResult | null {
  // Parse "greedy iter N: slot=Name" from the label.
  const match = d.label.match(/^greedy iter \d+: ([^=]+)=(.+)$/);
  if (!match) return null;
  const slot = match[1]!;
  const name = match[2]!;
  const item = bag.find((i) => i.name === name && i.slot === slot);
  if (!item) return null;

  // Rebuild the combo as: baseline with `slot` replaced by `item`.
  const swappedLoadout: Record<string, ParsedItem> = { ...baseline, [slot]: item };
  const items = Object.entries(swappedLoadout).map(([s, it]) => ({
    slot: s,
    item: { item_id: it.item_id, name: it.name, ilvl: it.ilvl, identity: it.identity },
  }));
  return {
    combo_id: `greedy_${index}`,
    items,
    mean_dps: baseline_dps + d.actual_delta_dps,
    delta_pct: 0, // recomputed by caller
  };
}

export async function runGreedyGearPipeline(
  opts: RunGreedyPipelineOptions,
): Promise<GreedyPipelineResult> {
  const tieWindowPct = opts.tieWindowPct ?? 0.1;
  const dpsPerIlvlPct = computeDpsPerIlvlPct(opts.weights, opts.bestLoadoutDps);

  const initialLoadout = buildInitialLoadoutFromExport(opts.parsed);
  const bagPool = buildBagPool(opts.parsed, opts.catalog);

  console.log(
    `[gear] greedy pipeline starting: ${Object.keys(initialLoadout).length} equipped slots, ` +
    `${bagPool.length} bag candidates (after trash filter), ` +
    `dpsPerIlvlPct=${dpsPerIlvlPct.toFixed(3)}%`,
  );

  // 1. Greedy phase.
  const swapTestRunner: SwapTestRunner = async (args) => {
    const { result } = await runSwapTest({
      paths: opts.paths,
      baseProfile: opts.baseProfile,
      bestLoadout: args.bestLoadout,
      baselineItemBySlot: args.baselineItemBySlot,
      newItems: args.newItems,
      iterations: opts.greedyIterations,
      tie_window_pct: tieWindowPct,
      onProgress: opts.onProgress,
    });
    return result;
  };

  const greedy = await runGreedyGearSearch({
    initialLoadout,
    bagItems: bagPool,
    dpsPerIlvlPct,
    tieWindowPct,
    runSwapTest: swapTestRunner,
    statWeights: opts.weights,
    baselineDps: opts.bestLoadoutDps,
  });

  // Log per-step diagnostic + summary.
  for (const d of greedy.diagnostics) console.log(formatDiagnosticLine(d));
  console.log(
    formatDiagnosticSummary(summarizeDiagnostics(greedy.diagnostics, 'greedy')),
  );
  console.log(
    `[gear] greedy converged in ${greedy.iterations} iter(s); ${greedy.rejected.length} rejected items remain`,
  );

  let finalLoadout = greedy.converged;
  let finalDps = greedy.convergedDps;
  const allDiagnostics: DiagnosticEntry[] = [...greedy.diagnostics];
  let breakpointCombos = 0;

  // 2. Breakpoint phase — exhaustive 2-and-3 cartesian over rejects.
  if (greedy.rejected.length >= 2) {
    console.log(
      `[gear] breakpoint phase starting: ${greedy.rejected.length} rejected items → ` +
      `up to C(n,2)+C(n,3) combos`,
    );
    const bp = await runBreakpointSearch({
      paths: opts.paths,
      baseProfile: opts.baseProfile,
      converged: greedy.converged,
      rejected: greedy.rejected,
      iterations: opts.breakpointIterations,
      tieWindowPct,
      dpsPerIlvlPct,
      onProgress: opts.onProgress,
    });
    breakpointCombos = bp.combos.length;

    for (const d of bp.diagnostics) console.log(formatDiagnosticLine(d));
    console.log(
      formatDiagnosticSummary(summarizeDiagnostics(bp.diagnostics, 'breakpoint')),
    );
    console.log(
      `[gear] breakpoint phase: ${bp.combos.length} combos tested, ` +
      `${bp.winner ? 'WINNER FOUND' : 'no improvement'}`,
    );

    if (bp.winner) {
      finalLoadout = applyComboToLoadout(greedy.converged, bp.winner);
      const winnerEntry = bp.combos.find((c) => c.combo.id === bp.winner!.id);
      finalDps = winnerEntry?.mean_dps ?? finalDps;
    }
    allDiagnostics.push(...bp.diagnostics);
  } else {
    console.log(
      `[gear] breakpoint phase: skipped (${greedy.rejected.length} rejected — need 2+)`,
    );
  }

  // 3. Build GearScanResult shape.
  const winner = buildWinnerCombo(finalLoadout, finalDps);
  const synthCombos: GearComboResult[] = [winner];
  // Append synthetic combos from greedy iter 1 (rejected items) so the
  // catalog can build seen_items / ignore-list observations.
  greedy.diagnostics
    .filter((d) => d.outcome === 'rejected' && d.label.startsWith('greedy iter 1:'))
    .forEach((d, idx) => {
      const synth = syntheticComboFromGreedyDiagnostic(
        d, greedy.convergedDps, initialLoadout, bagPool, idx,
      );
      if (synth) {
        const dp = winner.mean_dps > 0
          ? ((synth.mean_dps - winner.mean_dps) / winner.mean_dps) * 100
          : 0;
        synthCombos.push({ ...synth, delta_pct: dp });
      }
    });

  const result: GearScanResult = {
    label: `Gear ladder — greedy + breakpoint (${greedy.iterations} greedy iter, ${breakpointCombos} breakpoint combos)`,
    combos: synthCombos,
    winner,
    iterations: opts.breakpointIterations,
    total_combos: synthCombos.length,
  };

  return {
    result,
    greedyIterations: greedy.iterations,
    breakpointCombos,
    diagnostics: allDiagnostics,
    finalLoadout,
    finalDps,
  };
}

// Re-export DiagnosticEntry for callers.
export type { DiagnosticEntry };
