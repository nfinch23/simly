/**
 * Dev-only full-sim cartesian — Raidbots Top Gear shape. Cross-product
 * of every non-trash bag item per slot, no stat-weight pruning, hard
 * combo cap, single SimC run.
 *
 * Used to measure how much DPS the greedy + breakpoint heuristic in the
 * quick pipeline leaves on the table vs an exhaustive search. NOT
 * intended for production users — the addon button is hidden unless
 * `SimlyResults.dev_mode === true`.
 *
 * Trinkets and rings are NOT re-cartesianed here; they keep the
 * pre-scan winners as locks. Top Gear conceptually re-evaluates them
 * too, but combinatorial blow-up is real, and on-actor pair sims at
 * 3000 iter are already what trinket/ring pre-scans do.
 */

import type { GearScanResult } from '@simly/shared';
import {
  buildGearProfileset,
  pruneGearPool,
  type GearCombo,
  type TrinketLock,
} from './gear-pruner';
import type { ParsedExport } from '../simc-export-parser';
import { runSimc, type RunnerPaths, type SimcRunResult } from '../simc-runner';
import { parseGearCoarseResult } from './gear-coarse';

/**
 * Hard cap on total combos. 2000 × 3000 iter ≈ 20-30 min on the user's
 * machine. If your pool produces more than this, the run aborts loud —
 * tighten the catalog (mark trash) or raise the cap.
 */
export const MAX_FULL_SIM_COMBOS = 2000;

/** Iter per combo. Matches the quick pipeline's breakpoint stage so the
 * comparison is apples-to-apples. */
export const FULL_SIM_ITERATIONS = 3000;

export interface RunGearFullSimOptions {
  paths: RunnerPaths;
  baseProfile: string;
  parsed: ParsedExport;
  /** Trinket pair from the pre-scan winner; locked for the full sim. */
  trinketLock: TrinketLock;
  /**
   * Identities to drop from the candidate pool — typically the union
   * of the catalog's 'trash' set and any manual ignore list. Items in
   * this set never reach SimC.
   */
  ignoreSet: ReadonlySet<string>;
  /** Override for tests. Production callers omit. */
  iterations?: number;
  maxCombos?: number;
  /** Streamed SimC stdout/stderr. */
  onProgress?: Parameters<typeof runSimc>[0]['onProgress'];
  /**
   * Pre-sim hook fired with the combo count so the queue can log
   * "running NNN combos at 3000 iter — estimated runtime ~M min".
   */
  onPlanReady?: (plan: {
    comboCount: number;
    perSlotSurvivors: Record<string, number>;
    ringPairs: number;
  }) => void;
}

export interface GearFullSimRunResult {
  result: GearScanResult;
  combosByName: Map<string, GearCombo>;
}

/**
 * Build pool with stat-weight pruning disabled (multiplier=Infinity
 * means every item with score > 0 survives — confirmed in
 * gear-pruner.ts line 355), run SimC, parse winner. The cartesian-too-
 * large case throws from buildGearProfileset with a clear message;
 * caller logs and marks the scan failed without aborting the whole
 * run.
 */
export async function runGearFullSimScan(
  opts: RunGearFullSimOptions,
): Promise<GearFullSimRunResult> {
  const iterations = opts.iterations ?? FULL_SIM_ITERATIONS;
  const maxCombos = opts.maxCombos ?? MAX_FULL_SIM_COMBOS;

  // Multiplier=Infinity keeps every non-zero-score item. No calibration
  // passed — we explicitly want the dumb path, not the smart pruner.
  const prune = pruneGearPool({
    parsed: opts.parsed,
    weights: {}, // unused when multiplier=Infinity in fallback path
    multiplier: Number.POSITIVE_INFINITY,
    ignoreSet: opts.ignoreSet,
    trinketLock: opts.trinketLock,
  });

  const build = buildGearProfileset(prune, { maxCombos });

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
    scratchTag: `gear-full-sim-${Date.now()}`,
    onProgress: opts.onProgress,
  });

  const result = parseGearCoarseResult(run, build.combosByName, iterations);
  // Rewrite the label from the gear-coarse default so the addon panel
  // and JSONL history can distinguish full-sim winners from quick ones.
  result.label = `Full sim (cartesian, ${iterations} iter, ${build.comboCount} combos)`;
  return { result, combosByName: build.combosByName };
}

/** Re-export so callers can use it for the comparison logger / history. */
export { parseGearCoarseResult } from './gear-coarse';
export type { SimcRunResult };
