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
import {
  buildDiagnosticEntry,
  predictComboDps,
  type DiagnosticEntry,
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
  const combos = generateCombos(opts.rejected);

  // Empty case — nothing to test.
  if (combos.length === 0) {
    return {
      baseline_dps: 0,
      combos: [],
      winner: undefined,
      diagnostics: [],
    };
  }

  const build = buildBreakpointScript(opts.converged, combos);
  const profileScript = [opts.baseProfile.trim(), '', build.script].join('\n');
  const run = await runSimc({
    paths: opts.paths,
    profileScript,
    iterations: opts.iterations ?? 3000,
    scratchTag: `breakpoint-${Date.now()}`,
    onProgress: opts.onProgress,
  });

  const parsed = parseBreakpointResult({ run, build, tieWindowPct });

  // Build diagnostic entries.
  const diagnostics: DiagnosticEntry[] = parsed.combos.map((entry) => {
    const swapsForPredict = Object.entries(entry.combo.swaps).map(([slot, item]) => ({
      candidate_ilvl: item.ilvl,
      incumbent_ilvl: opts.converged[slot]?.ilvl ?? item.ilvl,
    }));
    const predicted_delta_dps = predictComboDps({
      swaps: swapsForPredict,
      baseline_dps: parsed.baseline_dps,
      dps_per_ilvl_pct: opts.dpsPerIlvlPct,
    });
    const isWinner = parsed.winner?.id === entry.combo.id;
    const isUpgrade = entry.delta_pct > tieWindowPct;
    return buildDiagnosticEntry({
      label: `breakpoint ${labelForCombo(entry.combo)}`,
      baseline_dps: parsed.baseline_dps,
      candidate_dps: entry.mean_dps,
      predicted_delta_dps,
      outcome: isWinner ? 'winner' : isUpgrade ? 'accepted' : 'loser',
    });
  });

  return {
    baseline_dps: parsed.baseline_dps,
    combos: parsed.combos,
    winner: parsed.winner,
    diagnostics,
  };
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
