/**
 * Phase 4d-i — gear ladder pruning + cartesian product builder.
 *
 * Pure logic, no SimC. Given a parsed export + stat weights + an
 * (optional) ignore set, produces:
 *   - a per-slot list of surviving candidates (after stat-weight
 *     × multiplier pruning)
 *   - the unordered ring-pair list (rings share a single pool but ship
 *     to SimC as a finger1/finger2 pair)
 *   - a fixed trinket pair lifted from the 4c pre-scan winner
 *   - the cartesian product across all of the above, rendered as a
 *     SimC profileset script
 *
 * Scoring is pluggable. v1 default is `ilvlScorer` — ilvl is a coarse
 * but practical proxy for total stat budget when the export does not
 * carry decomposed item stats. The Σ(stat × weight) signature is
 * preserved so a future scorer (item-DB lookup, or a SimC pre-pass)
 * can drop in without touching the rest of the ladder.
 */

import {
  allUnorderedPairs,
  formatItemLine,
  type ParsedExport,
  type ParsedItem,
  type SlotName,
} from '../simc-export-parser';
import type { StatWeights } from '@simly/shared';

/**
 * Slots that participate in the gear cartesian. Trinkets are excluded
 * — they come from the 4c pre-scan winner and are pruned by simulated
 * DPS rather than stat weight (passive/on-use effects can dominate).
 * Rings are folded into a single virtual `rings` pool and emitted as
 * unordered pairs. Tabard / shirt are skipped — zero DPS impact.
 */
export const GEAR_LADDER_SLOTS: readonly SlotName[] = [
  'head',
  'neck',
  'shoulder',
  'back',
  'chest',
  'wrist',
  'hands',
  'waist',
  'legs',
  'feet',
  'main_hand',
  'off_hand',
  'ranged',
] as const;

/**
 * A scorer maps (item, weights) → number. Higher is better. The
 * pruner keeps items where `score × multiplier >= max_score` for the
 * slot — i.e., items within 1/multiplier of the slot leader.
 */
export type Scorer = (item: ParsedItem, weights: StatWeights) => number;

/**
 * v1 default scorer. Returns `item.ilvl`. Stat weights are accepted
 * for signature compatibility but ignored — per-item stat values are
 * not present in the SimC addon export, so a real Σ(stat × weight)
 * scorer would need an item DB lookup (4d follow-up, not 4d-i scope).
 *
 * Practical accuracy: ilvl is the strongest single predictor of an
 * item's total stat budget in retail WoW. The 1.5× multiplier
 * default lets through plenty of secondary-stat-mismatched items so
 * the actual sim run gets the real say.
 */
export const ilvlScorer: Scorer = (item, _weights) => item.ilvl;

/**
 * Optional pair of trinkets locked from the 4c pre-scan winner. The
 * pruner does not score or prune trinkets; this pair is emitted
 * verbatim into every profileset.
 */
export interface TrinketLock {
  trinket1: ParsedItem;
  trinket2: ParsedItem;
}

/**
 * Default pruner multiplier. Items whose `score × multiplier < slot_max_score`
 * are dropped. SCOPE recommended 1.5; we tightened to 1.2 after observing
 * a 1728-combo cartesian on Felfriend take 27min at 1000 iter — 1.2
 * keeps the iterative dev loop under ~10min while still letting through
 * stat-distribution mismatches the sim deserves to evaluate. Override
 * via opts.multiplier.
 */
export const DEFAULT_PRUNER_MULTIPLIER = 1.2;

export interface PruneOptions {
  parsed: ParsedExport;
  weights: StatWeights;
  /** Items whose `score × multiplier < slot_max_score` are dropped. Default 1.2. */
  multiplier?: number;
  /** Identity hashes to skip (read by 4d-iii once the ignore list is online). */
  ignoreSet?: ReadonlySet<string>;
  /** Override the default ilvl scorer. */
  scorer?: Scorer;
  /** Locked trinket pair from the 4c pre-scan. Required for `buildGearProfileset`. */
  trinketLock?: TrinketLock;
}

/**
 * One emitted gear combination. The `slots` map is keyed by the
 * physical SimC slot name (finger1, finger2, trinket1, trinket2 included
 * after expansion). Used by the scan's result mapper to look up which
 * items a given profileset name represents.
 */
export interface GearCombo {
  id: string;
  slots: Partial<Record<SlotName, ParsedItem>>;
}

export interface PruneResult {
  /** Surviving candidates per non-ring, non-trinket slot. */
  perSlot: Partial<Record<SlotName, ParsedItem[]>>;
  /** Unordered ring pairs. Each tuple is (finger1-mounted, finger2-mounted). */
  ringPairs: Array<[ParsedItem, ParsedItem]>;
  /** Pass-through from options for composer use. */
  trinketLock?: TrinketLock;
  /** Cartesian size: ∏(perSlot[s].length) × max(ringPairs.length, 1). */
  totalCombos: number;
  /** Per-slot pre-prune pool sizes — handy for logging. */
  prePruneSizes: Partial<Record<SlotName, number>>;
}

/**
 * Score every candidate per slot, drop ignore-listed items, then keep
 * items within `1 / multiplier` of the slot leader. Rings are pooled
 * across `finger1` + `finger2` and pruned together; the result is
 * paired via `allUnorderedPairs` (so 3 surviving rings → 3 pairs).
 */
export function pruneGearPool(opts: PruneOptions): PruneResult {
  const multiplier = opts.multiplier ?? DEFAULT_PRUNER_MULTIPLIER;
  const scorer = opts.scorer ?? ilvlScorer;
  const ignoreSet = opts.ignoreSet ?? new Set<string>();

  const perSlot: Partial<Record<SlotName, ParsedItem[]>> = {};
  const prePruneSizes: Partial<Record<SlotName, number>> = {};

  for (const slot of GEAR_LADDER_SLOTS) {
    if (slot === 'finger1' || slot === 'finger2') continue; // handled below
    const pool = opts.parsed.poolBySlot[slot] ?? [];
    prePruneSizes[slot] = pool.length;
    if (pool.length === 0) continue;
    perSlot[slot] = pruneSinglePool(pool, scorer, opts.weights, multiplier, ignoreSet);
  }

  // Rings: merge finger1 + finger2 pools, dedupe by identity (the addon
  // emits the same ring under whichever finger it was equipped on),
  // prune as a single pool, then form unordered pairs. Each pair is
  // ordered (a, b) with a → finger1, b → finger2 at emit time.
  const ringPool = mergeAndDedupe([
    ...(opts.parsed.poolBySlot.finger1 ?? []),
    ...(opts.parsed.poolBySlot.finger2 ?? []),
  ]);
  prePruneSizes.finger1 = ringPool.length;
  const prunedRings = ringPool.length > 0
    ? pruneSinglePool(ringPool, scorer, opts.weights, multiplier, ignoreSet)
    : [];
  const ringPairs: Array<[ParsedItem, ParsedItem]> = [];
  for (const [a, b] of allUnorderedPairs(prunedRings)) {
    ringPairs.push([a, b]);
  }

  // Cartesian size — multiply non-empty per-slot pool sizes. Empty
  // slots (no candidates) contribute 1 (we'll skip them at emit time).
  let totalCombos = 1;
  for (const slot of Object.keys(perSlot) as SlotName[]) {
    const list = perSlot[slot]!;
    if (list.length > 0) totalCombos *= list.length;
  }
  if (ringPairs.length > 0) totalCombos *= ringPairs.length;

  return {
    perSlot,
    ringPairs,
    trinketLock: opts.trinketLock,
    totalCombos,
    prePruneSizes,
  };
}

/**
 * Score, ignore-filter, and prune one slot's pool. Returns items with
 * `score * multiplier >= max_score` — i.e., within `1/multiplier` of
 * the leader. Equal-score items all survive; an empty pool returns
 * empty.
 *
 * Items with score <= 0 are excluded from leader selection (a 0 ilvl
 * sentinel would otherwise let the entire pool through).
 */
function pruneSinglePool(
  pool: readonly ParsedItem[],
  scorer: Scorer,
  weights: StatWeights,
  multiplier: number,
  ignoreSet: ReadonlySet<string>,
): ParsedItem[] {
  const eligible = pool.filter((it) => !ignoreSet.has(it.identity));
  if (eligible.length === 0) return [];
  let maxScore = -Infinity;
  for (const it of eligible) {
    const s = scorer(it, weights);
    if (s > maxScore) maxScore = s;
  }
  if (maxScore <= 0) {
    // All items scored <= 0 (likely ilvl=0 — name annotation missing).
    // Keep the first item so downstream sim still runs.
    return [eligible[0]!];
  }
  const survivors: ParsedItem[] = [];
  for (const it of eligible) {
    if (scorer(it, weights) * multiplier >= maxScore) survivors.push(it);
  }
  return survivors;
}

function mergeAndDedupe(items: readonly ParsedItem[]): ParsedItem[] {
  const byIdentity = new Map<string, ParsedItem>();
  for (const it of items) {
    if (!byIdentity.has(it.identity)) byIdentity.set(it.identity, it);
  }
  return Array.from(byIdentity.values());
}

export interface BuildProfilesetOptions {
  /**
   * Hard cap on emitted combos. If the cartesian would exceed this,
   * `buildGearProfileset` throws — callers should tighten the multiplier
   * or top-K per slot. Default 5000 (~3000 iter × 5000 combos = many
   * hours; deliberately conservative as a safety rail).
   */
  maxCombos?: number;
}

export interface ProfilesetBuild {
  /** SimC `profileset."<id>"+="..."` lines, joined by '\n'. */
  script: string;
  /** Map from profileset id to the resolved item set. */
  combosByName: Map<string, GearCombo>;
  /** Number of combos emitted. */
  comboCount: number;
}

/**
 * Build the SimC profileset script from a `PruneResult`. Each combo
 * gets a deterministic id `g_NNNN` (zero-padded for stable sort).
 * Each combo emits one `profileset` line per slot it carries.
 *
 * Trinket lock is required — Phase 4d depends on the 4c winner. Pass
 * `null` only if you're testing the cartesian shape in isolation.
 */
export function buildGearProfileset(
  prune: PruneResult,
  opts: BuildProfilesetOptions = {},
): ProfilesetBuild {
  const maxCombos = opts.maxCombos ?? 5000;

  // Materialize the per-slot lists in a deterministic slot order so
  // combo ids are stable across runs.
  const orderedSlots: SlotName[] = [];
  const slotOptions: ParsedItem[][] = [];
  for (const slot of GEAR_LADDER_SLOTS) {
    if (slot === 'finger1' || slot === 'finger2') continue;
    const list = prune.perSlot[slot];
    if (list && list.length > 0) {
      orderedSlots.push(slot);
      slotOptions.push(list);
    }
  }

  // Estimate size up front; throw before allocating millions of combos.
  let estimated = 1;
  for (const list of slotOptions) estimated *= list.length;
  if (prune.ringPairs.length > 0) estimated *= prune.ringPairs.length;
  if (estimated > maxCombos) {
    throw new Error(
      `gear cartesian would emit ${estimated} combos (max ${maxCombos}); tighten multiplier or top-K per slot`,
    );
  }

  const combos: GearCombo[] = [];
  walk(slotOptions, 0, {}, (slotPick) => {
    if (prune.ringPairs.length > 0) {
      for (const [r1, r2] of prune.ringPairs) {
        combos.push(buildCombo(combos.length, orderedSlots, slotPick, [r1, r2], prune.trinketLock));
      }
    } else {
      combos.push(buildCombo(combos.length, orderedSlots, slotPick, undefined, prune.trinketLock));
    }
  });

  const lines: string[] = [];
  const combosByName = new Map<string, GearCombo>();
  for (const combo of combos) {
    combosByName.set(combo.id, combo);
    for (const [slot, item] of Object.entries(combo.slots)) {
      if (!item) continue;
      lines.push(`profileset."${combo.id}"+="${formatItemLine(item, slot as SlotName)}"`);
    }
  }

  return {
    script: lines.join('\n'),
    combosByName,
    comboCount: combos.length,
  };
}

function buildCombo(
  index: number,
  orderedSlots: readonly SlotName[],
  slotPick: Record<string, ParsedItem>,
  rings: [ParsedItem, ParsedItem] | undefined,
  trinketLock: TrinketLock | undefined,
): GearCombo {
  const id = `g_${index.toString().padStart(4, '0')}`;
  const slots: Partial<Record<SlotName, ParsedItem>> = {};
  for (const slot of orderedSlots) {
    const item = slotPick[slot];
    if (item) slots[slot] = item;
  }
  if (rings) {
    slots.finger1 = rings[0];
    slots.finger2 = rings[1];
  }
  if (trinketLock) {
    slots.trinket1 = trinketLock.trinket1;
    slots.trinket2 = trinketLock.trinket2;
  }
  return { id, slots };
}

/** Iterative cartesian walk — calls `emit` for each per-slot pick. */
function walk(
  slotOptions: readonly ParsedItem[][],
  depth: number,
  pick: Record<string, ParsedItem>,
  emit: (pick: Record<string, ParsedItem>) => void,
): void {
  if (depth === slotOptions.length) {
    emit(pick);
    return;
  }
  const list = slotOptions[depth]!;
  for (const item of list) {
    pick[item.slot] = item;
    walk(slotOptions, depth + 1, pick, emit);
    delete pick[item.slot];
  }
}
