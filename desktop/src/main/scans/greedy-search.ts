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
import type { SwapTestResult, SwapResult, WeaponSwap } from '../swap-test';
import type { BestLoadoutSlot, GearCatalogEntry } from '../gear-catalog';
import type { StatWeights } from '@simly/shared';
import {
  buildDiagnosticEntry,
  buildStatVectorDiagnosticEntry,
  predictDpsFromAggregatedStatDelta,
  predictDpsFromStatDelta,
  predictItemSwapDps,
  type DiagnosticEntry,
} from './pruner-diagnostic';
import { HARD_FLOOR_PCT } from './gear-pruner';
import { canPairAsMH, canPairAsOH, classifyWeapon, locksOffHand } from './weapon-config';
import { pickBestOHForMH, pickCloseOHsForMH } from './oh-pairing';

/**
 * Composite key joining MH identity with its paired OH identity.
 * `null` OH (2H weapon) is encoded as the literal `'_2h'` token so the
 * key space cleanly partitions 2H winners from 1H+OH winners with the
 * same MH item id.
 */
function weaponSwapKey(mhIdentity: string, ohIdentity: string | null): string {
  return `${mhIdentity}|${ohIdentity ?? '_2h'}`;
}

/**
 * Runtime callback the greedy loop uses to evaluate a batch of
 * candidate items against a baseline. Mirrors `runSwapTest` from
 * swap-test.ts but typed as just the function so tests can mock it.
 */
export type SwapTestRunner = (args: {
  bestLoadout: Record<string, BestLoadoutSlot>;
  baselineItemBySlot: Record<string, ParsedItem>;
  newItems: readonly ParsedItem[];
  /**
   * Weapon-aware (MH, OH) tuples. Tested as one profileset each — the
   * builder emits `off_hand=` empty for 2H tuples (oh=null) and
   * `off_hand=<oh>` for 1H+OH tuples. Greedy partitions weapon
   * candidates into this list before calling the runner so the
   * profileset correctly models the WoW slot lockout.
   */
  weaponSwaps?: readonly WeaponSwap[];
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
  /** Stat-weight pre-filter floor. Items predicted to lose by more than this %  vs their slot incumbent are dropped before any sim runs. Default HARD_FLOOR_PCT (3%). */
  hardFloorPct?: number;
  /** Injected SimC roundtrip. */
  runSwapTest: SwapTestRunner;
  /**
   * Stat weights for stat-vector prediction. When provided AND the
   * candidate + incumbent both have raw_stats (from the addon's
   * simly_stats= annotation), the diagnostic AND the pre-filter use
   * precise stat-vector × stat-weights as the predicted delta. Falls
   * back to ilvl-proxy when missing.
   */
  statWeights?: StatWeights;
  /**
   * Baseline DPS used to convert predicted_delta_dps → predicted_pct
   * for the pre-filter's stat-vector path. Typically the catalog's
   * best_loadout_dps for this character + scenario. When 0 or missing,
   * pre-filter falls back to ilvl-proxy.
   */
  baselineDps?: number;
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

    // Stat-weight hard-floor pre-filter: drop candidates whose predicted
    // delta vs their slot incumbent is so negative they can't be an
    // upgrade. Saves a SimC profileset per dropped item. Uses precise
    // stat-vector prediction when raw_stats are available; falls back
    // to ilvl-proxy otherwise.
    //
    // After iter 1, prefer the just-measured convergedDps as the
    // baseline (most accurate); for iter 1, use the catalog/options
    // baselineDps.
    const preFilterBaselineDps = convergedDps > 0 ? convergedDps : (opts.baselineDps ?? 0);
    const filtered = preFilterCandidates({
      candidates,
      loadout: converged,
      dpsPerIlvlPct: opts.dpsPerIlvlPct,
      hardFloorPct: opts.hardFloorPct ?? HARD_FLOOR_PCT,
      statWeights: opts.statWeights,
      baselineDps: preFilterBaselineDps,
    });
    for (const d of filtered.dropped) {
      diagnostics.push({
        label: `greedy iter ${iterations}: ${d.item.slot}=${d.item.name} (pre-filter, source: ${d.source})`,
        predicted_delta_dps: 0,
        actual_delta_dps: 0,
        predicted_pct: d.predictedPct,
        actual_pct: 0,
        error_pp: 0,
        outcome: 'rejected',
      });
    }
    if (filtered.kept.length === 0) {
      // All remaining candidates pre-filtered — converged.
      break;
    }

    // Partition kept candidates: non-weapon items go through the
    // existing single-slot swap path; weapon items (MH or pure OH) go
    // through the new (mh, oh) tuple path so the profileset correctly
    // models the 2H/1H slot lockout.
    const { nonWeaponItems, weaponSwaps, weaponSwapByKey } =
      partitionWeaponCandidates({
        candidates: filtered.kept,
        bagItems: opts.bagItems,
        converged,
        statWeights: opts.statWeights,
      });

    const result = await opts.runSwapTest({
      bestLoadout: loadoutToBestLoadout(converged),
      baselineItemBySlot: converged,
      newItems: nonWeaponItems,
      weaponSwaps,
    });

    convergedDps = result.baseline_dps;

    // Build diagnostic entries for every candidate this iteration.
    const best = selectBestUpgrade(result.results, tieWindowPct);
    for (const r of result.results) {
      const isAccepted = best !== null && r.item.identity === best.item.identity;
      const outcome: DiagnosticEntry['outcome'] = isAccepted ? 'accepted' : 'rejected';

      // Weapon-aware path: if this result came from a WeaponSwap tuple
      // (MH ± OH together), use aggregated stat-delta math so the
      // prediction accounts for both slots changing at once. The OH
      // identity on the result discriminates between OH sub-sim
      // siblings that share the same MH.
      const weaponSwap = weaponSwapByKey.get(
        weaponSwapKey(r.item.identity, r.weapon_oh_identity ?? null),
      );
      if (weaponSwap) {
        const ohName = weaponSwap.oh ? ` + off_hand=${weaponSwap.oh.name}` : ' (off_hand cleared)';
        const label = `greedy iter ${iterations}: main_hand=${weaponSwap.mh.name}${ohName}`;
        // Sum the ilvl deltas across both slots for the legacy ilvl-proxy line.
        const incIlvlSum =
          (converged['main_hand']?.ilvl ?? 0) + (converged['off_hand']?.ilvl ?? 0);
        const candIlvlSum = weaponSwap.mh.ilvl + (weaponSwap.oh?.ilvl ?? 0);
        const predicted_delta_dps_ilvl =
          (candIlvlSum - incIlvlSum) * opts.dpsPerIlvlPct * (result.baseline_dps / 100);

        // Stat-vector aggregated math.
        const incRaw: NonNullable<ParsedItem['raw_stats']>[] = [];
        if (converged['main_hand']?.raw_stats) incRaw.push(converged['main_hand'].raw_stats);
        if (converged['off_hand']?.raw_stats) incRaw.push(converged['off_hand'].raw_stats);
        const candRaw: NonNullable<ParsedItem['raw_stats']>[] = [];
        if (weaponSwap.mh.raw_stats) candRaw.push(weaponSwap.mh.raw_stats);
        if (weaponSwap.oh?.raw_stats) candRaw.push(weaponSwap.oh.raw_stats);

        if (opts.statWeights && (incRaw.length > 0 || candRaw.length > 0)) {
          const predicted = predictDpsFromAggregatedStatDelta({
            incumbents: incRaw,
            candidates: candRaw,
            weights: opts.statWeights,
          });
          diagnostics.push(
            buildStatVectorDiagnosticEntry({
              label,
              baseline_dps: result.baseline_dps,
              candidate_dps: r.mean_dps,
              predicted_delta_dps_ilvl,
              predicted_delta_dps_stat_vector: predicted.predicted_delta_dps,
              outcome,
            }),
          );
        } else {
          diagnostics.push(
            buildDiagnosticEntry({
              label,
              baseline_dps: result.baseline_dps,
              candidate_dps: r.mean_dps,
              predicted_delta_dps: predicted_delta_dps_ilvl,
              outcome,
            }),
          );
        }
        continue;
      }

      // Non-weapon path (existing behavior).
      const incumbent = pickIncumbentForSlot(converged, r.slot);
      const predicted_delta_dps_ilvl = predictItemSwapDps({
        candidate_ilvl: r.item.ilvl,
        incumbent_ilvl: incumbent?.ilvl ?? r.item.ilvl,
        baseline_dps: result.baseline_dps,
        dps_per_ilvl_pct: opts.dpsPerIlvlPct,
      });
      const label = `greedy iter ${iterations}: ${r.slot}=${r.item.name}`;
      const candidateItem = opts.bagItems.find((i) => i.identity === r.item.identity);

      if (opts.statWeights && candidateItem?.raw_stats && incumbent?.raw_stats) {
        const predicted = predictDpsFromStatDelta({
          incumbent: incumbent.raw_stats,
          candidate: candidateItem.raw_stats,
          weights: opts.statWeights,
        });
        diagnostics.push(
          buildStatVectorDiagnosticEntry({
            label,
            baseline_dps: result.baseline_dps,
            candidate_dps: r.mean_dps,
            predicted_delta_dps_ilvl,
            predicted_delta_dps_stat_vector: predicted.predicted_delta_dps,
            outcome,
          }),
        );
      } else {
        diagnostics.push(
          buildDiagnosticEntry({
            label,
            baseline_dps: result.baseline_dps,
            candidate_dps: r.mean_dps,
            predicted_delta_dps: predicted_delta_dps_ilvl,
            outcome,
          }),
        );
      }
    }

    if (!best) break; // converged — no upgrade found

    // Fold the winner into the converged loadout. Weapon winners need
    // special handling: the WeaponSwap that produced this winner also
    // determines the off_hand state. Use the composite (mh, oh) key
    // so OH-sub-sim winners resolve to the exact pair that won.
    const weaponSwap = weaponSwapByKey.get(
      weaponSwapKey(best.item.identity, best.weapon_oh_identity ?? null),
    );
    if (weaponSwap) {
      // Weapon winner. Apply MH + (OH or clear).
      converged['main_hand'] = weaponSwap.mh;
      if (weaponSwap.oh) {
        converged['off_hand'] = weaponSwap.oh;
      } else {
        // 2H winner — clear off-hand. Use `delete` so subsequent iters
        // see the slot as empty (rather than a stale ParsedItem).
        delete converged['off_hand'];
      }
    } else {
      // Non-weapon winner. Existing behavior — honor ring/trinket
      // best-position selection.
      const targetSlot = bestPositionSlot(best);
      converged[targetSlot] = candidateAsParsedItem(best, opts.bagItems);
    }
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
 * Stat-weight hard-floor pre-filter. For each candidate, compute its
 * predicted delta_pct vs the slot incumbent. Drop any candidate predicted
 * to lose by more than `hardFloorPct` (default 3%) — they cannot recover
 * via DR or noise to become an upgrade, so simming them is wasted work.
 *
 * Two prediction modes, picked per-candidate based on data availability:
 *   - **stat-vector** (precise): when `statWeights` + `baselineDps` are
 *     supplied AND both candidate and incumbent have `raw_stats` (from
 *     the addon's `simly_stats=` annotation), predict via
 *     Σ (candidate_stat − incumbent_stat) × weight[stat]. Same data SimC
 *     uses, so the prediction is structurally exact for primary +
 *     secondary stats. Misses weapon damage / procs / set bonuses (those
 *     surface as `unexplained_pp` in the diagnostic, not the pre-filter).
 *   - **ilvl-proxy** (legacy): when stat-vector data is missing, fall
 *     back to (item.ilvl − incumbent.ilvl) × dpsPerIlvlPct. Less precise
 *     but always available. Lets us keep behavior unchanged on the very
 *     first run after install (before the addon `/reload` lands the
 *     simly_stats= annotation).
 *
 * Special cases:
 *   - Empty slot in the loadout → keep candidate unconditionally.
 *   - Rings: predict against BOTH finger positions, take the BEST
 *     (most-positive) prediction as the bar — that's the position the
 *     swap-test would assign the candidate to. Conservative: only drop
 *     if BOTH positions predict a hard-floor loss.
 *   - dpsPerIlvlPct ≤ 0 AND no stat weights: disable filter, keep
 *     everything (very-first-run guard).
 */
export function preFilterCandidates(args: {
  candidates: readonly ParsedItem[];
  loadout: Record<string, ParsedItem>;
  dpsPerIlvlPct: number;
  hardFloorPct?: number;
  /** Per-stat DPS-per-+1 weights. When present + raw_stats also present, use stat-vector prediction. */
  statWeights?: StatWeights;
  /** Baseline DPS for converting predicted_delta_dps → predicted_pct. Required for stat-vector mode. */
  baselineDps?: number;
}): {
  kept: ParsedItem[];
  dropped: Array<{
    item: ParsedItem;
    predictedPct: number;
    source: 'stat-vector' | 'ilvl';
  }>;
} {
  const floor = -(args.hardFloorPct ?? 3.0);
  const canUseStatVector =
    args.statWeights !== undefined &&
    args.baselineDps !== undefined &&
    args.baselineDps > 0;

  // Disable filter entirely on the very-first-run case (no stat weights
  // AND no per-stat data). With stat-vector available we keep the filter
  // active even when dpsPerIlvlPct is 0.
  if (args.dpsPerIlvlPct <= 0 && !canUseStatVector) {
    return { kept: [...args.candidates], dropped: [] };
  }

  const kept: ParsedItem[] = [];
  const dropped: Array<{ item: ParsedItem; predictedPct: number; source: 'stat-vector' | 'ilvl' }> = [];

  for (const item of args.candidates) {
    const incumbents = getIncumbentsForCandidate(item, args.loadout);
    if (incumbents.length === 0) {
      // Empty slot — free upgrade.
      kept.push(item);
      continue;
    }

    // For rings, the swap-test will pick whichever position produces the
    // better gain. Predict against each, keep the BEST (most positive)
    // value as the bar — the candidate gets the benefit of the doubt.
    let bestPredictedPct = -Infinity;
    let source: 'stat-vector' | 'ilvl' = 'ilvl';
    for (const incumbent of incumbents) {
      const { predictedPct, source: src } = predictPctForSwap({
        candidate: item,
        incumbent,
        statWeights: args.statWeights,
        baselineDps: args.baselineDps ?? 0,
        dpsPerIlvlPct: args.dpsPerIlvlPct,
      });
      if (predictedPct > bestPredictedPct) {
        bestPredictedPct = predictedPct;
        source = src;
      }
    }

    if (bestPredictedPct < floor) {
      dropped.push({ item, predictedPct: bestPredictedPct, source });
    } else {
      kept.push(item);
    }
  }
  return { kept, dropped };
}

/**
 * Per-incumbent prediction for one candidate swap. Picks stat-vector
 * when raw_stats + weights are available, else falls back to ilvl-proxy.
 * Returns both the predicted_pct and which source produced it.
 */
function predictPctForSwap(args: {
  candidate: ParsedItem;
  incumbent: ParsedItem;
  statWeights?: StatWeights;
  baselineDps: number;
  dpsPerIlvlPct: number;
}): { predictedPct: number; source: 'stat-vector' | 'ilvl' } {
  if (
    args.statWeights &&
    args.baselineDps > 0 &&
    args.candidate.raw_stats &&
    args.incumbent.raw_stats
  ) {
    const { predicted_delta_dps } = predictDpsFromStatDelta({
      incumbent: args.incumbent.raw_stats,
      candidate: args.candidate.raw_stats,
      weights: args.statWeights,
    });
    return {
      predictedPct: (predicted_delta_dps / args.baselineDps) * 100,
      source: 'stat-vector',
    };
  }
  // ilvl-proxy fallback.
  return {
    predictedPct: (args.candidate.ilvl - args.incumbent.ilvl) * args.dpsPerIlvlPct,
    source: 'ilvl',
  };
}

/**
 * Return the list of incumbent items relevant for pre-filtering this
 * candidate. For paired slots (rings, trinkets), both positions are
 * returned so the caller can predict against each. For non-paired slots,
 * a single-element list. Empty list when the slot is empty.
 */
function getIncumbentsForCandidate(
  candidate: ParsedItem,
  loadout: Record<string, ParsedItem>,
): ParsedItem[] {
  if (candidate.slot === 'finger1' || candidate.slot === 'finger2') {
    const out: ParsedItem[] = [];
    if (loadout['finger1']) out.push(loadout['finger1']);
    if (loadout['finger2']) out.push(loadout['finger2']);
    return out;
  }
  if (candidate.slot === 'trinket1' || candidate.slot === 'trinket2') {
    const out: ParsedItem[] = [];
    if (loadout['trinket1']) out.push(loadout['trinket1']);
    if (loadout['trinket2']) out.push(loadout['trinket2']);
    return out;
  }
  const incumbent = loadout[candidate.slot];
  return incumbent ? [incumbent] : [];
}

/**
 * Partition a kept-candidate list into:
 *   - `nonWeaponItems`: non-weapon slots (chest, legs, ring, trinket, etc.).
 *     Tested via the existing single-slot swap path.
 *   - `weaponSwaps`: explicit (MH, OH) tuples — one per weapon candidate
 *     this iter. Each MH candidate gets its best OH via `pickBestOHForMH`;
 *     each pure-OH candidate gets paired with the converged main_hand
 *     (skipped if main_hand is 2H, since the slot is locked out).
 *   - `weaponSwapByMHIdentity`: lookup map so the post-iter accept logic
 *     can recover which OH was paired with the winning MH.
 *
 * `1H_DUAL` items appear in MH candidate processing only — when paired
 * with another MH as that MH's OH, they show up in the OH pool through
 * the same bag scan.
 */
function partitionWeaponCandidates(args: {
  candidates: readonly ParsedItem[];
  bagItems: readonly ParsedItem[];
  converged: Record<string, ParsedItem>;
  statWeights?: StatWeights;
}): {
  nonWeaponItems: ParsedItem[];
  weaponSwaps: WeaponSwap[];
  /**
   * Composite-keyed lookup: `weaponSwapKey(mh.identity, oh?.identity)`
   * → the WeaponSwap that produced that profileset. Composite keys are
   * required because OH sub-sim can emit two `(mh, oh_A) / (mh, oh_B)`
   * profilesets that share an MH identity; the OH identity is the
   * discriminator the caller uses (via SwapResult.weapon_oh_identity)
   * to map a winning result back to the exact (MH, OH) pair.
   */
  weaponSwapByKey: Map<string, WeaponSwap>;
} {
  const nonWeaponItems: ParsedItem[] = [];
  const weaponSwaps: WeaponSwap[] = [];
  const weaponSwapByKey = new Map<string, WeaponSwap>();

  // OH pool = bag's OH-eligible items + currently-equipped OH (a 1H_DUAL
  // or dedicated OH item that's in converged.off_hand).
  const ohPool: ParsedItem[] = args.bagItems.filter(canPairAsOH);
  const currentOH = args.converged['off_hand'];
  if (currentOH && canPairAsOH(currentOH)) {
    ohPool.push(currentOH);
  }

  const currentMH = args.converged['main_hand'];

  for (const candidate of args.candidates) {
    const cls = classifyWeapon(candidate);

    // Non-weapon slot → existing path.
    if (cls === 'NON_WEAPON') {
      nonWeaponItems.push(candidate);
      continue;
    }

    // Pure off-hand candidate → pair with current main_hand IF main_hand
    // isn't a 2H (the slot is locked out otherwise).
    if (cls === 'OH') {
      if (currentMH && !locksOffHand(currentMH)) {
        const ws: WeaponSwap = { mh: currentMH, oh: candidate };
        weaponSwaps.push(ws);
        weaponSwapByKey.set(weaponSwapKey(currentMH.identity, candidate.identity), ws);
      }
      // If current MH is 2H, OH candidates can't be tested without
      // changing weapon config — skip silently. They'd compete only via
      // a 1H MH winning first, then re-running greedy.
      continue;
    }

    // Main-hand candidate (2H, 1H_MH, 1H_DUAL): emit one (mh, oh) tuple
    // per close OH partner so the sim can resolve stat-vector close
    // calls instead of trusting the dot-product winner. For 2H, the
    // close-OH picker returns no partners and we emit a single
    // (mh, null) swap to clear the off-hand slot.
    if (canPairAsMH(candidate)) {
      if (locksOffHand(candidate)) {
        // 2H weapon — single swap, OH cleared.
        const ws: WeaponSwap = { mh: candidate, oh: null };
        weaponSwaps.push(ws);
        weaponSwapByKey.set(weaponSwapKey(candidate.identity, null), ws);
        continue;
      }

      // 1H MH: sub-sim top close OHs when stat weights are available;
      // fall back to "first OH in the pool" with no sub-sim when not.
      let partners: ParsedItem[];
      if (args.statWeights) {
        const pick = pickCloseOHsForMH({
          mh: candidate,
          ohCandidates: ohPool,
          weights: args.statWeights,
        });
        partners = pick.partners;
      } else {
        partners = ohPool.length > 0 ? [ohPool[0]!] : [];
      }

      if (partners.length === 0) {
        // No eligible OH — emit a (mh, null) swap so the MH still gets
        // tested. Matches prior behaviour when ohPool was empty.
        const ws: WeaponSwap = { mh: candidate, oh: null };
        weaponSwaps.push(ws);
        weaponSwapByKey.set(weaponSwapKey(candidate.identity, null), ws);
        continue;
      }

      for (const oh of partners) {
        const ws: WeaponSwap = { mh: candidate, oh };
        weaponSwaps.push(ws);
        weaponSwapByKey.set(weaponSwapKey(candidate.identity, oh.identity), ws);
      }
    }
  }

  return { nonWeaponItems, weaponSwaps, weaponSwapByKey };
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
