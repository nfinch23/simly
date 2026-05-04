/**
 * Phase 4d-iii — `gear_refined` and `gear_final` stages.
 *
 * The coarse stage produces hundreds of combos at 1000 iter. Most
 * are not contenders; only the top handful (within `keep_threshold`
 * of the winner) deserve more sim time. This module re-runs those
 * survivors at a higher iteration count for a sharper ranking.
 *
 * Two stages share the same code path, parameterized by iteration
 * count + label + profileset prefix:
 *
 *   - gear_refined: 3000 iter, takes top survivors from coarse
 *     (within `coarse_keep_pct`, default 1%).
 *   - gear_final: 5000 iter, takes top survivors from refined
 *     (within `refined_keep_pct`, default 0.5%). Sidegrades within
 *     `tie_window_pct` (default 0.1%) are reported as ties.
 *
 * No pruning happens here — the combo set is already fixed at
 * stage entry. We just rebuild profilesets from each combo's slot
 * picks (with a fresh ID prefix to avoid SimC name collisions
 * across stages) and run SimC.
 */

import type { GearComboResult, GearScanResult } from '@simly/shared';
import {
  formatItemLine,
  type SlotName,
} from '../simc-export-parser';
import { runSimc, type RunnerPaths, type SimcRunResult } from '../simc-runner';
import type { GearCombo } from './gear-pruner';

export interface RunGearRerankOptions {
  paths: RunnerPaths;
  baseProfile: string;
  /**
   * Combos surviving the previous stage. Each combo's `slots` map is
   * re-emitted as a profileset; the existing IDs are NOT preserved —
   * we re-prefix them so refined/final profilesets don't collide
   * with coarse names if SimC ever sees both in the same run.
   */
  combos: ReadonlyMap<string, GearCombo>;
  iterations: number;
  /** Display label for the result, e.g. 'Gear ladder — refined stage (3000 iter)'. */
  label: string;
  /**
   * Profileset name prefix. Use 'r' for refined, 'f' for final. Each
   * combo gets `<prefix>_NNNN` IDs.
   */
  prefix: string;
  /** Used as the scratchTag for the runSimc call. */
  scratchTag: string;
  onProgress?: Parameters<typeof runSimc>[0]['onProgress'];
}

export interface GearRerankRunResult {
  result: GearScanResult;
  /** Reindexed combos by their new prefix-NNNN ID. */
  combosByName: Map<string, GearCombo>;
}

/**
 * Re-emit profileset lines from an existing combo map and run SimC.
 * Returns the GearScanResult plus a fresh map keyed by the new
 * prefix-NNNN IDs (so the queue can persist + post-process by ID).
 */
export async function runGearRerankScan(
  opts: RunGearRerankOptions,
): Promise<GearRerankRunResult> {
  const renamed = new Map<string, GearCombo>();
  const lines: string[] = [];
  let i = 0;
  for (const original of opts.combos.values()) {
    const id = `${opts.prefix}_${i.toString().padStart(4, '0')}`;
    const newCombo: GearCombo = { id, slots: original.slots };
    renamed.set(id, newCombo);
    for (const [slot, item] of Object.entries(newCombo.slots)) {
      if (!item) continue;
      lines.push(`profileset."${id}"+="${formatItemLine(item, slot as SlotName)}"`);
    }
    i++;
  }

  const profileScript = [opts.baseProfile.trim(), '', lines.join('\n')].join('\n');
  const run = await runSimc({
    paths: opts.paths,
    profileScript,
    iterations: opts.iterations,
    scratchTag: opts.scratchTag,
    onProgress: opts.onProgress,
  });

  const result = parseGearRerankResult(run, renamed, opts.iterations, opts.label);
  return { result, combosByName: renamed };
}

/**
 * Convert profileset results into a typed GearScanResult. Same shape
 * as parseGearCoarseResult — sorted desc by mean_dps, delta_pct
 * relative to the winner, sidegrades not yet flagged (caller does
 * that against tie_window_pct).
 */
export function parseGearRerankResult(
  run: SimcRunResult,
  combosByName: ReadonlyMap<string, GearCombo>,
  iterations: number,
  label: string,
): GearScanResult {
  const combos: GearComboResult[] = [];
  for (const ps of run.profilesets) {
    const combo = combosByName.get(ps.name);
    if (!combo) continue;
    const items = Object.entries(combo.slots).map(([slot, item]) => ({
      slot,
      item: {
        item_id: item!.item_id,
        name: item!.name,
        ilvl: item!.ilvl,
        identity: item!.identity,
      },
    }));
    combos.push({
      combo_id: ps.name,
      items,
      mean_dps: ps.mean,
      delta_pct: 0,
    });
  }
  combos.sort((a, b) => b.mean_dps - a.mean_dps);
  if (combos.length > 0) {
    const winnerDps = combos[0]!.mean_dps;
    for (const c of combos) {
      c.delta_pct = roundTo(((c.mean_dps - winnerDps) / winnerDps) * 100, 2);
    }
  }
  return {
    label,
    combos,
    winner: combos[0],
    iterations,
    total_combos: combos.length,
  };
}

/**
 * Pick the combos from a previous stage's result that are within
 * `keep_threshold_pct` of the winner. Returns a new map keyed by the
 * SOURCE combo's ID (caller will re-prefix when running the next
 * stage). Caller is responsible for cross-referencing against the
 * source stage's `combosByName` to recover full slot info.
 *
 * Edge cases:
 *   - Empty input: returns empty map.
 *   - 1 combo: returns that combo (within itself by 0%).
 *   - All ties: returns all combos.
 */
export function selectSurvivors(
  prevCombos: ReadonlyArray<GearComboResult>,
  prevCombosByName: ReadonlyMap<string, GearCombo>,
  keep_threshold_pct: number,
): Map<string, GearCombo> {
  const out = new Map<string, GearCombo>();
  if (prevCombos.length === 0) return out;
  const winnerDps = prevCombos[0]!.mean_dps;
  const cutoff = winnerDps * (1 - keep_threshold_pct / 100);
  for (const c of prevCombos) {
    if (c.mean_dps < cutoff) continue;
    const original = prevCombosByName.get(c.combo_id);
    if (!original) continue;
    out.set(c.combo_id, original);
  }
  return out;
}

function roundTo(n: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}
