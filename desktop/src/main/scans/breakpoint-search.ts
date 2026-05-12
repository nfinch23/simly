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
import { canPairAsOH, classifyWeapon, locksOffHand } from './weapon-config';
import { pickCloseOHsForMH } from './oh-pairing';

const BASELINE_NAME = 'bp_baseline';
const MAX_REJECTED_FOR_TRIPLES = 15;
const MAX_REJECTED_FOR_PAIRS = 30;

export interface BreakpointCombo {
  /** Stable id used as the profileset name; deterministic from member identities. */
  id: string;
  /**
   * The items that swap into the converged loadout for this combo.
   * Map from physical slot (the combo's swap target) to item.
   *
   * Weapon-aware combos:
   *   - 1H main_hand + paired OH: `swaps` includes BOTH `main_hand` and
   *     `off_hand` entries. The OH is resolved from the converged
   *     loadout (or the bag pool — extension point).
   *   - 2H main_hand: `swaps` includes `main_hand` only, and
   *     `clearOffHand` is set true. The converged off_hand's stats are
   *     lost; `applyComboToLoadout` and the predictor both account for
   *     this.
   *   - Pure off_hand: `swaps` includes `off_hand` only; the converged
   *     main_hand stays put. Only emitted when the converged MH is 1H.
   */
  swaps: Record<string, ParsedItem>;
  /**
   * Set to `true` when the combo swaps in a 2H main_hand and the
   * converged off_hand needs to be cleared (WoW's 2H slot lockout).
   * Defaults to undefined (= false) for non-weapon combos.
   *
   * `buildBreakpointScript` honors this by emitting `off_hand=` with an
   * empty value — same pattern swap-test already uses for 2H weapon
   * swaps. `applyComboToLoadout` deletes the off_hand slot from the
   * returned loadout. `predictComboScore` adds the converged off_hand's
   * stats to the incumbent side so the predicted delta reflects the
   * stats LOST by clearing the slot.
   */
  clearOffHand?: boolean;
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
  /**
   * Bag pool used for OH sub-sim of 1H weapon combos. When supplied
   * AND `weights` are present, each 1H-weapon-inclusive combo is
   * expanded into one variant per close OH partner from this pool +
   * the converged off_hand. Mirrors greedy's OH sub-sim behaviour
   * from PR #35. Empty/undefined disables expansion (single combo
   * with the converged OH, same as PR #38's behaviour).
   */
  bagItems?: readonly ParsedItem[];
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
 *
 * Weapon-aware emission (requires `converged` to resolve OH context):
 *   - 1H main_hand → combo includes BOTH `main_hand` AND `off_hand`
 *     (OH copied from `converged.off_hand` when OH-eligible).
 *   - 2H main_hand → combo includes `main_hand`; `clearOffHand` flag
 *     set so the script builder emits `off_hand=` empty (lockout).
 *   - Pure off_hand → combo includes `off_hand`; `converged.main_hand`
 *     must be 1H (can't pair an OH with a 2H MH).
 *   - Combos containing two or more weapon items are dropped — greedy
 *     already explores 1H+1H pairs via OH sub-sim; breakpoint focuses
 *     on non-weapon × weapon synergies.
 *   - `converged` defaults to `{}`; weapon combos that need missing
 *     context (no MH/OH in converged) are silently skipped.
 */
export function generateCombos(
  rejected: readonly ParsedItem[],
  converged: Record<string, ParsedItem> = {},
): BreakpointCombo[] {
  const items = rejected.slice(0, MAX_REJECTED_FOR_PAIRS);
  const combos: BreakpointCombo[] = [];

  // Pairs.
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]!;
      const b = items[j]!;
      const built = buildComboFromItems([a, b], converged);
      if (!built) continue;
      combos.push({
        id: `bp2_${comboHash([a, b])}`,
        swaps: built.swaps,
        ...(built.clearOffHand ? { clearOffHand: true } : {}),
      });
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
          const built = buildComboFromItems([a, b, c], converged);
          if (!built) continue;
          combos.push({
            id: `bp3_${comboHash([a, b, c])}`,
            swaps: built.swaps,
            ...(built.clearOffHand ? { clearOffHand: true } : {}),
          });
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
  // clearOffHand combos lose the converged off_hand's ilvl entirely.
  // Append it as a slot with candidate_ilvl=0 so predictComboDps's
  // ilvl-proxy accounts for the LOST off_hand ilvl.
  if (args.combo.clearOffHand && args.converged['off_hand']) {
    swapsForPredict.push({
      candidate_ilvl: 0,
      incumbent_ilvl: args.converged['off_hand']!.ilvl,
    });
  }
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
    // Allow incumbent absent (e.g. converged had no main_hand) — that's
    // a pure addition with zero incumbent stats. Candidate must have
    // stats to predict via stat-vector; otherwise fall back to ilvl.
    if (!candItem.raw_stats) return ilvlScore;
    candRaw.push(candItem.raw_stats);
    if (incItem?.raw_stats) incRaw.push(incItem.raw_stats);
    else if (incItem) return ilvlScore; // incumbent exists but no raw_stats → can't compare cleanly
  }
  // clearOffHand: the converged off_hand's stats are LOST. Add to
  // incumbents so the aggregated-delta math subtracts them.
  if (args.combo.clearOffHand) {
    const oh = args.converged['off_hand'];
    if (oh?.raw_stats) incRaw.push(oh.raw_stats);
    else if (oh) return ilvlScore; // off_hand exists but no raw_stats — can't predict cleanly
  }
  const { predicted_delta_dps } = predictDpsFromAggregatedStatDelta({
    incumbents: incRaw,
    candidates: candRaw,
    weights: args.weights,
  });
  return predicted_delta_dps;
}

/**
 * Expand each 1H-weapon-inclusive combo into one variant per close OH
 * partner. Mirrors greedy's OH sub-sim ([PR #35]) — when the
 * stat-vector predicts multiple OHs are within `OH_SUBSIM_TIE_PCT` of
 * the best, emit all of them so the sim resolves the close call.
 *
 * Combos without a main_hand swap, or whose main_hand is 2H
 * (`clearOffHand`), or that come with `weights === undefined` /
 * empty `bagItems`, pass through unchanged. The expanded variants
 * share the same core combo id but get a `_oh<hash>` suffix so they're
 * distinct profileset names; the original combo (with the converged
 * off_hand) is kept as one of the variants when the converged OH is
 * among the close partners.
 *
 * Pure helper — no I/O.
 */
export function expandWeaponCombosWithCloseOHs(args: {
  combos: readonly BreakpointCombo[];
  converged: Record<string, ParsedItem>;
  bagItems?: readonly ParsedItem[];
  weights?: StatWeightsLike;
}): BreakpointCombo[] {
  // Without weights we can't rank OH partners — return combos as-is.
  if (!args.weights) return [...args.combos];

  // OH partner pool = OH-eligible bag items + the converged off_hand.
  const ohPoolSet = new Map<string, ParsedItem>();
  for (const item of args.bagItems ?? []) {
    if (canPairAsOH(item)) ohPoolSet.set(item.identity, item);
  }
  const convOH = args.converged['off_hand'];
  if (convOH && canPairAsOH(convOH)) ohPoolSet.set(convOH.identity, convOH);
  const ohPool = [...ohPoolSet.values()];

  if (ohPool.length === 0) return [...args.combos];

  const out: BreakpointCombo[] = [];
  for (const combo of args.combos) {
    const mh = combo.swaps['main_hand'];
    if (!mh || combo.clearOffHand || locksOffHand(mh) || classifyWeapon(mh) === 'NON_WEAPON') {
      out.push(combo);
      continue;
    }
    const pick = pickCloseOHsForMH({
      mh,
      ohCandidates: ohPool,
      // StatWeightsLike and the shared StatWeights are structurally
      // identical (catch-all index sig). Cast is to satisfy the strict
      // shared-package import that pickCloseOHsForMH uses.
      weights: args.weights as Parameters<typeof pickCloseOHsForMH>[0]['weights'],
    });
    if (pick.partners.length <= 1) {
      // Single partner (or none) → no sub-sim. Keep the original combo
      // even if pick.partners[0] differs from combo.swaps.off_hand —
      // generateCombos already chose converged.off_hand and we trust
      // that choice when the prediction is decisive.
      out.push(combo);
      continue;
    }
    for (const oh of pick.partners) {
      // Replace the off_hand in swaps with this partner. Append an
      // OH-discriminating suffix to the id so the profileset names
      // stay unique.
      const newSwaps: Record<string, ParsedItem> = { ...combo.swaps, off_hand: oh };
      const newId = `${combo.id}_oh${shortIdHash(oh.identity)}`;
      out.push({ id: newId, swaps: newSwaps });
    }
  }
  return out;
}

function shortIdHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
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

interface BuiltCombo {
  swaps: Record<string, ParsedItem>;
  clearOffHand: boolean;
}

/**
 * Allocate a combo's items to physical slots, resolving weapon context
 * from the converged loadout. Returns null when the combo isn't
 * physically realizable (duplicate non-paired slots, multiple weapons,
 * missing OH partner for a 1H MH in converged, etc.).
 *
 * Replaces the older `pairSwaps` + `tripleSwaps` helpers — the new
 * shape handles 2 and 3 items uniformly and adds the weapon-aware
 * branch that resolves MH+OH / 2H clear / pure-OH combos.
 */
function buildComboFromItems(
  items: readonly ParsedItem[],
  converged: Record<string, ParsedItem>,
): BuiltCombo | null {
  // v1 supports at most one weapon item per combo. Multi-weapon combos
  // are dropped: greedy already explored 1H+1H tuples via OH sub-sim,
  // and tracking two weapons' slot semantics in one breakpoint combo
  // adds complexity for low expected value.
  const weapons = items.filter((i) => classifyWeapon(i) !== 'NON_WEAPON');
  if (weapons.length > 1) return null;
  const nonWeapons = items.filter((i) => classifyWeapon(i) === 'NON_WEAPON');

  const swaps: Record<string, ParsedItem> = {};
  let ringSlotsUsed = 0;
  let trinketSlotsUsed = 0;

  for (const it of nonWeapons) {
    if (isRing(it.slot)) {
      if (ringSlotsUsed >= 2) return null;
      const target = ringSlotsUsed === 0 ? 'finger1' : 'finger2';
      if (swaps[target]) return null;
      swaps[target] = it;
      ringSlotsUsed += 1;
    } else if (isTrinket(it.slot)) {
      if (trinketSlotsUsed >= 2) return null;
      const target = trinketSlotsUsed === 0 ? 'trinket1' : 'trinket2';
      if (swaps[target]) return null;
      swaps[target] = it;
      trinketSlotsUsed += 1;
    } else {
      if (swaps[it.slot]) return null; // duplicate non-paired slot
      swaps[it.slot] = it;
    }
  }

  if (weapons.length === 0) {
    return { swaps, clearOffHand: false };
  }

  // Resolve the weapon's slot semantics from the converged loadout.
  const w = weapons[0]!;
  const cls = classifyWeapon(w);

  if (cls === 'OH') {
    // Pure off_hand — pair with the converged main_hand iff that MH is
    // 1H (a 2H MH locks out the off_hand slot entirely).
    const mh = converged['main_hand'];
    if (!mh || locksOffHand(mh)) return null;
    if (swaps['off_hand']) return null; // non-weapon shouldn't collide, defensive
    swaps['off_hand'] = w;
    return { swaps, clearOffHand: false };
  }

  // MH (1H_MH / 1H_DUAL / 2H).
  if (swaps['main_hand']) return null;
  if (locksOffHand(w)) {
    // 2H — clear off_hand. clearOffHand flag tells the script builder
    // to emit `off_hand=` empty for this profileset.
    swaps['main_hand'] = w;
    return { swaps, clearOffHand: true };
  }
  // 1H MH — pair with converged off_hand iff OH-eligible.
  const oh = converged['off_hand'];
  if (!oh || !canPairAsOH(oh)) return null;
  if (swaps['off_hand']) return null;
  swaps['main_hand'] = w;
  swaps['off_hand'] = oh;
  return { swaps, clearOffHand: false };
}

function isRing(slot: string): boolean {
  return slot === 'finger1' || slot === 'finger2';
}
function isTrinket(slot: string): boolean {
  return slot === 'trinket1' || slot === 'trinket2';
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
    const emitted = new Set<string>();
    for (const [slot, item] of Object.entries(converged)) {
      // For 2H weapon combos: skip the off_hand slot here and emit the
      // explicit `off_hand=` empty line below. Otherwise pass through
      // (or override from combo.swaps when present).
      if (slot === 'off_hand' && combo.clearOffHand) continue;
      const override = combo.swaps[slot];
      const lineItem = override ?? item;
      lines.push(`profileset."${combo.id}"+="${formatItemLine(lineItem, slot as SlotName)}"`);
      emitted.add(slot);
    }
    // Combos may include slots the converged loadout doesn't have —
    // e.g. an off_hand swap when converged was wielding a 2H, or a
    // main_hand swap when the converged loadout had nothing equipped.
    // Emit those slots explicitly so the profileset reflects the full
    // combo, not just the slots the baseline already had.
    for (const [slot, item] of Object.entries(combo.swaps)) {
      if (emitted.has(slot)) continue;
      if (slot === 'off_hand' && combo.clearOffHand) continue; // handled below
      lines.push(`profileset."${combo.id}"+="${formatItemLine(item, slot as SlotName)}"`);
    }
    // 2H lockout: emit `off_hand=` with an empty value so SimC clears
    // the slot. Same shape swap-test uses for its 2H weapon swaps.
    if (combo.clearOffHand) {
      lines.push(`profileset."${combo.id}"+="off_hand="`);
    }
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
  // Pass converged so generateCombos can resolve weapon slot semantics
  // (1H + OH pairing, 2H clearOffHand, pure-OH MH pairing).
  const rawCombos = generateCombos(opts.rejected, opts.converged);

  // Expand 1H-weapon combos into one variant per close OH partner from
  // the bag pool. Mirrors greedy's OH sub-sim — lets the breakpoint sim
  // resolve close (mh, oh) calls instead of trusting the dot-product
  // winner. No-op when `bagItems` or `weights` are missing.
  const allCombos = expandWeaponCombosWithCloseOHs({
    combos: rawCombos,
    converged: opts.converged,
    bagItems: opts.bagItems,
    weights: opts.weights,
  });

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
    if (entry.combo.clearOffHand && args.converged['off_hand']) {
      swapsForPredict.push({
        candidate_ilvl: 0,
        incumbent_ilvl: args.converged['off_hand']!.ilvl,
      });
    }
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
    //
    // Weapon-aware: combos may add a slot the converged didn't have
    // (e.g. a pure off_hand combo when converged had no off_hand). An
    // absent incumbent is treated as zero stats for that slot — a clean
    // "addition" delta — rather than forcing ilvl fallback.
    const incRaw: NonNullable<ParsedItem['raw_stats']>[] = [];
    const candRaw: NonNullable<ParsedItem['raw_stats']>[] = [];
    let allHaveStats = !!args.weights;
    for (const [slot, candItem] of Object.entries(entry.combo.swaps)) {
      const incItem = args.converged[slot];
      if (!candItem.raw_stats) {
        allHaveStats = false;
        break;
      }
      candRaw.push(candItem.raw_stats);
      if (incItem?.raw_stats) {
        incRaw.push(incItem.raw_stats);
      } else if (incItem) {
        // Incumbent exists but no raw_stats — can't compare cleanly.
        allHaveStats = false;
        break;
      }
      // incItem === undefined → no incumbent for that slot, treat as zero.
    }
    // clearOffHand: converged off_hand's stats are lost.
    if (allHaveStats && entry.combo.clearOffHand) {
      const oh = args.converged['off_hand'];
      if (oh?.raw_stats) {
        incRaw.push(oh.raw_stats);
      } else if (oh) {
        allHaveStats = false;
      }
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
 * a new loadout with the combo's swaps applied. Honors `clearOffHand`
 * for 2H weapon swaps by deleting the off_hand slot from the result —
 * mirrors how greedy folds a 2H winner into its converged loadout.
 */
export function applyComboToLoadout(
  converged: Record<string, ParsedItem>,
  combo: BreakpointCombo,
): Record<string, ParsedItem> {
  const next = { ...converged };
  for (const [slot, item] of Object.entries(combo.swaps)) {
    next[slot] = item;
  }
  if (combo.clearOffHand) {
    delete next['off_hand'];
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
