/**
 * Quick-sim swap test.
 *
 * Given a known best_loadout and a list of "new" items (not yet
 * simmed), build a SimC profileset that:
 *
 *   - has a baseline profileset that pins every slot to the best
 *     loadout's items, and
 *   - one profileset per (slot, candidate) pair that swaps the
 *     candidate into that slot while leaving everything else as in
 *     the baseline.
 *
 * Run this at higher iterations than gear-coarse (default 2000)
 * because the profileset count is small (typically 1-5) so the per-
 * profileset cost goes mostly to convergence rather than
 * combinatorial breadth. The decision is then per-item:
 *   delta_pct = (mean_dps - baseline_dps) / baseline_dps × 100
 *
 * Items whose best slot-swap delta is positive (beyond the tie
 * window) are upgrades and trigger the full pipeline. Items whose
 * delta is negative are recorded into the catalog as "trash" or
 * "good" depending on how badly they lost.
 *
 * Rings are tested in BOTH finger1 and finger2 — for ring slots the
 * baseline has two entries and either could be replaced. We use the
 * better of the two swap deltas as the item's evaluation.
 *
 * Weapons in a different config than the baseline (e.g., a 2H when
 * baseline is 1H+OH) are too ambiguous for swap-testing; the planner
 * filters those out and falls through to full_sim.
 */

import type { ParsedItem, SlotName } from './simc-export-parser';
import { formatItemLine } from './simc-export-parser';
import { runSimc, type RunnerPaths, type SimcRunResult } from './simc-runner';
import type { BestLoadoutSlot } from './gear-catalog';
import { SWAP_TEST_ITERATIONS, TIE_WINDOW_PCT } from './gear-config';

const BASELINE_NAME = 'swap_baseline';

export interface SwapCandidate {
  slot: string;
  item: ParsedItem;
  /** Profileset names for this candidate, one per slot we're testing in.
   * For non-ring slots: 1 entry. For rings: 2 (finger1, finger2). */
  profileset_names: string[];
  /**
   * For weapon-aware swap candidates (rendered from a `WeaponSwap`):
   * identity of the off_hand item paired with this MH in the profileset.
   * - `string` → 1H + this specific OH; lets greedy distinguish two
   *   `(mh, oh_A) / (mh, oh_B)` profilesets that share the same MH
   *   identity (the OH-sub-sim case).
   * - `null` → 2H weapon (off_hand cleared).
   * - `undefined` → non-weapon candidate.
   */
  weapon_oh_identity?: string | null;
}

/**
 * Weapon-aware swap candidate. Tests a `(main_hand, off_hand)` tuple as
 * a single profileset so the slot-lockout semantics are correct:
 *   - `oh: null` → 2H weapon. Profileset emits `off_hand=` (empty value)
 *     to clear the slot, matching WoW's actual behavior.
 *   - `oh: ParsedItem` → 1H + OH pair. Profileset emits both slots.
 *
 * Reported back as a SwapResult keyed on the MH item's identity. The
 * paired OH is recorded in `paired_off_hand` for greedy to fold into
 * its converged loadout when this candidate wins.
 */
export interface WeaponSwap {
  mh: ParsedItem;
  oh: ParsedItem | null;
}

export interface BuildSwapScriptResult {
  script: string;
  candidates: SwapCandidate[];
  /** baseline profileset name, exposed for the result mapper. */
  baselineName: string;
}

/**
 * Build the SimC profileset script for a swap test. The baseline
 * profileset asserts every best_loadout slot via `profileset.<base>+=`
 * lines so that each candidate profileset can override one slot
 * cleanly. SimC profileset semantics: each `profileset.<name>+=...`
 * overrides on a per-key basis from the parent profile, so we have
 * to spell out every baseline slot inside the baseline profileset
 * (otherwise the candidate's "everything else" would inherit from the
 * top-level profile, not from the best loadout).
 */
export function buildSwapTestScript(
  bestLoadout: Record<string, BestLoadoutSlot>,
  baselineItemBySlot: Record<string, ParsedItem>,
  newItems: readonly ParsedItem[],
  weaponSwaps: readonly WeaponSwap[] = [],
): BuildSwapScriptResult {
  const lines: string[] = [];

  // Baseline: spell out the entire best loadout. We need ParsedItems
  // with bonus_ids etc. to render proper SimC lines — caller resolves
  // identities → ParsedItems via baselineItemBySlot.
  for (const [slot, slotInfo] of Object.entries(bestLoadout)) {
    const item = baselineItemBySlot[slot];
    if (!item) continue; // can't render this slot — caller should have caught this
    void slotInfo;
    lines.push(`profileset."${BASELINE_NAME}"+="${formatItemLine(item, slot as SlotName)}"`);
  }

  // For each new item, emit one or two candidate profilesets.
  const candidates: SwapCandidate[] = [];
  for (const item of newItems) {
    const slotsToTry = swapTargetSlots(item.slot);
    if (slotsToTry.length === 0) continue;

    // Each candidate profileset starts from the same baseline slots
    // (we re-spell them) then overrides the target slot with the
    // candidate's line.
    const profileset_names: string[] = [];
    for (const targetSlot of slotsToTry) {
      const name = `swap_${targetSlot}_${shortHash(item.identity)}`;
      profileset_names.push(name);
      for (const [slot, slotInfo] of Object.entries(bestLoadout)) {
        const baseItem = baselineItemBySlot[slot];
        if (!baseItem) continue;
        void slotInfo;
        if (slot === targetSlot) {
          // Override with candidate.
          lines.push(`profileset."${name}"+="${formatItemLine(item, targetSlot as SlotName)}"`);
        } else {
          lines.push(`profileset."${name}"+="${formatItemLine(baseItem, slot as SlotName)}"`);
        }
      }
    }
    candidates.push({ slot: item.slot, item, profileset_names });
  }

  // Weapon-aware swaps: emit a single profileset per (mh, oh) tuple
  // that re-spells the entire baseline EXCEPT main_hand AND off_hand,
  // then writes those two slots based on the tuple. For 2H (oh=null),
  // emit `off_hand=` empty to clear the slot — matching WoW's lockout.
  for (const ws of weaponSwaps) {
    const name = `swap_weapon_${shortHash(ws.mh.identity + (ws.oh?.identity ?? '_2h'))}`;
    for (const [slot, slotInfo] of Object.entries(bestLoadout)) {
      void slotInfo;
      if (slot === 'main_hand' || slot === 'off_hand') continue;
      const baseItem = baselineItemBySlot[slot];
      if (!baseItem) continue;
      lines.push(`profileset."${name}"+="${formatItemLine(baseItem, slot as SlotName)}"`);
    }
    // main_hand: always the candidate.
    lines.push(`profileset."${name}"+="${formatItemLine(ws.mh, 'main_hand')}"`);
    // off_hand: paired item, or empty value to clear the slot.
    if (ws.oh) {
      lines.push(`profileset."${name}"+="${formatItemLine(ws.oh, 'off_hand')}"`);
    } else {
      lines.push(`profileset."${name}"+="off_hand="`);
    }
    candidates.push({
      slot: 'main_hand',
      item: ws.mh,
      profileset_names: [name],
      weapon_oh_identity: ws.oh ? ws.oh.identity : null,
    });
  }

  return {
    script: lines.join('\n'),
    candidates,
    baselineName: BASELINE_NAME,
  };
}

/**
 * Which physical SimC slots a parsed-item slot can occupy in a swap.
 * Rings can sit on either finger; trinkets either trinket; weapons
 * are kept simple (slot-for-slot — 2H/1H mismatches are filtered
 * upstream by the planner).
 */
export function swapTargetSlots(parsedSlot: string): string[] {
  if (parsedSlot === 'finger1' || parsedSlot === 'finger2') {
    return ['finger1', 'finger2'];
  }
  if (parsedSlot === 'trinket1' || parsedSlot === 'trinket2') {
    return ['trinket1', 'trinket2'];
  }
  // Skip cosmetic / non-DPS slots.
  if (parsedSlot === 'tabard' || parsedSlot === 'shirt') return [];
  return [parsedSlot];
}

export interface SwapResult {
  slot: string;
  item: { item_id: number; name: string; identity: string; ilvl: number };
  /** Best (= least-negative; positive if upgrade) delta across the
   * candidate's tried slot positions. */
  delta_pct: number;
  /** mean_dps that produced delta_pct. */
  mean_dps: number;
  is_upgrade: boolean;
  /** Per-position results — useful for debugging ring-slot asymmetry. */
  position_deltas: Array<{ position_slot: string; delta_pct: number; mean_dps: number }>;
  /**
   * Mirror of `SwapCandidate.weapon_oh_identity`. Used by greedy-search
   * to disambiguate two SwapResults that share the same MH identity but
   * came from different `(mh, oh)` sub-sim profilesets.
   */
  weapon_oh_identity?: string | null;
}

export interface SwapTestResult {
  baseline_dps: number;
  results: SwapResult[];
  any_upgrade: boolean;
}

/**
 * Convert profileset results back into per-candidate verdicts. The
 * baseline DPS is taken from the baseline profileset; each
 * candidate's delta_pct is computed against that, and rings/trinkets
 * use the BEST of their two position swaps.
 *
 * `tie_window_pct` defaults to 0.1 (matching the catalog's tie
 * window) — items within ±tie_window of the baseline are NOT
 * considered upgrades; they're sidegrades.
 */
export function parseSwapTestResult(
  run: SimcRunResult,
  build: BuildSwapScriptResult,
  tie_window_pct = TIE_WINDOW_PCT,
): SwapTestResult {
  const psByName = new Map<string, number>();
  for (const ps of run.profilesets) psByName.set(ps.name, ps.mean);
  const baseline_dps = psByName.get(build.baselineName) ?? 0;

  const results: SwapResult[] = [];
  for (const candidate of build.candidates) {
    // profileset_names is in the same order as swapTargetSlots(candidate.item.slot).
    // Splitting the name on '_' breaks for compound slot names (main_hand,
    // off_hand), so we recover the position-slot from the same source the
    // builder used.
    const positionSlots = swapTargetSlots(candidate.item.slot);
    const positions = candidate.profileset_names
      .map((name, idx) => {
        const mean_dps = psByName.get(name);
        if (mean_dps === undefined) return undefined;
        const position_slot = positionSlots[idx] ?? candidate.slot;
        const delta_pct = baseline_dps > 0
          ? roundTo(((mean_dps - baseline_dps) / baseline_dps) * 100, 2)
          : 0;
        return { position_slot, delta_pct, mean_dps };
      })
      .filter((p): p is { position_slot: string; delta_pct: number; mean_dps: number } => p !== undefined);

    if (positions.length === 0) continue;
    const best = positions.reduce((a, b) => (a.delta_pct >= b.delta_pct ? a : b));
    results.push({
      slot: candidate.slot,
      item: {
        item_id: candidate.item.item_id,
        name: candidate.item.name,
        identity: candidate.item.identity,
        ilvl: candidate.item.ilvl,
      },
      delta_pct: best.delta_pct,
      mean_dps: best.mean_dps,
      is_upgrade: best.delta_pct > tie_window_pct,
      position_deltas: positions,
      ...(candidate.weapon_oh_identity !== undefined
        ? { weapon_oh_identity: candidate.weapon_oh_identity }
        : {}),
    });
  }

  return {
    baseline_dps,
    results,
    any_upgrade: results.some((r) => r.is_upgrade),
  };
}

export interface RunSwapTestOptions {
  paths: RunnerPaths;
  baseProfile: string;
  bestLoadout: Record<string, BestLoadoutSlot>;
  baselineItemBySlot: Record<string, ParsedItem>;
  newItems: readonly ParsedItem[];
  /**
   * Weapon-aware swap candidates: each entry is an explicit
   * (main_hand, off_hand) pair. Pass these instead of a raw weapon item
   * in `newItems` whenever the swap involves the 2H/1H slot lockout.
   * The greedy loop builds these via `oh-pairing.ts` so each MH gets
   * its best OH partner.
   */
  weaponSwaps?: readonly WeaponSwap[];
  iterations?: number;
  tie_window_pct?: number;
  onProgress?: Parameters<typeof runSimc>[0]['onProgress'];
}

/** Top-level entry. Builds, runs, parses. */
export async function runSwapTest(
  opts: RunSwapTestOptions,
): Promise<{ result: SwapTestResult; build: BuildSwapScriptResult }> {
  const iterations = opts.iterations ?? SWAP_TEST_ITERATIONS;
  const build = buildSwapTestScript(
    opts.bestLoadout,
    opts.baselineItemBySlot,
    opts.newItems,
    opts.weaponSwaps,
  );
  const profileScript = [opts.baseProfile.trim(), '', build.script].join('\n');
  const run = await runSimc({
    paths: opts.paths,
    profileScript,
    iterations,
    scratchTag: `swap-test-${Date.now()}`,
    onProgress: opts.onProgress,
  });
  const result = parseSwapTestResult(run, build, opts.tie_window_pct);
  return { result, build };
}

function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function roundTo(n: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}
