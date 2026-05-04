import {
  RESULTS_SCHEMA_VERSION,
  type ComposedLoadout,
  type GearScanResult,
  type ScanCollection,
  type ScanRecord,
  type Scenario,
  type SimlyDB,
  type SimlyResults,
  type StatWeights,
  type TrinketPreScanResult,
} from '@simly/shared';
import { writeLuaFile } from './lua-writer';
import { parseResultsFile } from './lua-parser';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { runSimc } from './simc-runner';
import type { BootstrapResult } from './simc-bootstrap';
import type { WowPaths } from './wow-paths';
import { buildAllScanLines, parseAllScanRecords } from './scans/registry';
import { runStatWeightsScan } from './scans/stat-weights';
import {
  finalizeTrinketResult,
  parseTrinketPreScanResult,
  profilesetsToPairResults,
  runTrinketPairsSim,
  runTrinketPreScanSim,
} from './scans/trinket-pre-scan';
import { runGearCoarseScan } from './scans/gear-coarse';
import { runGearRerankScan, selectSurvivors } from './scans/gear-rerank';
import type { GearCombo, TrinketLock } from './scans/gear-pruner';
import { computeItemObservations, IgnoreListStore } from './ignore-list';
import {
  mergePairResults,
  planTrinketScan,
  poolSignature,
  selectTopTrinkets,
  TrinketCacheStore,
} from './trinket-cache';
import {
  buildCatalogSummary,
  fullPoolSignature,
  GearCatalogStore,
  ignoredIdentities,
  updateCatalogFromGearScan,
  updateCatalogFromSwapTest,
  type GearCatalogEntry,
} from './gear-catalog';
import { planQuickSim, type QuickSimDecision } from './quick-sim';
import { runSwapTest, type SwapTestResult } from './swap-test';
import {
  getTrinketPool,
  parseSimcExport,
  type ParsedExport,
} from './simc-export-parser';
import { STATIC_DESTRO_WARLOCK_PROFILE } from './static-profile';
import {
  composeFromScans,
  composeFromConsumableScans,
  deriveGearFromCatalog,
  refreshScanTimestamps,
  synthesizeResultsFromCatalog,
} from './composer';
import {
  formatRelative,
  makeStageProgressLogger,
  setWindowTitle,
  showScanCompleteNotification,
} from './stage-logger';
import {
  tryCreateGearCatalog,
  tryCreateIgnoreList,
  tryCreateTrinketCache,
} from './store-factories';

// Re-export so existing tests / out-of-tree callers continue to find
// these at scan-queue.ts. Internal callers should import from the
// extracted modules directly.
export { composeFromScans, composeFromConsumableScans } from './composer';
export { showScanCompleteNotification } from './stage-logger';

/** Sentinel values the addon writes when it can't produce a real export. */
export const ADDON_FALLBACK_SENTINELS: ReadonlySet<string> = new Set([
  'PLACEHOLDER_PROFILE',
  'NO_PROFILE_AVAILABLE',
]);

// Phase 4d-iii ladder thresholds re-exported from gear-config.ts so
// existing consumers continue to find them at scan-queue. Canonical
// values live in gear-config.ts; Phase 5 settings UI will swap those
// for electron-store-backed live values.
export {
  COARSE_KEEP_THRESHOLD_PCT,
  REFINED_KEEP_THRESHOLD_PCT,
  REFINED_ITERATIONS,
  FINAL_ITERATIONS,
} from './gear-config';
import {
  COARSE_KEEP_THRESHOLD_PCT,
  REFINED_KEEP_THRESHOLD_PCT,
  REFINED_ITERATIONS,
  FINAL_ITERATIONS,
} from './gear-config';

export interface ScanQueueOptions {
  paths: WowPaths;
  simc: BootstrapResult;
  /**
   * Initial value for `lastCompletedAt`. Defaults to "now" so the first
   * watcher tick after boot does not immediately re-run an old request
   * stamped before this session started.
   */
  initialLastCompletedAt?: number;
  /**
   * Optional ignore-list store. Defaults to a real electron-store-backed
   * instance; tests inject a temp-cwd one to avoid touching userData.
   */
  ignoreList?: IgnoreListStore;
  /** Optional trinket cache store. Same pattern as ignoreList. */
  trinketCache?: TrinketCacheStore;
  /** Optional gear catalog store. Same pattern. */
  gearCatalog?: GearCatalogStore;
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
  private readonly ignoreList: IgnoreListStore | undefined;
  private readonly trinketCache: TrinketCacheStore | undefined;
  private readonly gearCatalog: GearCatalogStore | undefined;

  constructor(private readonly opts: ScanQueueOptions) {
    this.lastCompletedAt =
      opts.initialLastCompletedAt ?? Math.floor(Date.now() / 1000);
    // electron-store needs an electron app context to default its cwd.
    // Constructing it here lazily — if Electron isn't available (rare;
    // really only happens when an environment misconfigures), we log
    // and fall through. The store is optional from the queue's POV;
    // gear-coarse still runs without ignore-list persistence.
    this.ignoreList = opts.ignoreList ?? tryCreateIgnoreList();
    this.trinketCache = opts.trinketCache ?? tryCreateTrinketCache();
    this.gearCatalog = opts.gearCatalog ?? tryCreateGearCatalog();
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

    try {
      await this.runScan({
        baseProfile,
        useRealExport,
        parsedExport,
        characterKey,
        scenario: db.active_scenario,
      });
    } catch (err) {
      console.error('[queue] runScan threw — sim attempt aborted:', (err as Error).message);
    } finally {
      // Mark this request as ATTEMPTED — successful or not — so a
      // subsequent /reload (which rewrites SavedVariables but doesn't
      // change update_requested_at) doesn't retrigger the same
      // failing sim every time. Success paths inside runScan also
      // bump lastCompletedAt; this finally block is the safety net
      // for the failure case.
      if (db.update_requested_at > this.lastCompletedAt) {
        this.lastCompletedAt = db.update_requested_at;
      }
    }
  }

  /**
   * On a quick-sim short-circuit (up_to_date or no_upgrades), the
   * addon side still needs to see a fresh results file — otherwise
   * the panel keeps showing the previous sim's timestamps and the
   * fresh-results popup doesn't fire on /reload.
   *
   * Strategy:
   *   1. Read the existing results file (set up at boot by
   *      index.ts → startRoundTrip + every full sim).
   *   2. Bump generated_at to now and mark every scan record as
   *      'done' at the new timestamp so the panel shows everything
   *      as current.
   *   3. Write back atomically.
   *   4. If reading/parsing fails, synthesize a minimal results
   *      record from the gear catalog. Better than leaving stale.
   *
   * Failures are logged but never thrown — the caller has already
   * decided to short-circuit, and a results-file write failure
   * shouldn't crash the queue.
   */
  private async refreshResultsAfterShortCircuit(args: {
    characterKey: string;
    scenario: Scenario;
    finishedAt: number;
    earlyExitKind: 'up_to_date' | 'no_upgrades';
  }): Promise<void> {
    const path = this.opts.paths.resultsLuaPath;
    let next: SimlyResults | undefined;

    if (existsSync(path)) {
      try {
        const source = await readFile(path, 'utf8');
        const parsed = parseResultsFile(source);
        if (parsed) {
          // Backfill composed.gear from the catalog if the parsed
          // file lacks it — pre-Phase-4e files don't have this field,
          // and we don't want users stuck without the gear panel
          // until the next full sim.
          const catalog = this.gearCatalog?.get(args.characterKey, args.scenario);
          const composed: ComposedLoadout | undefined = parsed.composed
            ? {
                ...parsed.composed,
                gear: parsed.composed.gear ?? deriveGearFromCatalog(catalog),
              }
            : catalog
            ? {
                label: 'Cached best loadout',
                expected_dps: catalog.best_loadout_dps,
                gear: deriveGearFromCatalog(catalog),
              }
            : undefined;
          next = {
            ...parsed,
            generated_at: args.finishedAt,
            character_key: args.characterKey,
            active_scenario: args.scenario,
            scans: refreshScanTimestamps(parsed.scans, args.finishedAt),
            composed,
            // Catalog state may have changed since the last full sim
            // (the swap-test path adds entries) — re-derive from the
            // current catalog rather than preserving the stale snapshot.
            catalog_summary: buildCatalogSummary(catalog),
          };
        }
      } catch (err) {
        console.warn('[quick-sim] failed to read existing results file:', (err as Error).message);
      }
    }

    if (!next) {
      // Synthesize from catalog — covers first-run edge cases and
      // unparseable files. Composed loadout is the catalog's
      // best_loadout converted to the addon's shape.
      const catalog = this.gearCatalog?.get(args.characterKey, args.scenario);
      next = synthesizeResultsFromCatalog({
        catalog,
        characterKey: args.characterKey,
        scenario: args.scenario,
        simcVersion: this.opts.simc.installedVersion?.tag ?? 'cached',
        finishedAt: args.finishedAt,
      });
    }

    try {
      await writeLuaFile(
        path,
        'SimlyResults',
        next as unknown as Parameters<typeof writeLuaFile>[2],
      );
      console.log(
        `[quick-sim] wrote refreshed results (${args.earlyExitKind}) — /reload in WoW`,
      );
    } catch (err) {
      console.warn('[quick-sim] failed to write refreshed results:', (err as Error).message);
    }
  }

  /**
   * Run the quick-sim gate. Returns:
   *   - 'up_to_date'   → caller should short-circuit (no further sim).
   *   - 'no_upgrades'  → swap-test ran, no new item is an upgrade,
   *                      caller should short-circuit.
   *   - 'continue'     → caller should run the full pipeline.
   *
   * Catches all errors and falls through to 'continue' so a broken
   * catalog entry never blocks a real sim.
   */
  private async maybeQuickSim(
    args: {
      baseProfile: string;
      useRealExport: boolean;
      parsedExport?: ParsedExport;
      characterKey: string;
      scenario: Scenario;
    },
    runnerPaths: { binPath: string; scratchDir: string },
  ): Promise<'up_to_date' | 'no_upgrades' | 'continue'> {
    if (!args.useRealExport || !args.parsedExport || !this.gearCatalog) {
      return 'continue';
    }
    let catalog: GearCatalogEntry | undefined;
    let decision: QuickSimDecision;
    try {
      catalog = this.gearCatalog.get(args.characterKey, args.scenario);
      decision = planQuickSim({ parsed: args.parsedExport, catalog });
    } catch (err) {
      console.warn('[quick-sim] planner threw — falling through:', (err as Error).message);
      return 'continue';
    }
    console.log(`[quick-sim] decision: ${decision.kind} (${decision.reason})`);

    if (decision.kind === 'up_to_date') {
      // Refresh the catalog's last_quick_sim_at so the user can see
      // when we last verified up-to-date status.
      if (catalog) {
        try {
          this.gearCatalog.put({
            ...catalog,
            last_quick_sim_at: Math.floor(Date.now() / 1000),
          });
        } catch (err) {
          console.warn('[catalog] last_quick_sim_at update failed:', (err as Error).message);
        }
      }
      console.log(
        `[sim] up to date — no new gear, no removals affecting best loadout. ` +
          `Last full sim: ${formatRelative(catalog?.last_full_sim_at ?? 0)}`,
      );
      return 'up_to_date';
    }

    if (decision.kind === 'full_sim') return 'continue';

    // swap_test — sim the new items vs the cached best loadout.
    if (!catalog) return 'continue'; // defensive — planner shouldn't reach swap_test without catalog
    const swapStarted = Math.floor(Date.now() / 1000);
    const swapProgress = makeStageProgressLogger(
      `swap_test (${decision.newItems.length} item${decision.newItems.length === 1 ? '' : 's'})`,
      args.characterKey,
    );
    let result: SwapTestResult;
    try {
      const r = await runSwapTest({
        paths: runnerPaths,
        baseProfile: args.baseProfile,
        bestLoadout: catalog.best_loadout,
        baselineItemBySlot: decision.baselineItemBySlot,
        newItems: decision.newItems,
        onProgress: swapProgress.onProgress,
      });
      swapProgress.stop();
      result = r.result;
    } catch (err) {
      swapProgress.stop();
      console.error(
        `[swap-test] failed — falling through to full sim:`,
        (err as Error).message,
      );
      return 'continue';
    }
    void swapStarted;

    for (const r of result.results) {
      const verdict = r.is_upgrade
        ? 'UPGRADE'
        : r.delta_pct > -0.1
        ? 'sidegrade'
        : r.delta_pct <= -3
        ? 'TRASH'
        : 'good';
      console.log(
        `[swap-test] ${r.item.name} (${r.slot}): ${r.delta_pct >= 0 ? '+' : ''}${r.delta_pct.toFixed(2)}% — ${verdict}`,
      );
    }

    // Update catalog with swap-test outcomes — every swapped item
    // gets a seen_items entry so the next quick-sim won't redo this.
    try {
      const updated = updateCatalogFromSwapTest({
        prior: catalog,
        swap_results: result.results,
      });
      this.gearCatalog.put(updated);
    } catch (err) {
      console.warn('[catalog] swap-test write failed:', (err as Error).message);
    }

    if (!result.any_upgrade) {
      console.log(
        `[sim] no upgrades among ${decision.newItems.length} new item(s); ` +
          `skipping full pipeline (best loadout unchanged)`,
      );
      return 'no_upgrades';
    }

    // Gear upgrade detected → the cascade will re-run the full pipeline.
    // Invalidate the trinket cache so trinket_pre_scan does a fresh
    // sim with the new gear context — previous cached pairs were sim'd
    // against the old gear and their relative rankings may have
    // shifted. Stat weights, gear_coarse, and consumables all
    // re-evaluate naturally; trinkets are the only stage that
    // would otherwise hit a cache.
    if (this.trinketCache) {
      try {
        this.trinketCache.invalidate(args.characterKey, args.scenario);
        console.log(
          `[sim] trinket cache invalidated (gear context changed)`,
        );
      } catch (err) {
        console.warn(
          '[sim] trinket cache invalidate failed:',
          (err as Error).message,
        );
      }
    }

    console.log(
      `[sim] swap test found ${result.results.filter((r) => r.is_upgrade).length} upgrade(s); ` +
        `falling through to full pipeline`,
    );
    return 'continue';
  }

  private async runScan(args: {
    baseProfile: string;
    useRealExport: boolean;
    parsedExport?: ParsedExport;
    characterKey: string;
    scenario: Scenario;
  }): Promise<void> {
    this.inFlight = true;
    setWindowTitle(`Simly — Scan running for ${args.characterKey}…`);
    try {
      const runnerPaths = {
        binPath: this.opts.simc.binPath,
        scratchDir: this.opts.simc.scratchDir,
      };
      const scans: ScanCollection = {};

      // Quick-sim gate. Runs first; can short-circuit to "up to date"
      // (no SimC) or to "swap test only" (just enough SimC to verify
      // a few new items aren't upgrades). Falls through to the full
      // pipeline otherwise. See quick-sim.ts for the planner logic.
      const earlyExit = await this.maybeQuickSim(args, runnerPaths);
      if (earlyExit === 'up_to_date' || earlyExit === 'no_upgrades') {
        const finishedAt = Math.floor(Date.now() / 1000);
        // Refresh the results file so the addon picks up "complete"
        // state on /reload — without this, the addon panel keeps
        // showing the previous sim's stale timestamps and the
        // "fresh results" popup never fires. We re-emit the existing
        // file with bumped generated_at; if the file is missing or
        // unparseable we synthesize a minimal results record from
        // the catalog.
        await this.refreshResultsAfterShortCircuit({
          characterKey: args.characterKey,
          scenario: args.scenario,
          finishedAt,
          earlyExitKind: earlyExit,
        });
        this.lastCompletedAt = finishedAt;
        setWindowTitle(`Simly — Up to date (${args.characterKey})`);
        // Use a synthesized scans summary in the notification so the
        // node-notifier toast says something useful instead of "no
        // scans completed".
        const noteScans: ScanCollection = {
          stat_weights: { status: 'done', finished_at: finishedAt },
          trinket_pre_scan: { status: 'done', finished_at: finishedAt },
          gear_coarse: { status: 'done', finished_at: finishedAt },
        };
        showScanCompleteNotification(noteScans, args.characterKey);
        return;
      }

      // Stage 1: stat weights (only on a real character export — the
      // static fallback profile has no gear/talents and produces
      // garbage weights). Failure is non-fatal; we still run consumables.
      if (args.useRealExport) {
        const swStarted = Math.floor(Date.now() / 1000);
        const swProgress = makeStageProgressLogger('stat_weights', args.characterKey);
        try {
          const sw = await runStatWeightsScan({
            paths: runnerPaths,
            baseProfile: args.baseProfile,
            onProgress: swProgress.onProgress,
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
          swProgress.stop();
        } catch (err) {
          swProgress.stop();
          console.error('[sim] stat_weights run failed:', (err as Error).message);
          scans.stat_weights = {
            status: 'failed',
            started_at: swStarted,
            finished_at: Math.floor(Date.now() / 1000),
            error: (err as Error).message,
          };
        }
      }

      let trinketLock: TrinketLock | undefined;
      // Stage 1.5: trinket pre-scan. Only when we have a real parsed
      // export (need actual bag trinkets) AND at least 2 unique trinkets
      // in the pool. Now cache-aware: pool unchanged ⇒ skip sim entirely
      // (reuse cached winner); new trinket(s) ⇒ sim only the pairs that
      // involve a new trinket, merge with cached pairs.
      if (args.useRealExport && args.parsedExport) {
        const trinkets = getTrinketPool(args.parsedExport);
        if (trinkets.length >= 2) {
          const tStarted = Math.floor(Date.now() / 1000);
          const t0t = Date.now();
          const plan = this.trinketCache
            ? planTrinketScan({
                trinkets,
                cache: this.trinketCache,
                character_key: args.characterKey,
                scenario: args.scenario,
              })
            : { kind: 'full' as const, trinkets, reason: 'no cache available' };

          if (plan.kind === 'reuse') {
            console.log(
              `[sim] trinket_pre_scan: cache hit (pool unchanged) — reusing ${plan.result.pairs.length} cached pairs`,
            );
            const tFinished = Math.floor(Date.now() / 1000);
            scans.trinket_pre_scan = {
              status: 'done',
              started_at: tStarted,
              finished_at: tFinished,
              data: plan.result,
            };
            if (plan.result.winner) {
              const winningPair = plan.result.winner;
              const t1Match = trinkets.find((t) => t.identity === winningPair.trinket1.identity);
              const t2Match = trinkets.find((t) => t.identity === winningPair.trinket2.identity);
              if (t1Match && t2Match) trinketLock = { trinket1: t1Match, trinket2: t2Match };
            }
          } else {
            const tPairs =
              plan.kind === 'incremental'
                ? plan.pairsToSim.length
                : (plan.trinkets.length * (plan.trinkets.length - 1)) / 2;
            const planLabel =
              plan.kind === 'incremental'
                ? `incremental: ${plan.newTrinkets.length} new trinket(s) vs ${plan.cachedTop.length} cached top`
                : `full: ${plan.reason}`;
            console.log(
              `[sim] trinket_pre_scan: ${planLabel} — ${tPairs} pair(s), 3000 iter each`,
            );
            const tProgress = makeStageProgressLogger(
              `trinket_pre_scan (${tPairs} pairs)`,
              args.characterKey,
            );
            try {
              let pairs;
              let pairsByName;
              if (plan.kind === 'incremental') {
                const r = await runTrinketPairsSim({
                  paths: runnerPaths,
                  baseProfile: args.baseProfile,
                  pairs: plan.pairsToSim,
                  onProgress: tProgress.onProgress,
                });
                pairsByName = r.pairsByName;
                const fresh = profilesetsToPairResults(r.run, pairsByName);
                const currentIdentities = new Set(trinkets.map((t) => t.identity));
                pairs = mergePairResults(plan.cached.pairs, fresh, currentIdentities);
              } else {
                const r = await runTrinketPreScanSim({
                  paths: runnerPaths,
                  baseProfile: args.baseProfile,
                  trinkets: plan.trinkets,
                  onProgress: tProgress.onProgress,
                });
                pairsByName = r.pairsByName;
                pairs = parseTrinketPreScanResult(r.run, pairsByName).pairs;
              }
              const data = finalizeTrinketResult(pairs);
              const tFinished = Math.floor(Date.now() / 1000);
              scans.trinket_pre_scan = {
                status: 'done',
                started_at: tStarted,
                finished_at: tFinished,
                data,
              };
              // Lock the winning pair for the gear ladder. ParsedItems
              // (not just ScannedItemRefs) are required so formatItemLine
              // can render the SimC line with bonus_ids etc. For
              // incremental runs the winner may be a cached pair whose
              // ParsedItems aren't in pairsByName — fall back to looking
              // up by identity in the current pool.
              if (data.winner) {
                const w = data.winner;
                const meta = pairsByName.get(w.pair_id);
                if (meta) {
                  trinketLock = { trinket1: meta.t1, trinket2: meta.t2 };
                } else {
                  const t1Match = trinkets.find((t) => t.identity === w.trinket1.identity);
                  const t2Match = trinkets.find((t) => t.identity === w.trinket2.identity);
                  if (t1Match && t2Match) trinketLock = { trinket1: t1Match, trinket2: t2Match };
                }
              }
              // Update cache with the merged result + refreshed top trinkets.
              if (this.trinketCache) {
                try {
                  this.trinketCache.put({
                    character_key: args.characterKey,
                    scenario: args.scenario,
                    pool_signature: poolSignature(trinkets),
                    pairs: data.pairs,
                    top_trinket_identities: selectTopTrinkets(data.pairs),
                    last_simmed_at: tFinished,
                  });
                } catch (err) {
                  console.warn('[sim] trinket cache write failed:', (err as Error).message);
                }
              }
              const dt = ((Date.now() - t0t) / 1000).toFixed(1);
              const winnerStr = data.winner
                ? `${data.winner.trinket1.name} + ${data.winner.trinket2.name} @ ${Math.round(data.winner.mean_dps)} dps`
                : '(no winner)';
              console.log(
                `[sim] trinket_pre_scan (${dt}s, ${data.pairs.length} pair(s) total): ${winnerStr}`,
              );
              tProgress.stop();
            } catch (err) {
              tProgress.stop();
              console.error('[sim] trinket_pre_scan failed:', (err as Error).message);
              scans.trinket_pre_scan = {
                status: 'failed',
                started_at: tStarted,
                finished_at: Math.floor(Date.now() / 1000),
                error: (err as Error).message,
              };
            }
          }
        } else {
          console.log(
            `[sim] trinket_pre_scan: only ${trinkets.length} trinket(s) in pool; skipping`,
          );
        }
      }

      // Stage 1.75: gear ladder coarse stage (1000 iter cartesian).
      // Skips when we have no parsed export (static fallback) or no
      // trinket lock (pre-scan didn't run / failed). Stat weights are
      // forwarded if they ran; the v1 ilvl-based scorer doesn't use
      // them, but a future scorer will.
      if (
        args.useRealExport &&
        args.parsedExport &&
        trinketLock &&
        scans.trinket_pre_scan?.status === 'done'
      ) {
        const gcStarted = Math.floor(Date.now() / 1000);
        const gc0 = Date.now();
        const weights = (scans.stat_weights?.data as StatWeights | undefined) ?? {};
        // Stage label gets updated once the cartesian size is known —
        // makeStageProgressLogger swaps the title in onPlanReady below.
        const gcProgress = makeStageProgressLogger('gear_coarse', args.characterKey);
        try {
          // Pull the catalog's trash list so the pruner can skip
          // items we've already classified as consistently-losing.
          // Empty Set if no catalog yet (first sim) — pruner falls
          // back to its ilvl-multiplier heuristic alone.
          const ignoreSet = ignoredIdentities(
            this.gearCatalog?.get(args.characterKey, args.scenario),
          );
          if (ignoreSet.size > 0) {
            console.log(
              `[sim] gear_coarse: skipping ${ignoreSet.size} catalog-trash item(s) from cartesian`,
            );
          }
          const { result, combosByName: coarseCombos } = await runGearCoarseScan({
            paths: runnerPaths,
            baseProfile: args.baseProfile,
            parsed: args.parsedExport,
            weights,
            trinketLock,
            ignoreSet,
            onProgress: gcProgress.onProgress,
            onPlanReady: (plan) => {
              const slotSummary = Object.entries(plan.perSlotSurvivors)
                .map(([s, n]) => `${s}:${n}`)
                .join(' ');
              console.log(
                `[sim] gear_coarse: starting (${plan.comboCount} combos × 1000 iter, ` +
                  `${plan.ringPairs} ring-pair${plan.ringPairs === 1 ? '' : 's'}; ` +
                  `survivors per slot: ${slotSummary})`,
              );
              gcProgress.setLabel(`gear_coarse (${plan.comboCount} combos)`);
            },
          });
          const gcFinished = Math.floor(Date.now() / 1000);
          const gcRecord: ScanRecord<GearScanResult> = {
            status: 'done',
            started_at: gcStarted,
            finished_at: gcFinished,
            data: result,
          };
          scans.gear_coarse = gcRecord;
          gcProgress.stop();
          const dt = ((Date.now() - gc0) / 1000).toFixed(1);
          const w = result.winner;
          const winnerStr = w
            ? `winner ${w.combo_id} @ ${Math.round(w.mean_dps)} dps (${result.combos.length} combos)`
            : `(no combos)`;
          console.log(`[sim] gear_coarse (${dt}s, 1000 iter): ${winnerStr}`);

          // Write to the gear catalog: best_loadout from the winning
          // combo, seen_items classifications across every combo.
          // This is what the next "Update sims" reads via the
          // quick-sim gate to decide what (if anything) needs simming.
          if (this.gearCatalog && args.parsedExport) {
            try {
              const prior = this.gearCatalog.get(args.characterKey, args.scenario);
              const updated = updateCatalogFromGearScan({
                prior,
                character_key: args.characterKey,
                scenario: args.scenario,
                pool_signature: fullPoolSignature(args.parsedExport),
                combos: result.combos,
              });
              this.gearCatalog.put(updated);
              console.log(
                `[catalog] updated: best loadout dps=${Math.round(updated.best_loadout_dps ?? 0)}, ` +
                  `${Object.keys(updated.seen_items).length} seen item(s)`,
              );
            } catch (err) {
              console.warn('[catalog] write failed:', (err as Error).message);
            }
          }

          // Write losers to the ignore list. 4d-ii is write-only —
          // the pruner doesn't read this yet. 4d-iii wires the read
          // path. Trinkets are excluded inside computeItemObservations.
          if (this.ignoreList) {
            try {
              const observations = computeItemObservations(result.combos);
              this.ignoreList.recordObservations(
                observations.map((o) => ({
                  character_key: args.characterKey,
                  scenario: args.scenario,
                  item_identity: o.item_identity,
                  item_id: o.item_id,
                  name: o.name,
                  slot: o.slot,
                  delta_pct: o.delta_pct,
                })),
              );
            } catch (err) {
              console.warn('[sim] ignore-list write failed:', (err as Error).message);
            }
          }

          // Phase 4d-iii — refined + final stages. Each shrinks the
          // contender set and re-sims at higher iteration count. The
          // catalog gets re-updated after each successful stage so
          // best_loadout converges to the most accurate winner.
          let refinedResult: GearScanResult | undefined;
          let refinedCombos: Map<string, GearCombo> | undefined;
          const refinedSurvivors = selectSurvivors(
            result.combos,
            coarseCombos,
            COARSE_KEEP_THRESHOLD_PCT,
          );
          if (refinedSurvivors.size >= 2) {
            const grStarted = Math.floor(Date.now() / 1000);
            const grProgress = makeStageProgressLogger(
              `gear_refined (${refinedSurvivors.size} combos)`,
              args.characterKey,
            );
            console.log(
              `[sim] gear_refined: starting (${refinedSurvivors.size} combos within ${COARSE_KEEP_THRESHOLD_PCT}% × ${REFINED_ITERATIONS} iter)`,
            );
            try {
              const r = await runGearRerankScan({
                paths: runnerPaths,
                baseProfile: args.baseProfile,
                combos: refinedSurvivors,
                iterations: REFINED_ITERATIONS,
                label: `Gear ladder — refined stage (${REFINED_ITERATIONS} iter)`,
                prefix: 'r',
                scratchTag: `gear-refined-${Date.now()}`,
                onProgress: grProgress.onProgress,
              });
              grProgress.stop();
              refinedResult = r.result;
              refinedCombos = r.combosByName;
              scans.gear_refined = {
                status: 'done',
                started_at: grStarted,
                finished_at: Math.floor(Date.now() / 1000),
                data: r.result,
              };
              const rw = r.result.winner;
              console.log(
                `[sim] gear_refined: winner ${rw?.combo_id} @ ${Math.round(rw?.mean_dps ?? 0)} dps`,
              );

              // Catalog update from refined — tightens deltas for the
              // top items, keeps coarse-stage data for items that
              // didn't survive.
              if (this.gearCatalog && args.parsedExport) {
                try {
                  const prior = this.gearCatalog.get(args.characterKey, args.scenario);
                  const updated = updateCatalogFromGearScan({
                    prior,
                    character_key: args.characterKey,
                    scenario: args.scenario,
                    pool_signature: fullPoolSignature(args.parsedExport),
                    combos: r.result.combos,
                  });
                  this.gearCatalog.put(updated);
                } catch (err) {
                  console.warn('[catalog] refined write failed:', (err as Error).message);
                }
              }
            } catch (err) {
              grProgress.stop();
              console.error('[sim] gear_refined failed:', (err as Error).message);
              scans.gear_refined = {
                status: 'failed',
                started_at: grStarted,
                finished_at: Math.floor(Date.now() / 1000),
                error: (err as Error).message,
              };
            }
          } else {
            console.log(
              `[sim] gear_refined: skipped (${refinedSurvivors.size} survivor${refinedSurvivors.size === 1 ? '' : 's'} within threshold — coarse winner is decisive)`,
            );
          }

          // Final stage — only if refined produced something to refine
          // further. Within REFINED_KEEP_THRESHOLD_PCT of refined
          // winner.
          if (refinedResult && refinedCombos) {
            const finalSurvivors = selectSurvivors(
              refinedResult.combos,
              refinedCombos,
              REFINED_KEEP_THRESHOLD_PCT,
            );
            if (finalSurvivors.size >= 2) {
              const gfStarted = Math.floor(Date.now() / 1000);
              const gfProgress = makeStageProgressLogger(
                `gear_final (${finalSurvivors.size} combos)`,
                args.characterKey,
              );
              console.log(
                `[sim] gear_final: starting (${finalSurvivors.size} combos within ${REFINED_KEEP_THRESHOLD_PCT}% × ${FINAL_ITERATIONS} iter)`,
              );
              try {
                const f = await runGearRerankScan({
                  paths: runnerPaths,
                  baseProfile: args.baseProfile,
                  combos: finalSurvivors,
                  iterations: FINAL_ITERATIONS,
                  label: `Gear ladder — final stage (${FINAL_ITERATIONS} iter)`,
                  prefix: 'f',
                  scratchTag: `gear-final-${Date.now()}`,
                  onProgress: gfProgress.onProgress,
                });
                gfProgress.stop();
                scans.gear_final = {
                  status: 'done',
                  started_at: gfStarted,
                  finished_at: Math.floor(Date.now() / 1000),
                  data: f.result,
                };
                const fw = f.result.winner;
                console.log(
                  `[sim] gear_final: winner ${fw?.combo_id} @ ${Math.round(fw?.mean_dps ?? 0)} dps`,
                );

                // Final catalog update — sets best_loadout from the
                // most accurate stage's winner.
                if (this.gearCatalog && args.parsedExport) {
                  try {
                    const prior = this.gearCatalog.get(args.characterKey, args.scenario);
                    const updated = updateCatalogFromGearScan({
                      prior,
                      character_key: args.characterKey,
                      scenario: args.scenario,
                      pool_signature: fullPoolSignature(args.parsedExport),
                      combos: f.result.combos,
                    });
                    this.gearCatalog.put(updated);
                    console.log(
                      `[catalog] best loadout dps=${Math.round(updated.best_loadout_dps ?? 0)} (final stage)`,
                    );
                  } catch (err) {
                    console.warn('[catalog] final write failed:', (err as Error).message);
                  }
                }
              } catch (err) {
                gfProgress.stop();
                console.error('[sim] gear_final failed:', (err as Error).message);
                scans.gear_final = {
                  status: 'failed',
                  started_at: gfStarted,
                  finished_at: Math.floor(Date.now() / 1000),
                  error: (err as Error).message,
                };
              }
            } else {
              console.log(
                `[sim] gear_final: skipped (${finalSurvivors.size} survivor${finalSurvivors.size === 1 ? '' : 's'} within threshold — refined winner is decisive)`,
              );
            }
          }
        } catch (err) {
          gcProgress.stop();
          console.error('[sim] gear_coarse failed:', (err as Error).message);
          scans.gear_coarse = {
            status: 'failed',
            started_at: gcStarted,
            finished_at: Math.floor(Date.now() / 1000),
            error: (err as Error).message,
          };
        }
      } else if (args.useRealExport && args.parsedExport) {
        const why = !trinketLock
          ? 'no trinket pre-scan winner'
          : 'unknown gating';
        console.log(`[sim] gear_coarse: skipped (${why})`);
      }

      // Stage 2: consumables (flask + food) via profileset sim.
      const startedAt = Math.floor(Date.now() / 1000);
      const t0 = Date.now();
      const consProgress = makeStageProgressLogger('consumables', args.characterKey);
      let run;
      try {
        run = await runSimc({
          paths: runnerPaths,
          profileScript: [args.baseProfile, '', buildAllScanLines()].join('\n'),
          iterations: 1000,
          scratchTag: `consumables-${Date.now()}`,
          onProgress: consProgress.onProgress,
        });
        consProgress.stop();
      } catch (err) {
        consProgress.stop();
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

      const composed = composeFromScans(
        scans,
        this.gearCatalog?.get(args.characterKey, args.scenario),
      );
      const results: SimlyResults = {
        schema_version: RESULTS_SCHEMA_VERSION,
        generated_at: finishedAt,
        simc_version: `${run.simcVersion} (${run.gitRevision.slice(0, 8)})`,
        character_key: args.characterKey,
        active_scenario: args.scenario,
        scans,
        composed,
        catalog_summary: buildCatalogSummary(
          this.gearCatalog?.get(args.characterKey, args.scenario),
        ),
      };

      try {
        await writeLuaFile(
          this.opts.paths.resultsLuaPath,
          'SimlyResults',
          results as unknown as Parameters<typeof writeLuaFile>[2],
        );
        console.log('[sim] wrote SimlyResults.lua — /reload in WoW to see it');
        showScanCompleteNotification(scans, args.characterKey);
      } catch (err) {
        console.error('[sim] failed to write SimlyResults.lua:', err);
      }

      this.lastCompletedAt = finishedAt;
      setWindowTitle(`Simly — Up to date (${args.characterKey})`);
    } finally {
      this.inFlight = false;
    }
  }
}
