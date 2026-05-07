/**
 * Phase 4d-ii — `gear_coarse` scan stage.
 *
 * Wires the 4d-i pruner + cartesian builder into a real SimC run at
 * the SCOPE-default 1000 iterations. Reads the 4c trinket pre-scan
 * winner as the locked trinket pair. Surfaces a typed
 * `GearScanResult` for the addon panel (Phase 4e renders it) and
 * exposes the combos-by-name map so the queue can record losers to
 * the ignore list.
 */

import type { GearScanResult, GearComboResult, StatWeights } from '@simly/shared';
import {
  buildGearProfileset,
  pruneGearPool,
  type GearCombo,
  type PrunerCalibration,
  type TrinketLock,
} from './gear-pruner';
import type { ParsedExport } from '../simc-export-parser';
import { runSimc, type RunnerPaths, type SimcRunResult } from '../simc-runner';
import { COARSE_ITERATIONS } from '../gear-config';

export interface RunGearCoarseOptions {
  paths: RunnerPaths;
  /** Real character profile string (warlock="..." level=... ...). */
  baseProfile: string;
  parsed: ParsedExport;
  weights: StatWeights;
  trinketLock: TrinketLock;
  /** Iterations per profileset. SCOPE 4 step 3 default: 1000. */
  iterations?: number;
  /** Pruner multiplier override. Default 1.5. */
  multiplier?: number;
  /** Identity hashes to skip. 4d-ii passes empty; 4d-iii reads from the ignore-list store. */
  ignoreSet?: ReadonlySet<string>;
  /** Hard cap on emitted combos. Default 5000 (gear-pruner default). */
  maxCombos?: number;
  /** Optional calibration from gear catalog. When provided, replaces ilvl-multiplier pruning. */
  calibration?: PrunerCalibration;
  /** Streamed progress lines from SimC stdout/stderr. */
  onProgress?: Parameters<typeof runSimc>[0]['onProgress'];
  /**
   * Optional pre-sim hook — called once with the cartesian shape after
   * pruning but before SimC spawns. The queue uses this to log the
   * combo count and the per-slot survivor breakdown so the user knows
   * what's about to run.
   */
  onPlanReady?: (plan: {
    comboCount: number;
    perSlotSurvivors: Record<string, number>;
    ringPairs: number;
  }) => void;
}

export interface GearCoarseRunResult {
  result: GearScanResult;
  /** Map from profileset name back to the resolved item set; used by ignore-list writer. */
  combosByName: Map<string, GearCombo>;
}

/** Top-level entry — prune, build profileset, run SimC, map results. */
export async function runGearCoarseScan(
  opts: RunGearCoarseOptions,
): Promise<GearCoarseRunResult> {
  const iterations = opts.iterations ?? COARSE_ITERATIONS;
  const prune = pruneGearPool({
    parsed: opts.parsed,
    weights: opts.weights,
    multiplier: opts.multiplier,
    ignoreSet: opts.ignoreSet,
    trinketLock: opts.trinketLock,
    calibration: opts.calibration,
  });
  const build = buildGearProfileset(prune, { maxCombos: opts.maxCombos });

  if (opts.onPlanReady) {
    const perSlotSurvivors: Record<string, number> = {};
    for (const [slot, list] of Object.entries(prune.perSlot)) {
      if (list) perSlotSurvivors[slot] = list.length;
    }
    opts.onPlanReady({
      comboCount: build.comboCount,
      perSlotSurvivors,
      ringPairs: prune.ringPairs.length,
    });
  }

  const profileScript = [opts.baseProfile.trim(), '', build.script].join('\n');
  const run = await runSimc({
    paths: opts.paths,
    profileScript,
    iterations,
    scratchTag: `gear-coarse-${Date.now()}`,
    onProgress: opts.onProgress,
  });

  const result = parseGearCoarseResult(run, build.combosByName, iterations);
  return { result, combosByName: build.combosByName };
}

/**
 * Convert profileset results back into typed combos. Sorted desc by
 * mean DPS; delta_pct is computed against the winner. Profilesets
 * without a matching combo entry are dropped (defensive — shouldn't
 * happen if the build/run is consistent).
 */
export function parseGearCoarseResult(
  run: SimcRunResult,
  combosByName: ReadonlyMap<string, GearCombo>,
  iterations: number,
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
    label: 'Gear ladder — coarse stage (1000 iter)',
    combos,
    winner: combos[0],
    iterations,
    total_combos: combos.length,
  };
}

function roundTo(n: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}
