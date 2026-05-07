/**
 * Iterative greedy gear search.
 *
 * Replaces the gear_coarse → gear_refined → gear_final cartesian cascade
 * with hill-climbing: each iteration runs a swap-test against the current
 * best-known loadout over every remaining bag item, picks the single
 * highest-delta upgrade, folds it into the converged loadout, repeats.
 * Terminates when no candidate is an upgrade.
 *
 * Why this works (and where it doesn't):
 *   - Most gearing decisions are additive (no synergies): greedy
 *     converges to the global optimum in O(N × per-iter) sims rather
 *     than O(cartesian).
 *   - For multi-item breakpoint synergies (e.g. two haste pieces
 *     together cross the GCD floor) greedy CAN converge to a local
 *     optimum. The breakpoint phase (separate module) catches those
 *     after greedy converges.
 *
 * The greedy loop is pure orchestration — it takes a `runSwapTest`
 * callback so tests can mock the SimC roundtrip. Real callers pass
 * through `swap-test.ts`'s `runSwapTest`.
 */

import type { ParsedItem } from '../simc-export-parser';
import type { SwapTestResult, SwapResult } from '../swap-test';
import type { BestLoadoutSlot, GearCatalogEntry } from '../gear-catalog';
import {
  buildDiagnosticEntry,
  predictItemSwapDps,
  type DiagnosticEntry,
} from './pruner-diagnostic';

/**
 * Runtime callback the greedy loop uses to evaluate a batch of
 * candidate items against a baseline. Mirrors `runSwapTest` from
 * swap-test.ts but typed as just the function so tests can mock it.
 */
export type SwapTestRunner = (args: {
  bestLoadout: Record<string, BestLoadoutSlot>;
  baselineItemBySlot: Record<string, ParsedItem>;
  newItems: readonly ParsedItem[];
}) => Promise<SwapTestResult>;

export interface GreedyOptions {
  /** Equipped loadout at run start, keyed by SimC slot name. */
  initialLoadout: Record<string, ParsedItem>;
  /** All bag candidate items eligible for swapping. Trash-classified items should already be filtered out by the caller. */
  bagItems: readonly ParsedItem[];
  /** Stat weights from the stat_weights stage — used to predict DPS gains for the diagnostic. */
  dpsPerIlvlPct: number;
  /** Tie window — items within ± this % of baseline are sidegrades, not upgrades. Default 0.1. */
  tieWindowPct?: number;
  /** Hard cap on iterations to prevent runaway. Default 20 (more than enough — typical convergence is 3-6). */
  maxIterations?: number;
  /** Injected SimC roundtrip. */
  runSwapTest: SwapTestRunner;
}

export interface GreedyResult {
  /** Final converged per-slot loadout. */
  converged: Record<string, ParsedItem>;
  /** DPS measured for the converged loadout (last successful baseline DPS). */
  convergedDps: number;
  /** Bag items that did NOT end up in `converged`. */
  rejected: ParsedItem[];
  /** All diagnostic entries from every iteration, in order. */
  diagnostics: DiagnosticEntry[];
  /** Number of greedy iterations completed (each = one runSwapTest call). */
  iterations: number;
  /** True if the loop hit maxIterations without converging. */
  hitIterationCap: boolean;
}

const DEFAULT_TIE_WINDOW_PCT = 0.1;
const DEFAULT_MAX_ITERATIONS = 20;

/**
 * Run the greedy loop until no single-item swap improves DPS.
 *
 * Returns the converged loadout, rejected items, and a diagnostic log
 * with one entry per simmed candidate per iteration.
 */
export async function runGreedyGearSearch(
  opts: GreedyOptions,
): Promise<GreedyResult> {
  const tieWindowPct = opts.tieWindowPct ?? DEFAULT_TIE_WINDOW_PCT;
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;

  const converged: Record<string, ParsedItem> = { ...opts.initialLoadout };
  const diagnostics: DiagnosticEntry[] = [];
  let convergedDps = 0;
  let iterations = 0;
  let hitIterationCap = false;

  while (iterations < maxIterations) {
    iterations += 1;
    const candidates = candidatesNotInLoadout(opts.bagItems, converged);
    if (candidates.length === 0) break;

    const result = await opts.runSwapTest({
      bestLoadout: loadoutToBestLoadout(converged),
      baselineItemBySlot: converged,
      newItems: candidates,
    });

    convergedDps = result.baseline_dps;

    // Build diagnostic entries for every candidate this iteration.
    const best = selectBestUpgrade(result.results, tieWindowPct);
    for (const r of result.results) {
      const incumbent = pickIncumbentForSlot(converged, r.slot);
      const predicted_delta_dps = predictItemSwapDps({
        candidate_ilvl: r.item.ilvl,
        incumbent_ilvl: incumbent?.ilvl ?? r.item.ilvl,
        baseline_dps: result.baseline_dps,
        dps_per_ilvl_pct: opts.dpsPerIlvlPct,
      });
      const isAccepted = best !== null && r.item.identity === best.item.identity;
      diagnostics.push(
        buildDiagnosticEntry({
          label: `greedy iter ${iterations}: ${r.slot}=${r.item.name}`,
          baseline_dps: result.baseline_dps,
          candidate_dps: r.mean_dps,
          predicted_delta_dps,
          outcome: isAccepted ? 'accepted' : 'rejected',
        }),
      );
    }

    if (!best) break; // converged — no upgrade found
    // Fold best into converged. For rings/trinkets we honor the
    // position the swap-test picked as winning (best.position_deltas[0]
    // when sorted, but parseSwapTestResult already collapses to the best
    // position and we re-derive the slot here).
    const targetSlot = bestPositionSlot(best);
    converged[targetSlot] = candidateAsParsedItem(best, opts.bagItems);
  }

  if (iterations >= maxIterations) hitIterationCap = true;

  // Compute rejected: bag items not in converged.
  const convergedIdentities = new Set(
    Object.values(converged).map((i) => i.identity),
  );
  const rejected = opts.bagItems.filter(
    (i) => !convergedIdentities.has(i.identity),
  );

  return { converged, convergedDps, rejected, diagnostics, iterations, hitIterationCap };
}

/**
 * Drop bag items whose identity is already in the loadout (already
 * equipped or already accepted by greedy in a prior iter).
 */
export function candidatesNotInLoadout(
  bagItems: readonly ParsedItem[],
  loadout: Record<string, ParsedItem>,
): ParsedItem[] {
  const equippedIdentities = new Set(
    Object.values(loadout).map((i) => i.identity),
  );
  return bagItems.filter((i) => !equippedIdentities.has(i.identity));
}

/**
 * Among swap-test results, pick the one with the highest delta_pct that
 * exceeds the tie window. Returns null if no candidate is an upgrade.
 */
export function selectBestUpgrade(
  results: readonly SwapResult[],
  tieWindowPct: number,
): SwapResult | null {
  let best: SwapResult | null = null;
  for (const r of results) {
    if (r.delta_pct <= tieWindowPct) continue;
    if (best === null || r.delta_pct > best.delta_pct) best = r;
  }
  return best;
}

/**
 * Convert a per-slot ParsedItem map into the BestLoadoutSlot shape that
 * runSwapTest expects.
 */
export function loadoutToBestLoadout(
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

/**
 * Compute the converged loadout's slot for an accepted SwapResult.
 * For rings and trinkets, the swap-test picked the better of the two
 * positions; we honor that pick by reading the best-position from
 * position_deltas.
 */
function bestPositionSlot(swap: SwapResult): string {
  if (swap.position_deltas.length === 0) return swap.slot;
  let bestPos = swap.position_deltas[0]!;
  for (const p of swap.position_deltas) {
    if (p.delta_pct > bestPos.delta_pct) bestPos = p;
  }
  return bestPos.position_slot;
}

/**
 * Resolve a SwapResult back to its full ParsedItem. The swap-test's
 * SwapResult carries only the lightweight `item` view; the greedy loop
 * has the full bag pool and can find the original.
 */
function candidateAsParsedItem(
  swap: SwapResult,
  bagItems: readonly ParsedItem[],
): ParsedItem {
  const found = bagItems.find((i) => i.identity === swap.item.identity);
  if (found) return found;
  // Fallback: synthesize a minimal ParsedItem from the SwapResult.
  // Should not happen in practice — bagItems is the source.
  return {
    slot: swap.slot,
    item_id: swap.item.item_id,
    name: swap.item.name,
    identity: swap.item.identity,
    ilvl: swap.item.ilvl,
    bonus_ids: [],
    is_equipped: false,
    extras: {},
  } as unknown as ParsedItem;
}

function pickIncumbentForSlot(
  loadout: Record<string, ParsedItem>,
  slot: string,
): ParsedItem | undefined {
  // For rings, swap-test reports `slot` as the canonical 'finger1' or
  // 'finger2' the candidate was tested in; the loadout has both fingers
  // distinct. Same for trinkets. For non-paired slots, direct lookup.
  return loadout[slot];
}

/**
 * Helper: filter out catalog-classified `trash` items from the bag pool
 * before greedy runs, so we don't waste sim budget on items the catalog
 * already proved are dead weight.
 */
export function filterTrashFromBag(
  bagItems: readonly ParsedItem[],
  catalog: GearCatalogEntry | undefined,
): ParsedItem[] {
  if (!catalog) return [...bagItems];
  return bagItems.filter((i) => {
    const seen = catalog.seen_items[i.identity];
    return !seen || seen.status !== 'trash';
  });
}
