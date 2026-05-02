import {
  RESULTS_SCHEMA_VERSION,
  type BestFlaskResult,
  type BestFoodResult,
  type ComposedLoadout,
  type ScanCollection,
  type ScanRecord,
  type Scenario,
  type SimlyDB,
  type SimlyResults,
  type StatWeights,
  type TrinketPreScanResult,
} from '@simly/shared';
import { writeLuaFile } from './lua-writer';
import { runSimc } from './simc-runner';
import type { BootstrapResult } from './simc-bootstrap';
import type { WowPaths } from './wow-paths';
import { buildAllScanLines, parseAllScanRecords } from './scans/registry';
import { runStatWeightsScan } from './scans/stat-weights';
import {
  parseTrinketPreScanResult,
  runTrinketPreScanSim,
} from './scans/trinket-pre-scan';
import {
  getTrinketPool,
  parseSimcExport,
  type ParsedExport,
} from './simc-export-parser';
import { STATIC_DESTRO_WARLOCK_PROFILE } from './static-profile';

/** Sentinel values the addon writes when it can't produce a real export. */
export const ADDON_FALLBACK_SENTINELS: ReadonlySet<string> = new Set([
  'PLACEHOLDER_PROFILE',
  'NO_PROFILE_AVAILABLE',
]);

export interface ScanQueueOptions {
  paths: WowPaths;
  simc: BootstrapResult;
  /**
   * Initial value for `lastCompletedAt`. Defaults to "now" so the first
   * watcher tick after boot does not immediately re-run an old request
   * stamped before this session started.
   */
  initialLastCompletedAt?: number;
}

export interface PastedProfileSource {
  /** Raw SimC profile string the user pasted into the desktop UI. */
  profileScript: string;
  /** Character key to attribute the run to (synthesized for paste-input). */
  characterKey: string;
  /** Scenario; for paste-input we always use single-target Patchwerk. */
  scenario: Scenario;
}

/**
 * Owns the desktop's sim queue. v1 runs one consumables scan per
 * request — Phase 4 swaps the body for the multi-stage gear ladder
 * without changing the public API.
 *
 * Two entry points:
 *   - `maybeRunForSavedVars(db)` — gated on `db.update_requested_at`
 *     being newer than the last completed run. Triggered by the addon's
 *     "Update sims" panel button.
 *   - `runWithPastedProfile(source)` — direct trigger from the desktop
 *     UI's paste-a-SimC-string flow. Bypasses the gate.
 */
export class ScanQueue {
  private lastCompletedAt: number;
  private inFlight = false;

  constructor(private readonly opts: ScanQueueOptions) {
    this.lastCompletedAt =
      opts.initialLastCompletedAt ?? Math.floor(Date.now() / 1000);
  }

  /**
   * Decide whether to run, given the latest SavedVars snapshot. Runs only
   * when `update_requested_at` is strictly newer than the last completed
   * run AND no sim is currently in-flight. All gate decisions are logged
   * for debugging.
   */
  maybeRunForSavedVars(db: SimlyDB): void {
    if (this.inFlight) {
      console.log('[queue] sim in flight; ignoring SavedVars update');
      return;
    }
    if (db.update_requested_at <= this.lastCompletedAt) {
      console.log(
        `[queue] no new request (update_requested_at=${db.update_requested_at} <= last_completed=${this.lastCompletedAt}); idle`,
      );
      return;
    }
    console.log(
      `[queue] new request from addon (update_requested_at=${db.update_requested_at}); running for ${db.character.name}`,
    );
    void this.runForSavedVars(db);
  }

  /**
   * Direct trigger from the desktop UI's paste-a-SimC-string flow.
   * Bypasses the SavedVars gate. The renderer's paste view will call
   * this in Phase 5; nothing wires it today, but the entry point exists
   * so Phase 5 doesn't have to refactor the queue.
   */
  async runWithPastedProfile(source: PastedProfileSource): Promise<void> {
    if (this.inFlight) {
      console.log('[queue] sim in flight; rejecting paste-input run');
      return;
    }
    console.log(`[queue] paste-input run for ${source.characterKey}`);
    // Paste input is treated as a real character profile — caller has
    // already pasted real `warlock="..." level=... ...` lines. The
    // queue runs the same stages as a SavedVars-triggered run.
    await this.runScan({
      baseProfile: source.profileScript,
      useRealExport: true,
      characterKey: source.characterKey,
      scenario: source.scenario,
    });
  }

  private async runForSavedVars(db: SimlyDB): Promise<void> {
    const character = db.character;
    const characterKey = `${character.name}-${character.realm}-${character.region}`;
    const exportTrimmed = (db.simc_export ?? '').trim();
    const useRealExport =
      exportTrimmed.length > 0 && !ADDON_FALLBACK_SENTINELS.has(exportTrimmed);
    const baseProfile = useRealExport
      ? exportTrimmed
      : STATIC_DESTRO_WARLOCK_PROFILE;
    let parsedExport: ParsedExport | undefined;
    if (!useRealExport) {
      console.log(
        `[sim] simc_export is "${exportTrimmed.slice(0, 40)}"; using static fallback profile`,
      );
    } else {
      console.log(`[sim] using real character export (${exportTrimmed.length} bytes)`);
      try {
        parsedExport = parseSimcExport(exportTrimmed);
        const slotCounts = Object.entries(parsedExport.poolBySlot)
          .map(([slot, items]) => `${slot}:${items.length}`)
          .join(' ');
        console.log(
          `[sim] gear pool: ${parsedExport.equipped.length} equipped, ${parsedExport.bag.length} in bags (${slotCounts})`,
        );
      } catch (err) {
        console.warn('[sim] failed to parse SimC export for gear pool log:', (err as Error).message);
      }
    }

    await this.runScan({
      baseProfile,
      useRealExport,
      parsedExport,
      characterKey,
      scenario: db.active_scenario,
    });
  }

  private async runScan(args: {
    baseProfile: string;
    useRealExport: boolean;
    parsedExport?: ParsedExport;
    characterKey: string;
    scenario: Scenario;
  }): Promise<void> {
    this.inFlight = true;
    try {
      const runnerPaths = {
        binPath: this.opts.simc.binPath,
        scratchDir: this.opts.simc.scratchDir,
      };
      const scans: ScanCollection = {};

      // Stage 1: stat weights (only on a real character export — the
      // static fallback profile has no gear/talents and produces
      // garbage weights). Failure is non-fatal; we still run consumables.
      if (args.useRealExport) {
        const swStarted = Math.floor(Date.now() / 1000);
        try {
          const sw = await runStatWeightsScan({
            paths: runnerPaths,
            baseProfile: args.baseProfile,
          });
          const swFinished = Math.floor(Date.now() / 1000);
          const swRecord: ScanRecord<StatWeights> = {
            status: 'done',
            started_at: swStarted,
            finished_at: swFinished,
            data: sw.weights,
          };
          scans.stat_weights = swRecord;
          const summary = Object.entries(sw.weights)
            .map(([k, v]) => `${k}=${v?.toFixed(2)}`)
            .join(' ');
          console.log(
            `[sim] stat_weights (${(sw.durationMs / 1000).toFixed(1)}s): ${summary}`,
          );
        } catch (err) {
          console.error('[sim] stat_weights run failed:', (err as Error).message);
          scans.stat_weights = {
            status: 'failed',
            started_at: swStarted,
            finished_at: Math.floor(Date.now() / 1000),
            error: (err as Error).message,
          };
        }
      }

      // Stage 1.5: trinket pre-scan. Only when we have a real parsed
      // export (need actual bag trinkets) AND at least 2 unique trinkets
      // in the pool (otherwise no pairs to compare). Surfaces the best
      // trinket pair to the panel and is read by Phase 4d's gear ladder
      // to lock trinkets in for downstream stages.
      if (args.useRealExport && args.parsedExport) {
        const trinkets = getTrinketPool(args.parsedExport);
        if (trinkets.length >= 2) {
          const tStarted = Math.floor(Date.now() / 1000);
          const t0t = Date.now();
          try {
            const { run, pairsByName } = await runTrinketPreScanSim({
              paths: runnerPaths,
              baseProfile: args.baseProfile,
              trinkets,
            });
            const tFinished = Math.floor(Date.now() / 1000);
            const data = parseTrinketPreScanResult(run, pairsByName);
            scans.trinket_pre_scan = {
              status: 'done',
              started_at: tStarted,
              finished_at: tFinished,
              data,
            };
            const dt = ((Date.now() - t0t) / 1000).toFixed(1);
            const w = data.winner;
            const winnerStr = w
              ? `${w.trinket1.name} + ${w.trinket2.name} @ ${Math.round(w.mean_dps)} dps`
              : '(no winner)';
            console.log(
              `[sim] trinket_pre_scan (${dt}s, ${trinkets.length} trinkets, ${data.pairs.length} pairs): ${winnerStr}`,
            );
          } catch (err) {
            console.error('[sim] trinket_pre_scan failed:', (err as Error).message);
            scans.trinket_pre_scan = {
              status: 'failed',
              started_at: tStarted,
              finished_at: Math.floor(Date.now() / 1000),
              error: (err as Error).message,
            };
          }
        } else {
          console.log(
            `[sim] trinket_pre_scan: only ${trinkets.length} trinket(s) in pool; skipping`,
          );
        }
      }

      // Stage 2: consumables (flask + food) via profileset sim.
      const startedAt = Math.floor(Date.now() / 1000);
      const t0 = Date.now();
      let run;
      try {
        run = await runSimc({
          paths: runnerPaths,
          profileScript: [args.baseProfile, '', buildAllScanLines()].join('\n'),
          iterations: 1000,
          scratchTag: `consumables-${Date.now()}`,
        });
      } catch (err) {
        console.error('[sim] consumables sim failed:', err);
        return;
      }
      const finishedAt = Math.floor(Date.now() / 1000);
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(
        `[sim] consumables (${dt}s, simc ${run.simcVersion} ${run.gitRevision.slice(0, 8)}): ${run.profilesets.length} profileset(s)`,
      );

      const consumableScans = parseAllScanRecords(run, startedAt, finishedAt);
      Object.assign(scans, consumableScans);

      if (Object.keys(scans).length === 0) {
        console.error('[sim] no scan results produced');
        return;
      }
      for (const [id, record] of Object.entries(scans)) {
        const data = record?.data as { best?: { name: string; dps: number } } | undefined;
        if (data?.best) {
          console.log(`[sim] ${id}: ${data.best.name} @ ${data.best.dps} dps`);
        }
      }

      const composed = composeFromConsumableScans(scans);
      const results: SimlyResults = {
        schema_version: RESULTS_SCHEMA_VERSION,
        generated_at: finishedAt,
        simc_version: `${run.simcVersion} (${run.gitRevision.slice(0, 8)})`,
        character_key: args.characterKey,
        active_scenario: args.scenario,
        scans,
        composed,
      };

      try {
        await writeLuaFile(
          this.opts.paths.resultsLuaPath,
          'SimlyResults',
          results as unknown as Parameters<typeof writeLuaFile>[2],
        );
        console.log('[sim] wrote SimlyResults.lua — /reload in WoW to see it');
      } catch (err) {
        console.error('[sim] failed to write SimlyResults.lua:', err);
      }

      this.lastCompletedAt = finishedAt;
    } finally {
      this.inFlight = false;
    }
  }
}

/**
 * Phase 3 v1-shim composer: assemble the addon-facing `composed` view
 * from the two consumable scans we run today. Phase 4 replaces this with
 * a real `composer.ts` that combines results from the full gear ladder.
 */
export function composeFromConsumableScans(
  scans: ScanCollection,
): ComposedLoadout | undefined {
  const flask = scans.best_flask?.data as BestFlaskResult | undefined;
  const food = scans.best_food?.data as BestFoodResult | undefined;
  if (!flask && !food) return undefined;
  return {
    label: 'Best consumables (single-target Patchwerk)',
    flask: flask?.best ? { item_id: flask.best.item_id, name: flask.best.name } : undefined,
    food: food?.best ? { item_id: food.best.item_id, name: food.best.name } : undefined,
  };
}
