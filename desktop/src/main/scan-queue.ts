import {
  RESULTS_SCHEMA_VERSION,
  type ComposedLoadout,
  type GearScanResult,
  type PassHistoryEntry,
  type ScanCollection,
  type ScanRecord,
  type ScenarioResults,
  type Scenario,
  type SimlyDB,
  type SimlyResults,
  type StatWeights,
  type TrinketPreScanResult,
  type RingPreScanResult,
} from '@simly/shared';
import {
  runGearFullSimScan,
  MAX_FULL_SIM_COMBOS,
  FULL_SIM_ITERATIONS,
} from './scans/gear-full-sim';
import { appendFullSimHistory, type FullSimHistoryEntry } from './full-sim-history';
import { hashGearContext, replaceGearInProfile, setConsumablesInProfile } from './profile-builder';
import { pickWinningFlaskSimcKey } from './scans/best-flask';
import { pickWinningFoodSimcKey } from './scans/best-food';
import { pickWinningPotionSimcKey } from './scans/best-potion';
import {
  buildGemsProfilesetLines,
  parseBestGems,
} from './scans/best-gems';
import {
  buildEnchantsProfilesetLines,
  parseBestEnchants,
} from './scans/best-enchants';
import {
  computeHerdMedian,
  computeWeightDeltas,
  formatReconvergeReason,
  shouldTriggerPass2,
} from './scans/reconverge-gate';
import { writeLuaFile } from './lua-writer';
import { parseResultsFile } from './lua-parser';
import { readFile, unlink } from 'node:fs/promises';
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
import {
  finalizeRingResult,
  parseRingPreScanResult,
  profilesetsToPairResults as profilesetsToRingPairResults,
  runRingPairsSim,
  runRingPreScanSim,
} from './scans/ring-pre-scan';
import { runGreedyGearPipeline } from './scans/gear-greedy-pipeline';
import {
  resolveComposedToParsedItems,
  runUpgradePriorityScan,
} from './scans/upgrade-priority';
import { runBestContentScan } from './scans/best-content';
import {
  type TrinketLock,
} from './scans/gear-pruner';
import { TIE_WINDOW_PCT } from './gear-config';
import { computeItemObservations, IgnoreListStore } from './ignore-list';
import {
  mergePairResults,
  planTrinketScan,
  poolSignature,
  selectTopTrinkets,
  TrinketCacheStore,
} from './trinket-cache';
import {
  mergePairResults as mergeRingPairResults,
  planRingScan,
  poolSignature as ringPoolSignature,
  selectTopRings,
  RingCacheStore,
} from './ring-cache';
import {
  buildCatalogSummary,
  buildTalentSignature,
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
  getRingPool,
  getTrinketPool,
  parseSimcExport,
  type ParsedExport,
  type ParsedItem,
} from './simc-export-parser';
import { STATIC_DESTRO_WARLOCK_PROFILE } from './static-profile';
import { scenarioProfileLines, resolveTalentLine, applyTalentOverride } from './scenario-config';
import { buildRaidBuffBlock } from './raid-buffs';
import {
  composeFromScans,
  composeFromConsumableScans,
  deriveGearFromCatalog,
  refreshScanTimestamps,
  synthesizeResultsFromCatalog,
} from './composer';
import type { QueueState } from './ipc';
import { getSettings, type SimlySettings } from './settings';
import {
  formatRelative,
  makeStageProgressLogger,
  setWindowTitle,
  showScanCompleteNotification,
  terminalTitle,
} from './stage-logger';
import {
  tryCreateGearCatalog,
  tryCreateIgnoreList,
  tryCreateRingCache,
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

/**
 * Prepend the scenario's SimC `fight_style=` (and any extras) to a
 * profile script so every downstream stage — stat weights, trinket
 * pre-scan, gear ladder, consumables — runs under the same fight
 * style. SimC treats these as global directives, so they propagate
 * to all profilesets defined later in the script.
 */
function prependScenarioDirectives(
  baseProfile: string,
  scenario: Scenario,
  talentOverride: string | null = null,
): string {
  const profile = applyTalentOverride(baseProfile, talentOverride);
  const lines = [
    ...scenarioProfileLines(scenario),
    '',
    ...buildRaidBuffBlock(),
  ];
  return [...lines, '', profile].join('\n');
}

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
  /** Optional ring cache store. Same pattern. */
  ringCache?: RingCacheStore;
  /** Optional gear catalog store. Same pattern. */
  gearCatalog?: GearCatalogStore;
  /**
   * Called whenever queue state changes (run starts, results written,
   * run finishes). Used by index.ts to push IPC events to the renderer.
   */
  onStateChange?: (state: QueueState) => void;
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
  /**
   * In-memory gate for "Update all sims". Initialized to "now" so a
   * stale update_all_requested_at left in SavedVariables from a prior
   * session doesn't re-fire all 4 scenarios on every desktop start.
   * Same defense as lastCompletedAt — both are gated on a fresh boot.
   */
  private lastCompletedAllAt: number;
  /**
   * Stale-trigger defense for the dev-only "Run Full Sim" button.
   * Initialized to now so an old update_full_sim_requested_at in
   * SavedVariables from a prior session doesn't re-fire on boot.
   */
  private lastCompletedFullSimAt: number;
  /**
   * Set true by maybeRunForSavedVars when the user clicked "Run Full
   * Sim (dev)". Read at the end of runScan to dispatch the full
   * cartesian after the quick pipeline finishes. Cleared in finally.
   */
  private fullSimRequested = false;
  private inFlight = false;
  private readonly ignoreList: IgnoreListStore | undefined;
  private readonly trinketCache: TrinketCacheStore | undefined;
  private readonly ringCache: RingCacheStore | undefined;
  private readonly gearCatalog: GearCatalogStore | undefined;
  /** Latest SimlyResults written to disk; exposed via IPC. */
  latestResults: SimlyResults | null = null;
  private runStartedAt: number | null = null;
  private currentCharacterKey: string | null = null;
  private currentScenario: string | null = null;
  /**
   * Talent-loadout signature for the in-flight scan. Stamped onto
   * every gear-catalog write during the run so subsequent runs can
   * detect a loadout change and invalidate stale catalog data.
   * Reset on scan end via the finally block in runScan.
   */
  private currentTalentSignature: string | null = null;

  /**
   * Inject the in-flight scan's talent signature onto a catalog entry
   * before it's persisted. No-op outside of a scan (signature is null).
   */
  private stampTalentSignature(entry: GearCatalogEntry): GearCatalogEntry {
    if (this.currentTalentSignature === null) return entry;
    return { ...entry, talent_signature: this.currentTalentSignature };
  }

  constructor(private readonly opts: ScanQueueOptions) {
    this.lastCompletedAt =
      opts.initialLastCompletedAt ?? Math.floor(Date.now() / 1000);
    // Same boot-now default as lastCompletedAt — defends against a
    // stale update_all_requested_at in SavedVariables from a previous
    // session re-firing all 4 scenarios on every desktop start.
    this.lastCompletedAllAt = Math.floor(Date.now() / 1000);
    this.lastCompletedFullSimAt = Math.floor(Date.now() / 1000);
    // electron-store needs an electron app context to default its cwd.
    // Constructing it here lazily — if Electron isn't available (rare;
    // really only happens when an environment misconfigures), we log
    // and fall through. The store is optional from the queue's POV;
    // gear-coarse still runs without ignore-list persistence.
    this.ignoreList = opts.ignoreList ?? tryCreateIgnoreList();
    this.trinketCache = opts.trinketCache ?? tryCreateTrinketCache();
    this.ringCache = opts.ringCache ?? tryCreateRingCache();
    this.gearCatalog = opts.gearCatalog ?? tryCreateGearCatalog();
  }

  /** Current queue state snapshot — used by IPC handler on renderer startup. */
  getQueueState(): QueueState {
    return {
      isRunning: this.inFlight,
      characterKey: this.currentCharacterKey,
      scenario: this.currentScenario,
      runStartedAt: this.runStartedAt,
      lastCompletedAt: this.lastCompletedAt,
      results: this.latestResults,
    };
  }

  private emitState(): void {
    this.opts.onStateChange?.(this.getQueueState());
  }

  /**
   * Dev tool: forget every persisted sim cache so the next scan runs
   * the full pipeline from scratch. Wipes the gear catalog, trinket
   * cache, and ignore list (sim-derived; manual_removed overrides are
   * lost), and deletes SimlyResults.lua so the addon stops reading
   * stale results until the next sim regenerates it. Refuses while a
   * scan is in flight — clearing mid-run would corrupt the catalog
   * write at the end of the run.
   *
   * `lastCompletedAt`/`lastCompletedAllAt` are bumped to "now" with the
   * same boot-time defense logic: the addon's last `update_requested_at`
   * in SavedVariables would otherwise re-fire a sim immediately after
   * the clear. The user has to click "Update sims" again to trigger.
   */
  async clearAllCaches(): Promise<{
    inFlight: boolean;
    catalogCleared: boolean;
    trinketCleared: boolean;
    ignoreCleared: boolean;
    resultsLuaDeleted: boolean;
  }> {
    if (this.inFlight) {
      return {
        inFlight: true,
        catalogCleared: false,
        trinketCleared: false,
        ignoreCleared: false,
        resultsLuaDeleted: false,
      };
    }

    let catalogCleared = false;
    let trinketCleared = false;
    let ignoreCleared = false;

    if (this.gearCatalog) {
      try { this.gearCatalog.clear(); catalogCleared = true; }
      catch (err) { console.warn('[clear-cache] gearCatalog.clear threw:', (err as Error).message); }
    }
    if (this.trinketCache) {
      try { this.trinketCache.clear(); trinketCleared = true; }
      catch (err) { console.warn('[clear-cache] trinketCache.clear threw:', (err as Error).message); }
    }
    if (this.ringCache) {
      try { this.ringCache.clear(); }
      catch (err) { console.warn('[clear-cache] ringCache.clear threw:', (err as Error).message); }
    }
    if (this.ignoreList) {
      try { this.ignoreList.clear(); ignoreCleared = true; }
      catch (err) { console.warn('[clear-cache] ignoreList.clear threw:', (err as Error).message); }
    }

    let resultsLuaDeleted = false;
    try {
      await unlink(this.opts.paths.resultsLuaPath);
      resultsLuaDeleted = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[clear-cache] unlink results.lua threw:', (err as Error).message);
      }
    }

    this.latestResults = null;
    const nowSec = Math.floor(Date.now() / 1000);
    this.lastCompletedAt = nowSec;
    this.lastCompletedAllAt = nowSec;
    this.emitState();

    return { inFlight: false, catalogCleared, trinketCleared, ignoreCleared, resultsLuaDeleted };
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

    // Dev-only "Run Full Sim" — runs the normal quick pipeline first,
    // then a Raidbots-Top-Gear-style cartesian for comparison. Highest
    // priority gate (above "update all") because a dev clicking Full
    // Sim explicitly wants this branch even if other flags are stale.
    if (
      db.update_full_sim_requested_at &&
      db.update_full_sim_requested_at > this.lastCompletedFullSimAt
    ) {
      console.log(
        `[queue] full-sim request from addon (update_full_sim_requested_at=${db.update_full_sim_requested_at}); ` +
          `running quick pipeline + full cartesian for ${db.character.name}`,
      );
      this.fullSimRequested = true;
      void this.runForSavedVars(db);
      return;
    }

    // "Update all sims" — run all 4 scenarios back-to-back
    if (
      db.update_all_requested_at &&
      db.update_all_requested_at > this.lastCompletedAllAt
    ) {
      const character = db.character;
      const characterKey = `${character.name}-${character.realm}-${character.region}`;
      const exportTrimmed = (db.simc_export ?? '').trim();
      const useRealExport =
        exportTrimmed.length > 0 && !ADDON_FALLBACK_SENTINELS.has(exportTrimmed);
      const baseProfile = useRealExport ? exportTrimmed : STATIC_DESTRO_WARLOCK_PROFILE;
      let parsedExport: ParsedExport | undefined;
      if (useRealExport) {
        try {
          parsedExport = parseSimcExport(exportTrimmed);
        } catch (err) {
          console.warn('[queue] failed to parse SimC export for runAllScenarios:', (err as Error).message);
        }
      }
      void this.runAllScenarios({
        useRealExport,
        parsedExport: parsedExport ?? null,
        baseProfile,
        characterKey,
        talentSelection: db.talent_loadout_per_scenario ?? {},
      });
      return;
    }

    if (db.update_requested_at <= this.lastCompletedAt) {
      console.log(
        `[queue] no new request (update_requested_at=${db.update_requested_at} <= last_completed=${this.lastCompletedAt}); idle`,
      );
      return;
    }
    // Slice F: log the sim-type the addon requested. Today the desktop
    // runs the full pipeline regardless; selective execution per
    // sim-type is the F2 follow-up. Surfacing the field now means logs
    // capture user intent for triage even before behavior diverges.
    const simType = db.requested_sim_type ?? 'all';
    console.log(
      `[queue] new request from addon (update_requested_at=${db.update_requested_at}, sim_type=${simType}); running for ${db.character.name}`,
    );
    void this.runForSavedVars(db);
  }

  private async runAllScenarios(args: {
    useRealExport: boolean;
    parsedExport: ParsedExport | null;
    baseProfile: string;
    characterKey: string;
    talentSelection?: Partial<Record<string, string>>;
  }): Promise<void> {
    const scenarios: Scenario[] = ['single_target_patchwerk', 'm_plus', 'aoe_cleave', 'aoe_funnel'];
    for (const scenario of scenarios) {
      const talents = resolveTalentLine(scenario, args.parsedExport ?? undefined, args.talentSelection);
      await this.runScan({
        ...args,
        parsedExport: args.parsedExport ?? undefined,
        baseProfile: prependScenarioDirectives(args.baseProfile, scenario, talents),
        scenario,
      });
    }
    const finishedAt = Math.floor(Date.now() / 1000);
    this.lastCompletedAllAt = finishedAt;
    // Also advance lastCompletedAt: RequestUpdateAll() in the addon
    // sets BOTH update_requested_at AND update_all_requested_at, so a
    // followup "Update sims" click would otherwise see the stale
    // update_requested_at (still > lastCompletedAt) and replay a
    // single-scenario scan unprompted.
    this.lastCompletedAt = finishedAt;
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
      baseProfile: prependScenarioDirectives(source.profileScript, source.scenario),
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

    const talentOverride = resolveTalentLine(
      db.active_scenario,
      parsedExport,
      db.talent_loadout_per_scenario ?? {},
    );
    try {
      await this.runScan({
        baseProfile: prependScenarioDirectives(baseProfile, db.active_scenario, talentOverride),
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

    // Load existing results to preserve other scenarios' data
    let existingScenarios: Partial<Record<Scenario, ScenarioResults>> = {};
    let existingResult: SimlyResults | undefined;

    if (existsSync(path)) {
      try {
        const source = await readFile(path, 'utf8');
        const parsed = parseResultsFile(source);
        if (parsed) {
          existingResult = parsed;
          if (parsed.scenarios) {
            existingScenarios = parsed.scenarios as Partial<Record<Scenario, ScenarioResults>>;
          } else if (parsed.scans) {
            // Migrate v2 flat structure
            existingScenarios[parsed.active_scenario as Scenario] = {
              generated_at: parsed.generated_at ?? 0,
              simc_version: parsed.simc_version ?? '',
              scans: parsed.scans,
              composed: parsed.composed,
              catalog_summary: parsed.catalog_summary,
            };
          }
        }
      } catch (err) {
        console.warn('[quick-sim] failed to read existing results file:', (err as Error).message);
      }
    }

    // Build refreshed scenario bucket for the current scenario
    const catalog = this.gearCatalog?.get(args.characterKey, args.scenario);
    let scenarioResult: ScenarioResults;

    const priorScenarioBucket = existingScenarios[args.scenario];
    if (priorScenarioBucket) {
      // Re-run composeFromScans so any composer logic that integrates
      // multiple scan results (e.g. merging the trinket pre-scan winner
      // into composed.gear) fires on refresh too — not just on a full
      // re-sim. Before this fix, the quick-sim path just preserved the
      // prior composed verbatim, silently skipping any new composer
      // behavior introduced after the original full sim.
      // Falls back to the prior composed (with catalog backfill) when
      // composeFromScans returns undefined — i.e. no scans recorded.
      const recomposed = composeFromScans(priorScenarioBucket.scans, catalog);
      const composed: ComposedLoadout | undefined = recomposed
        ?? (priorScenarioBucket.composed
          ? {
              ...priorScenarioBucket.composed,
              gear: priorScenarioBucket.composed.gear ?? deriveGearFromCatalog(catalog),
            }
          : catalog
          ? {
              label: 'Cached best loadout',
              expected_dps: catalog.best_loadout_dps,
              gear: deriveGearFromCatalog(catalog),
            }
          : undefined);
      scenarioResult = {
        ...priorScenarioBucket,
        generated_at: args.finishedAt,
        scans: refreshScanTimestamps(priorScenarioBucket.scans, args.finishedAt),
        composed,
        // Catalog state may have changed since the last full sim
        // (the swap-test path adds entries) — re-derive from the
        // current catalog rather than preserving the stale snapshot.
        catalog_summary: buildCatalogSummary(catalog),
      };
    } else {
      // Synthesize from catalog — covers first-run edge cases and
      // unparseable files. Composed loadout is the catalog's
      // best_loadout converted to the addon's shape.
      const synthesized = synthesizeResultsFromCatalog({
        catalog,
        characterKey: args.characterKey,
        scenario: args.scenario,
        simcVersion: this.opts.simc.installedVersion?.tag ?? 'cached',
        finishedAt: args.finishedAt,
      });
      // synthesizeResultsFromCatalog returns a flat v2-style SimlyResults;
      // extract the fields we need for a ScenarioResults bucket.
      scenarioResult = {
        generated_at: synthesized.generated_at ?? args.finishedAt,
        simc_version: synthesized.simc_version ?? 'cached',
        scans: synthesized.scans ?? {},
        composed: synthesized.composed,
        catalog_summary: synthesized.catalog_summary,
      };
    }

    const next: SimlyResults = {
      schema_version: RESULTS_SCHEMA_VERSION,
      character_key: args.characterKey,
      active_scenario: args.scenario,
      scenarios: {
        ...existingScenarios,
        [args.scenario]: scenarioResult,
      },
    };

    // Preserve gear_hash from existing top-level if available
    if (existingResult?.gear_hash) {
      next.gear_hash = existingResult.gear_hash;
    }

    try {
      await writeLuaFile(
        path,
        'SimlyResults',
        next as unknown as Parameters<typeof writeLuaFile>[2],
      );
      this.latestResults = next;
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
    settings: SimlySettings,
  ): Promise<'up_to_date' | 'no_upgrades' | 'continue'> {
    if (!args.useRealExport || !args.parsedExport || !this.gearCatalog) {
      return 'continue';
    }
    let catalog: GearCatalogEntry | undefined;
    let decision: QuickSimDecision;
    try {
      catalog = this.gearCatalog.get(args.characterKey, args.scenario);
      // Invalidate the catalog when the talent loadout for this
      // scenario has changed since the last sim. Stale entries would
      // mis-classify items because DPS-per-item depends on talents.
      // Pre-talents entries (no talent_signature stamped) also fall
      // through — they get re-stamped on the next full sim.
      if (
        catalog &&
        this.currentTalentSignature !== null &&
        catalog.talent_signature !== this.currentTalentSignature
      ) {
        console.log(
          `[quick-sim] talent change detected (was=${catalog.talent_signature ?? 'unstamped'}, now=${this.currentTalentSignature}); dropping catalog entry for ${args.characterKey}|${args.scenario}`,
        );
        this.gearCatalog.drop(args.characterKey, args.scenario);
        catalog = undefined;
        // Cached trinket/ring pairs were sim'd under the prior talents
        // and rank differently now — clear those too.
        try { this.trinketCache?.invalidate(args.characterKey, args.scenario); } catch { /* non-fatal */ }
        try { this.ringCache?.invalidate(args.characterKey, args.scenario); } catch { /* non-fatal */ }
      }
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
          this.gearCatalog.put(this.stampTalentSignature({
            ...catalog,
            last_quick_sim_at: Math.floor(Date.now() / 1000),
          }));
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
        iterations: settings.swapTestIterations,
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
      this.gearCatalog.put(this.stampTalentSignature(updated));
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
    // Same rationale for the ring cache — cached ring pairs were sim'd
    // against the old gear context and their rankings may have shifted.
    if (this.ringCache) {
      try {
        this.ringCache.invalidate(args.characterKey, args.scenario);
        console.log(`[sim] ring cache invalidated (gear context changed)`);
      } catch (err) {
        console.warn(
          '[sim] ring cache invalidate failed:',
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
    talentSelection?: Partial<Record<string, string>>;
  }): Promise<void> {
    const s = getSettings();
    this.inFlight = true;
    this.runStartedAt = Math.floor(Date.now() / 1000);
    this.currentCharacterKey = args.characterKey;
    this.currentScenario = args.scenario;
    // Compute the talent signature for this scan up-front so it can
    // (a) invalidate stale catalog entries in maybeQuickSim, and
    // (b) stamp every catalog/cache write during the run.
    const resolvedTalents = resolveTalentLine(
      args.scenario,
      args.parsedExport,
      args.talentSelection,
    );
    const loadoutName = args.talentSelection?.[args.scenario];
    this.currentTalentSignature = buildTalentSignature(
      resolvedTalents,
      args.parsedExport?.equipped_talents ?? null,
      loadoutName && loadoutName !== 'equipped' ? loadoutName : undefined,
    );
    this.emitState();
    setWindowTitle(`Simly — Scan running for ${args.characterKey}…`);
    let scanOutcome: 'ok' | 'failed' = 'failed';
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
      const earlyExit = await this.maybeQuickSim(args, runnerPaths, s);
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
        scanOutcome = 'ok';
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

      // ─── STAGE 1.25: CONSUMABLES PRESCAN ───
      //
      // Pick the winning flask + food against the BASELINE actor, lock
      // them into the profile, then run trinket pre-scan / gear search
      // with the lock in place. Mirrors how trinkets are handled (held
      // constant during gear search). Without this, gear search runs
      // flask-off / food-off and the (gear, consumable) interaction is
      // invisible — pass-1 may pick gear that's optimal against a no-
      // consumables actor but suboptimal once consumables are added.
      //
      // The corresponding post-gear consumables re-eval (further below,
      // run against the converged actor) produces v2 winners; if they
      // differ from v1 the reconverge-gate's `consumables` trigger fires
      // and pass 2 re-runs gear with the new lock.
      // Captured by whichever consumables sim runs last (prescan / re-eval
      // / fallback) so the scenario record's `simc_version` and
      // `finished_at` come from a real SimC run regardless of which path
      // was taken. Always non-undefined by the time we compose results
      // unless every consumables sim attempt failed (in which case we
      // bail earlier).
      let consumablesRun: import('./simc-runner').SimcRunResult | undefined;

      let consumablesLock: { flask?: string; food?: string; potion?: string } = {};
      let lockedBaseProfile = args.baseProfile;
      if (args.useRealExport) {
        const cpStarted = Math.floor(Date.now() / 1000);
        const cp0 = Date.now();
        const cpProgress = makeStageProgressLogger(
          'consumables (prescan)',
          args.characterKey,
        );
        // Gem + enchant profilesets need the parsed export to know
        // per-item context (socket counts, slot occupancy). Built
        // inline rather than via the SCANS registry (whose buildLines
        // is parameterless). Falls back to empty when parsedExport is
        // absent (static fallback profile path).
        const gemsBlock = args.parsedExport
          ? buildGemsProfilesetLines(args.parsedExport)
          : '';
        const enchantsBlock = args.parsedExport
          ? buildEnchantsProfilesetLines(args.parsedExport)
          : '';
        try {
          const cpRun = await runSimc({
            paths: runnerPaths,
            profileScript: [
              args.baseProfile,
              '',
              buildAllScanLines(),
              gemsBlock,
              enchantsBlock,
            ].filter((s) => s.length > 0).join('\n'),
            iterations: 3000,
            scratchTag: `consumables-prescan-${Date.now()}`,
            onProgress: cpProgress.onProgress,
          });
          cpProgress.stop();
          consumablesRun = cpRun;
          const flaskKey = pickWinningFlaskSimcKey(cpRun);
          const foodKey = pickWinningFoodSimcKey(cpRun);
          const potionKey = pickWinningPotionSimcKey(cpRun);
          const gemsResult = parseBestGems(cpRun);
          const enchantsResult = parseBestEnchants(cpRun);
          consumablesLock = { flask: flaskKey, food: foodKey, potion: potionKey };
          const cpFinished = Math.floor(Date.now() / 1000);
          // Surface gem winner in the scans collection so the composer
          // can merge it into composed.gems. Gems aren't part of the
          // consumables lock (they're item-level, not profile-level);
          // composer reads scans.best_gems directly.
          if (gemsResult) {
            scans.best_gems = {
              status: 'done',
              started_at: cpStarted,
              finished_at: cpFinished,
              data: gemsResult,
            };
            console.log(
              `[sim] best gem stat: ${gemsResult.best.name} (${gemsResult.best.dps} dps)`,
            );
          }
          if (enchantsResult) {
            scans.best_enchants = {
              status: 'done',
              started_at: cpStarted,
              finished_at: cpFinished,
              data: enchantsResult,
            };
            const slotPicks = Object.entries(enchantsResult.per_slot)
              .map(([slot, r]) => `${slot}=${r.best.name}`)
              .join(', ');
            console.log(`[sim] best enchants: ${slotPicks}`);
          }
          lockedBaseProfile = setConsumablesInProfile(
            args.baseProfile,
            consumablesLock,
          );
          // Surface prescan winners in scans collection so the addon
          // panel and renderer Scans tab see them. The post-gear re-eval
          // overwrites these with converged-actor winners; that's the
          // intentional final answer for the composer.
          const cpScans = parseAllScanRecords(cpRun, cpStarted, Math.floor(Date.now() / 1000));
          Object.assign(scans, cpScans);
          const cpDt = ((Date.now() - cp0) / 1000).toFixed(1);
          console.log(
            `[sim] consumables (prescan, ${cpDt}s): flask=${flaskKey ?? '(none)'}, food=${foodKey ?? '(none)'}, potion=${potionKey ?? '(none)'}`,
          );
        } catch (err) {
          cpProgress.stop();
          console.error(
            '[sim] consumables prescan failed:',
            (err as Error).message,
          );
          // Fall through with no lock — gear search will run flask-off.
        }
      }

      let trinketLock: TrinketLock | undefined;
      // Captured by the gear-pipeline block when greedy ran successfully
      // and made it through with real sims. Used by the end-of-pass-1
      // reconverge-gate diagnostic below to build the converged-actor
      // baseProfile for the stat-weights re-run. Undefined when gear
      // search didn't run or produced zero combos.
      let pass1Gear: Record<string, ParsedItem> | undefined;

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
                  baseProfile: lockedBaseProfile,
                  pairs: plan.pairsToSim,
                  iterations: s.trinketIterations,
                  onProgress: tProgress.onProgress,
                });
                pairsByName = r.pairsByName;
                const fresh = profilesetsToPairResults(r.run, pairsByName);
                const currentIdentities = new Set(trinkets.map((t) => t.identity));
                pairs = mergePairResults(plan.cached.pairs, fresh, currentIdentities);
              } else {
                const r = await runTrinketPreScanSim({
                  paths: runnerPaths,
                  baseProfile: lockedBaseProfile,
                  trinkets: plan.trinkets,
                  iterations: s.trinketIterations,
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
                    top_trinket_identities: selectTopTrinkets(data.pairs, s.topTrinketsToKeep),
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

      // Stage 1.6: ring pre-scan. Mirrors the trinket stage above —
      // rings live outside GEAR_LADDER_SLOTS (the greedy pipeline doesn't
      // enumerate them) so the addon paper-doll's finger1/finger2 are
      // empty unless we sim them here. Same cache-aware planner: pool
      // unchanged ⇒ reuse; new ring(s) ⇒ incremental; otherwise full.
      // Slice B scope: result is merged into composed.gear by the
      // composer; the gear ladder is not constrained by a ringLock yet
      // (rings aren't in GEAR_LADDER_SLOTS, so no constraint needed).
      if (args.useRealExport && args.parsedExport) {
        const rings = getRingPool(args.parsedExport);
        if (rings.length >= 2) {
          const rStarted = Math.floor(Date.now() / 1000);
          const r0 = Date.now();
          const plan = this.ringCache
            ? planRingScan({
                rings,
                cache: this.ringCache,
                character_key: args.characterKey,
                scenario: args.scenario,
              })
            : { kind: 'full' as const, rings, reason: 'no cache available' };

          if (plan.kind === 'reuse') {
            console.log(
              `[sim] ring_pre_scan: cache hit (pool unchanged) — reusing ${plan.result.pairs.length} cached pairs`,
            );
            const rFinished = Math.floor(Date.now() / 1000);
            scans.ring_pre_scan = {
              status: 'done',
              started_at: rStarted,
              finished_at: rFinished,
              data: plan.result,
            };
          } else {
            const rPairs =
              plan.kind === 'incremental'
                ? plan.pairsToSim.length
                : (plan.rings.length * (plan.rings.length - 1)) / 2;
            const planLabel =
              plan.kind === 'incremental'
                ? `incremental: ${plan.newRings.length} new ring(s) vs ${plan.cachedTop.length} cached top`
                : `full: ${plan.reason}`;
            console.log(
              `[sim] ring_pre_scan: ${planLabel} — ${rPairs} pair(s), ${s.ringIterations} iter each`,
            );
            const rProgress = makeStageProgressLogger(
              `ring_pre_scan (${rPairs} pairs)`,
              args.characterKey,
            );
            try {
              let pairs;
              if (plan.kind === 'incremental') {
                const r = await runRingPairsSim({
                  paths: runnerPaths,
                  baseProfile: lockedBaseProfile,
                  pairs: plan.pairsToSim,
                  iterations: s.ringIterations,
                  onProgress: rProgress.onProgress,
                });
                const fresh = profilesetsToRingPairResults(r.run, r.pairsByName);
                const currentIdentities = new Set(rings.map((rg) => rg.identity));
                pairs = mergeRingPairResults(plan.cached.pairs, fresh, currentIdentities);
              } else {
                const r = await runRingPreScanSim({
                  paths: runnerPaths,
                  baseProfile: lockedBaseProfile,
                  rings: plan.rings,
                  iterations: s.ringIterations,
                  onProgress: rProgress.onProgress,
                });
                pairs = parseRingPreScanResult(r.run, r.pairsByName).pairs;
              }
              const data = finalizeRingResult(pairs);
              const rFinished = Math.floor(Date.now() / 1000);
              scans.ring_pre_scan = {
                status: 'done',
                started_at: rStarted,
                finished_at: rFinished,
                data,
              };
              if (this.ringCache) {
                try {
                  this.ringCache.put({
                    character_key: args.characterKey,
                    scenario: args.scenario,
                    pool_signature: ringPoolSignature(rings),
                    pairs: data.pairs,
                    top_ring_identities: selectTopRings(data.pairs, s.topRingsToKeep),
                    last_simmed_at: rFinished,
                  });
                } catch (err) {
                  console.warn('[sim] ring cache write failed:', (err as Error).message);
                }
              }
              const dt = ((Date.now() - r0) / 1000).toFixed(1);
              const winnerStr = data.winner
                ? `${data.winner.finger1.name} + ${data.winner.finger2.name} @ ${Math.round(data.winner.mean_dps)} dps`
                : '(no winner)';
              console.log(
                `[sim] ring_pre_scan (${dt}s, ${data.pairs.length} pair(s) total): ${winnerStr}`,
              );
              rProgress.stop();
            } catch (err) {
              rProgress.stop();
              console.error('[sim] ring_pre_scan failed:', (err as Error).message);
              scans.ring_pre_scan = {
                status: 'failed',
                started_at: rStarted,
                finished_at: Math.floor(Date.now() / 1000),
                error: (err as Error).message,
              };
            }
          }
        } else {
          console.log(
            `[sim] ring_pre_scan: only ${rings.length} ring(s) in pool; skipping`,
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
          // Greedy pipeline: replaces the gear_coarse → gear_refined →
          // gear_final cascade. Walks each bag item against the current
          // best, folds upgrades in one at a time until convergence,
          // then runs an exhaustive 2-and-3 cartesian over remaining
          // rejects to catch breakpoint synergies. See gear-greedy-pipeline.ts.
          const catalogForPruner = this.gearCatalog?.get(args.characterKey, args.scenario);
          const baselineDps = catalogForPruner?.best_loadout_dps ?? 100_000; // first-run default

          const greedyResult = await runGreedyGearPipeline({
            paths: runnerPaths,
            baseProfile: lockedBaseProfile,
            parsed: args.parsedExport,
            weights: weights as StatWeights,
            trinketLock,
            catalog: catalogForPruner,
            bestLoadoutDps: baselineDps,
            greedyIterations: s.coarseIterations,
            breakpointIterations: s.refinedIterations,
            tieWindowPct: TIE_WINDOW_PCT,
            onProgress: gcProgress.onProgress,
          });
          const result = greedyResult.result;
          gcProgress.stop();
          const dt = ((Date.now() - gc0) / 1000).toFixed(1);
          const w = result.winner;
          const winnerStr = w
            ? `winner ${w.combo_id} @ ${Math.round(w.mean_dps)} dps (${greedyResult.greedyIterations} greedy iter, ${greedyResult.breakpointCombos} breakpoint combos)`
            : `(no combos)`;
          console.log(`[sim] greedy gear search (${dt}s): ${winnerStr}`);

          // Skip catalog + scans.gear_final writes when greedy ran zero
          // sims (no bag candidates after the trash filter). The
          // synthetic winner has dps=0 in that case and writing it
          // would corrupt the catalog's best_loadout_dps baseline.
          const greedyRanSims = greedyResult.finalDps > 0;
          if (!greedyRanSims) {
            console.log(`[sim] greedy: no bag candidates — skipping catalog update`);
          } else {
            // Capture the converged loadout for the end-of-pass-1
            // diagnostic (stat-weights re-run against the new actor).
            pass1Gear = greedyResult.finalLoadout;
          }

          // Write to scans.gear_final so the composer (gear_final >
          // gear_refined > gear_coarse) picks up the new pipeline's
          // result without changes.
          if (greedyRanSims) {
            scans.gear_final = {
              status: 'done',
              started_at: gcStarted,
              finished_at: Math.floor(Date.now() / 1000),
              data: result,
            };
          }

          // Update catalog from synthetic combos (winner + greedy-iter-1
          // rejects). The winner sets best_loadout; rejects populate
          // seen_items so the next run's bank-and-add-back workflow
          // skips items already classified.
          if (greedyRanSims && this.gearCatalog && args.parsedExport) {
            try {
              const prior = this.gearCatalog.get(args.characterKey, args.scenario);
              const updated = updateCatalogFromGearScan({
                prior,
                character_key: args.characterKey,
                scenario: args.scenario,
                pool_signature: fullPoolSignature(args.parsedExport),
                combos: result.combos,
                parsedExport: args.parsedExport,
              });
              this.gearCatalog.put(this.stampTalentSignature(updated));
              console.log(
                `[catalog] updated: best loadout dps=${Math.round(updated.best_loadout_dps ?? 0)}, ` +
                  `${Object.keys(updated.seen_items).length} seen item(s)`,
              );
            } catch (err) {
              console.warn('[catalog] write failed:', (err as Error).message);
            }
          }

          // Ignore-list observations from greedy-iter-1 rejects.
          if (greedyRanSims && this.ignoreList) {
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

      // ─── END OF PASS 1: STAT-WEIGHTS RE-RUN + RECONVERGE GATE ───
      //
      // After greedy + breakpoint converge, re-run stat-weights against
      // the converged actor. If the marginal value of any secondary
      // stat shifted past WEIGHT_SHIFT_THRESHOLD (25%) between baseline
      // (weights_v1) and converged (weights_v2), the actor crossed a
      // structural threshold (classic case: GCD floor) and pass-1's
      // search was guided by stale weights.
      //
      // Slice 2a: diagnostic only — log the comparison and what would
      // trigger pass 2. Slice 2b will dispatch the actual re-run.
      const passHistory: PassHistoryEntry[] = [];
      const weightsV1 = scans.stat_weights?.data as StatWeights | undefined;
      if (
        args.useRealExport &&
        pass1Gear !== undefined &&
        weightsV1 !== undefined &&
        scans.stat_weights?.status === 'done'
      ) {
        // Build convergedProfile from the lockedBaseProfile so the pass-1
        // consumables lock carries through into the stat-weights re-run
        // and the post-gear consumables re-eval. The re-eval may then
        // overwrite flask/food when it picks new winners — that's exactly
        // the signal the reconverge-gate's `consumables` trigger looks for.
        const convergedProfile = replaceGearInProfile(lockedBaseProfile, pass1Gear);
        const gearContextHash = hashGearContext(pass1Gear);
        let weightsV2: StatWeights | undefined;
        const swReStarted = Math.floor(Date.now() / 1000);
        const swReProgress = makeStageProgressLogger(
          'stat_weights (post-pass-1)',
          args.characterKey,
        );
        try {
          const sw2 = await runStatWeightsScan({
            paths: runnerPaths,
            baseProfile: convergedProfile,
            onProgress: swReProgress.onProgress,
          });
          weightsV2 = sw2.weights;
          swReProgress.stop();
          const summary = Object.entries(weightsV2)
            .map(([k, v]) => `${k}=${v?.toFixed(2)}`)
            .join(' ');
          console.log(
            `[sim] stat_weights (post-pass-1 re-run, ${(sw2.durationMs / 1000).toFixed(1)}s): ${summary}`,
          );
        } catch (err) {
          swReProgress.stop();
          console.error(
            '[sim] post-pass-1 stat_weights re-run failed:',
            (err as Error).message,
          );
        }

        // ─── POST-GEAR CONSUMABLES RE-EVAL ───
        //
        // Runs against the converged actor so flask/food are scored under
        // the same gear context pass-1 converged on. Compared to the
        // baseline prescan winners; if they differ, the reconverge-gate's
        // `consumables` trigger fires below.
        //
        // Writes back into scans.best_flask / scans.best_food so the
        // composer surfaces the converged-actor winners as the final
        // answer (replacing the prescan records).
        let flaskV2Key: string | undefined;
        let foodV2Key: string | undefined;
        let potionV2Key: string | undefined;
        const reStarted = Math.floor(Date.now() / 1000);
        const re0 = Date.now();
        const reProgress = makeStageProgressLogger(
          'consumables (post-pass-1 re-eval)',
          args.characterKey,
        );
        try {
          const reRun = await runSimc({
            paths: runnerPaths,
            profileScript: [convergedProfile, '', buildAllScanLines()].join('\n'),
            iterations: 1000,
            scratchTag: `consumables-reeval-${Date.now()}`,
            onProgress: reProgress.onProgress,
          });
          reProgress.stop();
          consumablesRun = reRun;
          flaskV2Key = pickWinningFlaskSimcKey(reRun);
          foodV2Key = pickWinningFoodSimcKey(reRun);
          potionV2Key = pickWinningPotionSimcKey(reRun);
          const reFinished = Math.floor(Date.now() / 1000);
          const reScans = parseAllScanRecords(reRun, reStarted, reFinished);
          Object.assign(scans, reScans);
          const reDt = ((Date.now() - re0) / 1000).toFixed(1);
          console.log(
            `[sim] consumables (post-pass-1 re-eval, ${reDt}s): flask=${flaskV2Key ?? '(none)'}, food=${foodV2Key ?? '(none)'}, potion=${potionV2Key ?? '(none)'}`,
          );
        } catch (err) {
          reProgress.stop();
          console.error(
            '[sim] post-pass-1 consumables re-eval failed:',
            (err as Error).message,
          );
        }

        const gate = shouldTriggerPass2({
          weights_v1: weightsV1,
          weights_v2: weightsV2,
          flask_v1_item_id: consumablesLock.flask,
          flask_v2_item_id: flaskV2Key,
          food_v1_item_id: consumablesLock.food,
          food_v2_item_id: foodV2Key,
          potion_v1_item_id: consumablesLock.potion,
          potion_v2_item_id: potionV2Key,
        });
        // Debug override: `SIMLY_FORCE_PASS2=1 npm run dev` forces the
        // dispatch path regardless of gate verdict. Useful for live-
        // verifying the dispatch on characters whose gear converges
        // stably (Felfriend-style) without resorting to threshold-
        // mangling. Surfaces in the log so it's never silent.
        if (process.env.SIMLY_FORCE_PASS2 === '1' && !gate.shouldTrigger) {
          console.log(
            `[gear] SIMLY_FORCE_PASS2=1 — forcing pass-2 despite stable gate verdict (debug only)`,
          );
          gate.shouldTrigger = true;
          gate.reasons = [
            {
              kind: 'weights',
              stat: 'haste',
              v1: 1,
              v2: 1,
              ratio: 1,
              herd_median: 1,
              relative_ratio: 1,
            },
          ];
        }

        // Always compute weight_deltas — surfaces what shifted even
        // when no trigger fires. Useful for tuning thresholds and for
        // the user to see "your gear didn't move haste much" at a
        // glance. Also log the herd median so the user can see the
        // baseline the trigger compares against — uniform shifts
        // (median far from 1.0) are the cases the herd-relative gate
        // is designed to suppress.
        const weightDeltas =
          weightsV2 !== undefined ? computeWeightDeltas(weightsV1, weightsV2) : undefined;
        if (weightDeltas && weightsV2 !== undefined) {
          const deltaStr = Object.entries(weightDeltas)
            .map(([stat, ratio]) => {
              const pct = (ratio - 1) * 100;
              const sign = pct >= 0 ? '+' : '';
              return `${stat}=${sign}${pct.toFixed(1)}%`;
            })
            .join(' ');
          const herdMedian = computeHerdMedian(weightsV1, weightsV2);
          const herdPct = (herdMedian - 1) * 100;
          const herdSign = herdPct >= 0 ? '+' : '';
          console.log(
            `[gear] weight_deltas (post-pass-1 vs baseline): ${deltaStr} ` +
              `(herd median ${herdSign}${herdPct.toFixed(1)}%)`,
          );
        }

        let pass2RanAndWon = false;
        if (gate.shouldTrigger && weightsV2 !== undefined && args.parsedExport) {
          console.log(
            `[gear] PASS 2 triggered: ${gate.reasons.map(formatReconvergeReason).join(' | ')}`,
          );

          // Re-lock consumables for pass 2 using the post-gear winners
          // (falling back to v1 lock when the re-eval didn't run). This
          // matters specifically when the `consumables` trigger fired:
          // pass-1's gear was searched under the v1 lock, so pass-2
          // should search under the v2 lock to actually exploit the
          // (gear, consumable) interaction. When weights flipped but
          // consumables didn't, v1 and v2 keys match and this is a no-op.
          const pass2Consumables = {
            flask: flaskV2Key ?? consumablesLock.flask,
            food: foodV2Key ?? consumablesLock.food,
            potion: potionV2Key ?? consumablesLock.potion,
          };
          const pass2BaseProfile = setConsumablesInProfile(
            args.baseProfile,
            pass2Consumables,
          );
          const pass2ConvergedProfile = replaceGearInProfile(
            pass2BaseProfile,
            pass1Gear,
          );

          // P2.1: trinket re-prescan against the converged actor.
          // We always do a full pool sim (3000 iter) — the gear context
          // is new, so cache wouldn't hit anyway, and the marginal cost
          // of caching pass-2 results is small.
          let p2TrinketLock: TrinketLock | undefined;
          const trinkets = getTrinketPool(args.parsedExport);
          if (trinkets.length >= 2) {
            const tp2Started = Math.floor(Date.now() / 1000);
            const tp2T0 = Date.now();
            const tp2Progress = makeStageProgressLogger(
              'trinket_pre_scan (pass 2)',
              args.characterKey,
            );
            try {
              const r = await runTrinketPreScanSim({
                paths: runnerPaths,
                baseProfile: pass2ConvergedProfile,
                trinkets,
                iterations: s.trinketIterations,
                onProgress: tp2Progress.onProgress,
              });
              const pairs = parseTrinketPreScanResult(r.run, r.pairsByName).pairs;
              const data = finalizeTrinketResult(pairs);
              const tp2Finished = Math.floor(Date.now() / 1000);
              tp2Progress.stop();
              const tp2dt = ((Date.now() - tp2T0) / 1000).toFixed(1);
              const winnerStr = data.winner
                ? `${data.winner.trinket1.name} + ${data.winner.trinket2.name} @ ${Math.round(data.winner.mean_dps)} dps`
                : '(no winner)';
              console.log(
                `[sim] trinket_pre_scan (pass 2, ${tp2dt}s, ${data.pairs.length} pair(s)): ${winnerStr}`,
              );
              // Lock the new winning pair for the pass-2 gear ladder.
              if (data.winner) {
                const meta = r.pairsByName.get(data.winner.pair_id);
                if (meta) p2TrinketLock = { trinket1: meta.t1, trinket2: meta.t2 };
              }
              // Cache pass-2 result keyed on gear_context_hash so future
              // pass-1 runs that converge to the same gear can reuse.
              if (this.trinketCache) {
                try {
                  this.trinketCache.put({
                    character_key: args.characterKey,
                    scenario: args.scenario,
                    pool_signature: poolSignature(trinkets),
                    gear_context_hash: gearContextHash,
                    pairs: data.pairs,
                    top_trinket_identities: selectTopTrinkets(
                      data.pairs,
                      s.topTrinketsToKeep,
                    ),
                    last_simmed_at: tp2Finished,
                  });
                } catch (err) {
                  console.warn(
                    '[sim] pass-2 trinket cache write failed:',
                    (err as Error).message,
                  );
                }
              }
              // Overwrite scans.trinket_pre_scan with the pass-2 result
              // so the addon panel reflects the latest pair decision.
              scans.trinket_pre_scan = {
                status: 'done',
                started_at: tp2Started,
                finished_at: tp2Finished,
                data,
              };
            } catch (err) {
              tp2Progress.stop();
              console.error(
                '[sim] pass-2 trinket pre-scan failed:',
                (err as Error).message,
              );
            }
          }

          // P2.1b: ring re-prescan against the converged actor. Mirror
          // of the trinket block above — same rationale: gear context is
          // new, so we always do a full pool sim. Failures are non-fatal
          // (we keep the pass-1 ring result on the scans record). No
          // lock is wired into the gear ladder because rings live
          // outside GEAR_LADDER_SLOTS, same as in pass 1.
          const rings = getRingPool(args.parsedExport);
          if (rings.length >= 2) {
            const rp2Started = Math.floor(Date.now() / 1000);
            const rp2T0 = Date.now();
            const rp2Progress = makeStageProgressLogger(
              'ring_pre_scan (pass 2)',
              args.characterKey,
            );
            try {
              const r = await runRingPreScanSim({
                paths: runnerPaths,
                baseProfile: pass2ConvergedProfile,
                rings,
                iterations: s.ringIterations,
                onProgress: rp2Progress.onProgress,
              });
              const pairs = parseRingPreScanResult(r.run, r.pairsByName).pairs;
              const data = finalizeRingResult(pairs);
              const rp2Finished = Math.floor(Date.now() / 1000);
              rp2Progress.stop();
              const rp2dt = ((Date.now() - rp2T0) / 1000).toFixed(1);
              const winnerStr = data.winner
                ? `${data.winner.finger1.name} + ${data.winner.finger2.name} @ ${Math.round(data.winner.mean_dps)} dps`
                : '(no winner)';
              console.log(
                `[sim] ring_pre_scan (pass 2, ${rp2dt}s, ${data.pairs.length} pair(s)): ${winnerStr}`,
              );
              // Cache pass-2 result keyed on gear_context_hash so future
              // pass-1 runs that converge to the same gear can reuse.
              if (this.ringCache) {
                try {
                  this.ringCache.put({
                    character_key: args.characterKey,
                    scenario: args.scenario,
                    pool_signature: ringPoolSignature(rings),
                    gear_context_hash: gearContextHash,
                    pairs: data.pairs,
                    top_ring_identities: selectTopRings(
                      data.pairs,
                      s.topRingsToKeep,
                    ),
                    last_simmed_at: rp2Finished,
                  });
                } catch (err) {
                  console.warn(
                    '[sim] pass-2 ring cache write failed:',
                    (err as Error).message,
                  );
                }
              }
              // Overwrite scans.ring_pre_scan with the pass-2 result so
              // the composer's downstream merge into composed.gear picks
              // up the latest winner.
              scans.ring_pre_scan = {
                status: 'done',
                started_at: rp2Started,
                finished_at: rp2Finished,
                data,
              };
            } catch (err) {
              rp2Progress.stop();
              console.error(
                '[sim] pass-2 ring pre-scan failed:',
                (err as Error).message,
              );
            }
          }

          // P2.2: re-run greedy + breakpoint with new locks + weights_v2.
          if (p2TrinketLock) {
            const gc2Started = Math.floor(Date.now() / 1000);
            const gc2T0 = Date.now();
            const gc2Progress = makeStageProgressLogger(
              'gear_search (pass 2)',
              args.characterKey,
            );
            try {
              const catalogForP2 = this.gearCatalog?.get(
                args.characterKey,
                args.scenario,
              );
              const pass1WinnerDps =
                (scans.gear_final?.data as GearScanResult | undefined)?.winner
                  ?.mean_dps ?? 100_000;
              const greedyResult2 = await runGreedyGearPipeline({
                paths: runnerPaths,
                baseProfile: pass2ConvergedProfile,
                parsed: args.parsedExport,
                weights: weightsV2,
                trinketLock: p2TrinketLock,
                catalog: catalogForP2,
                bestLoadoutDps: pass1WinnerDps,
                greedyIterations: s.coarseIterations,
                breakpointIterations: s.refinedIterations,
                tieWindowPct: TIE_WINDOW_PCT,
                onProgress: gc2Progress.onProgress,
              });
              gc2Progress.stop();
              const gc2dt = ((Date.now() - gc2T0) / 1000).toFixed(1);
              const w2 = greedyResult2.result.winner;
              console.log(
                `[sim] greedy gear search (pass 2, ${gc2dt}s): ` +
                  (w2
                    ? `winner ${w2.combo_id} @ ${Math.round(w2.mean_dps)} dps ` +
                      `(${greedyResult2.greedyIterations} greedy iter, ${greedyResult2.breakpointCombos} breakpoint combos)`
                    : '(no improvement found)'),
              );

              // Compare pass-2 winner against pass-1's. Only overwrite
              // when pass-2 actually improved DPS — sim noise can let a
              // pass-2 run "find" a regression. Tie window: 0.05 % to
              // avoid flipping on noise.
              if (
                greedyResult2.finalDps > 0 &&
                greedyResult2.finalDps > pass1WinnerDps * 1.0005
              ) {
                scans.gear_final = {
                  status: 'done',
                  started_at: gc2Started,
                  finished_at: Math.floor(Date.now() / 1000),
                  data: greedyResult2.result,
                };
                pass2RanAndWon = true;
                console.log(
                  `[gear] PASS 2 winner improved DPS: ${Math.round(pass1WinnerDps)} → ${Math.round(greedyResult2.finalDps)} (+${(((greedyResult2.finalDps - pass1WinnerDps) / pass1WinnerDps) * 100).toFixed(2)}%); overwriting gear_final`,
                );
                // Update catalog with pass-2 winner.
                if (this.gearCatalog) {
                  try {
                    const prior = this.gearCatalog.get(
                      args.characterKey,
                      args.scenario,
                    );
                    const updated = updateCatalogFromGearScan({
                      prior,
                      character_key: args.characterKey,
                      scenario: args.scenario,
                      pool_signature: fullPoolSignature(args.parsedExport),
                      combos: greedyResult2.result.combos,
                      parsedExport: args.parsedExport,
                    });
                    this.gearCatalog.put(this.stampTalentSignature(updated));
                  } catch (err) {
                    console.warn(
                      '[catalog] pass-2 update failed:',
                      (err as Error).message,
                    );
                  }
                }
              } else {
                console.log(
                  `[gear] PASS 2 result did NOT improve DPS (${Math.round(greedyResult2.finalDps)} vs pass-1 ${Math.round(pass1WinnerDps)}); keeping pass-1 winner`,
                );
              }
            } catch (err) {
              gc2Progress.stop();
              console.error(
                '[sim] pass-2 gear pipeline failed:',
                (err as Error).message,
              );
            }
          } else {
            console.log(
              `[gear] PASS 2 skipped (no trinket lock after re-prescan)`,
            );
          }
        } else if (weightsV2 !== undefined) {
          console.log(
            `[gear] pass-2 not needed (weights stable post-pass-1; gear_context_hash=${gearContextHash})`,
          );
        }

        passHistory.push({
          pass: 1,
          finished_at: Math.floor(Date.now() / 1000),
          weights: weightsV2 ?? weightsV1,
          weight_deltas: weightDeltas,
          triggers: gate.reasons.map((r) => r.kind),
          trigger_details: gate.reasons.map(formatReconvergeReason),
        });
        if (pass2RanAndWon) {
          passHistory.push({
            pass: 2,
            finished_at: Math.floor(Date.now() / 1000),
            weights: weightsV2,
            // No pass-3 — capped here. Triggers are forensic (would
            // they have fired again?) but we don't run another
            // stat-weights sim to check; that'd cost another 1.7s
            // for no behavior change at the 2-pass cap.
          });
        }
      }

      // Fallback consumables sim: only runs when the pass-1 prescan
      // and post-pass-1 re-eval both didn't execute (static-fallback
      // path with no real export). Real-export paths already populated
      // `consumablesRun` via the prescan + re-eval and don't need this.
      if (!consumablesRun) {
        const startedAt = Math.floor(Date.now() / 1000);
        const t0 = Date.now();
        const consProgress = makeStageProgressLogger('consumables', args.characterKey);
        try {
          const fbRun = await runSimc({
            paths: runnerPaths,
            profileScript: [args.baseProfile, '', buildAllScanLines()].join('\n'),
            iterations: 1000,
            scratchTag: `consumables-${Date.now()}`,
            onProgress: consProgress.onProgress,
          });
          consProgress.stop();
          consumablesRun = fbRun;
          const fbFinished = Math.floor(Date.now() / 1000);
          const dt = ((Date.now() - t0) / 1000).toFixed(1);
          console.log(
            `[sim] consumables (${dt}s, simc ${fbRun.simcVersion} ${fbRun.gitRevision.slice(0, 8)}): ${fbRun.profilesets.length} profileset(s)`,
          );
          const fbScans = parseAllScanRecords(fbRun, startedAt, fbFinished);
          Object.assign(scans, fbScans);
        } catch (err) {
          consProgress.stop();
          console.error('[sim] consumables sim failed:', err);
          return;
        }
      }

      if (!consumablesRun) {
        console.error('[sim] no consumables run produced; aborting');
        return;
      }
      const run = consumablesRun;
      const finishedAt = Math.floor(Date.now() / 1000);

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

      // ─── Phase 7 — upgrade priority scan ──────────────────────────────
      // For each slot in the composed winner, sim a +1 tier ilvl-override
      // variant and rank by DPS gain. Defensive: failures here are
      // non-fatal — the rest of the queue's already settled.
      if (args.useRealExport && args.parsedExport && composed?.gear) {
        try {
          const composedItems = resolveComposedToParsedItems(
            composed.gear,
            args.parsedExport,
          );
          if (Object.keys(composedItems).length > 0) {
            const upStarted = Math.floor(Date.now() / 1000);
            scans.upgrade_priority = { status: 'running', started_at: upStarted };
            const upProgress = makeStageProgressLogger(
              'upgrade_priority',
              args.characterKey,
            );
            try {
              const upResult = await runUpgradePriorityScan({
                paths: runnerPaths,
                baseProfile: lockedBaseProfile,
                composedGear: composedItems,
                onProgress: upProgress.onProgress,
              });
              upProgress.stop();
              scans.upgrade_priority = {
                status: 'done',
                started_at: upStarted,
                finished_at: Math.floor(Date.now() / 1000),
                data: upResult,
              };
              if (upResult.opportunities.length > 0) {
                const top = upResult.opportunities[0]!;
                console.log(
                  `[upgrade_priority] top: ${top.slot} (${top.name}) ` +
                    `+${top.delta_dps} DPS (${top.delta_pct.toFixed(2)}%)`,
                );
              } else {
                console.log('[upgrade_priority] no upgradeable items (all at ceiling or invalid)');
              }
            } catch (err) {
              upProgress.stop();
              console.warn('[upgrade_priority] failed:', (err as Error).message);
              scans.upgrade_priority = {
                status: 'failed',
                started_at: upStarted,
                finished_at: Math.floor(Date.now() / 1000),
                error: (err as Error).message,
              };
            }
          }
        } catch (err) {
          console.warn(
            '[upgrade_priority] could not resolve composed gear:',
            (err as Error).message,
          );
        }
      }

      // ─── Phase 7 — best_content scan ─────────────────────────────────
      // For each item the player could acquire from enabled content
      // (M+ at picked max level + enabled raid difficulties), sim it as
      // a slot swap at its max-upgrade ilvl and rank by DPS gain. Same
      // defensive try/catch shape as upgrade_priority above.
      if (args.useRealExport && args.parsedExport && composed?.gear) {
        try {
          const composedItems = resolveComposedToParsedItems(
            composed.gear,
            args.parsedExport,
          );
          if (Object.keys(composedItems).length > 0) {
            const bcStarted = Math.floor(Date.now() / 1000);
            scans.best_content = { status: 'running', started_at: bcStarted };
            const bcProgress = makeStageProgressLogger(
              'best_content',
              args.characterKey,
            );
            const settings = getSettings();
            try {
              const bcResult = await runBestContentScan({
                paths: runnerPaths,
                baseProfile: lockedBaseProfile,
                className: args.parsedExport.character.class,
                specKey: args.parsedExport.character.spec ?? '',
                prefs: settings.contentPrefs,
                composedGear: composedItems,
                onProgress: bcProgress.onProgress,
              });
              bcProgress.stop();
              scans.best_content = {
                status: 'done',
                started_at: bcStarted,
                finished_at: Math.floor(Date.now() / 1000),
                data: bcResult,
              };
              if (bcResult.opportunities.length > 0) {
                const top = bcResult.opportunities[0]!;
                console.log(
                  `[best_content] top: ${top.source_label} ${top.slot} item ${top.item_id} ` +
                    `@ ${top.target_ilvl} → +${top.delta_dps} DPS (${top.delta_pct.toFixed(2)}%) ` +
                    `(${bcResult.candidates_evaluated} candidates, ${bcResult.opportunities.length} simmed)`,
                );
              } else {
                console.log(
                  `[best_content] no upgradeable candidates from enabled content ` +
                    `(${bcResult.candidates_evaluated} considered)`,
                );
              }
            } catch (err) {
              bcProgress.stop();
              console.warn('[best_content] failed:', (err as Error).message);
              scans.best_content = {
                status: 'failed',
                started_at: bcStarted,
                finished_at: Math.floor(Date.now() / 1000),
                error: (err as Error).message,
              };
            }
          }
        } catch (err) {
          console.warn(
            '[best_content] could not resolve composed gear:',
            (err as Error).message,
          );
        }
      }

      // Load existing results to preserve other scenarios' data
      let existingScenarios: Partial<Record<Scenario, ScenarioResults>> = {};
      try {
        const existingSource = await readFile(this.opts.paths.resultsLuaPath, 'utf8').catch(() => null);
        if (existingSource) {
          const existing = parseResultsFile(existingSource);
          if (existing) {
            if (existing.scenarios) {
              existingScenarios = existing.scenarios as Partial<Record<Scenario, ScenarioResults>>;
            } else if (existing.scans) {
              // Migrate v2 flat structure into the scenario that was active
              existingScenarios[existing.active_scenario as Scenario] = {
                generated_at: existing.generated_at ?? 0,
                simc_version: existing.simc_version ?? '',
                scans: existing.scans,
                composed: existing.composed,
                catalog_summary: existing.catalog_summary,
              };
            }
          }
        }
      } catch { /* ignore read errors — treat as fresh */ }

      const scenarioResult: ScenarioResults = {
        generated_at: finishedAt,
        simc_version: `${run.simcVersion} (${run.gitRevision.slice(0, 8)})`,
        scans,
        composed,
        catalog_summary: buildCatalogSummary(
          this.gearCatalog?.get(args.characterKey, args.scenario),
        ),
        // Slice 2a: pass_history captures end-of-pass-1 weights snapshot
        // and which reconverge triggers would fire. Empty array (skipped
        // entirely) when the diagnostic gate couldn't run (no real
        // export, gear pipeline failed, etc.). Schema is optional so
        // older readers ignore it.
        pass_history: passHistory.length > 0 ? passHistory : undefined,
      };

      const mergedResults: SimlyResults = {
        schema_version: RESULTS_SCHEMA_VERSION,
        character_key: args.characterKey,
        // dev_mode is the canonical "running under electron-vite dev"
        // signal — addon checks this to render the dev-only Full Sim
        // button. Packaged builds never set ELECTRON_RENDERER_URL.
        dev_mode: !!process.env['ELECTRON_RENDERER_URL'],
        active_scenario: args.scenario,
        scenarios: {
          ...existingScenarios,
          [args.scenario]: scenarioResult,
        },
      };

      try {
        await writeLuaFile(
          this.opts.paths.resultsLuaPath,
          'SimlyResults',
          mergedResults as unknown as Parameters<typeof writeLuaFile>[2],
        );
        this.latestResults = mergedResults;
        console.log('[sim] wrote SimlyResults.lua — /reload in WoW to see it');
        showScanCompleteNotification(scans, args.characterKey);
      } catch (err) {
        console.error('[sim] failed to write SimlyResults.lua:', err);
      }

      this.lastCompletedAt = finishedAt;
      scanOutcome = 'ok';

      // Dev-only Full Sim extension. Runs the Raidbots-Top-Gear-style
      // cartesian against the same actor that just finished, compares
      // its winner to the quick pipeline's gear_final, logs + appends
      // a history record, and re-writes SimlyResults.lua with the
      // gear_final_full scan added. Skipped silently when the flag
      // isn't set or when prerequisites are missing (no parsed export,
      // no trinket lock, etc.).
      if (
        this.fullSimRequested &&
        args.useRealExport &&
        args.parsedExport &&
        trinketLock
      ) {
        await this.runFullSimExtension({
          characterKey: args.characterKey,
          scenario: args.scenario,
          parsedExport: args.parsedExport,
          baseProfile: lockedBaseProfile,
          trinketLock,
          quickScans: scans,
          mergedResults,
          scenarioResult,
          existingScenarios,
          runnerPaths,
        });
        this.lastCompletedFullSimAt = Math.floor(Date.now() / 1000);
      } else if (this.fullSimRequested) {
        console.warn(
          '[full-sim] skipped: prerequisites missing ' +
            `(useRealExport=${args.useRealExport}, parsedExport=${!!args.parsedExport}, trinketLock=${!!trinketLock})`,
        );
        this.lastCompletedFullSimAt = Math.floor(Date.now() / 1000);
      }
    } finally {
      setWindowTitle(terminalTitle(scanOutcome, args.characterKey));
      this.inFlight = false;
      this.runStartedAt = null;
      this.fullSimRequested = false;
      this.currentTalentSignature = null;
      this.emitState();
    }
  }

  /**
   * Dev-only Raidbots-Top-Gear-style full sim. Runs after the quick
   * pipeline has already written SimlyResults.lua; appends a
   * gear_final_full scan record + a comparison JSONL entry. Failures
   * are non-fatal — the quick result already shipped, this is bonus
   * dev-feedback data.
   */
  private async runFullSimExtension(args: {
    characterKey: string;
    scenario: Scenario;
    parsedExport: ParsedExport;
    baseProfile: string;
    trinketLock: TrinketLock;
    quickScans: ScanCollection;
    mergedResults: SimlyResults;
    scenarioResult: ScenarioResults;
    existingScenarios: Partial<Record<Scenario, ScenarioResults>>;
    runnerPaths: { binPath: string; scratchDir: string };
  }): Promise<void> {
    const fsStarted = Math.floor(Date.now() / 1000);
    const fsT0 = Date.now();
    const fsProgress = makeStageProgressLogger(
      'gear_final_full (dev)',
      args.characterKey,
    );

    // Union the catalog's 'trash' set with any items the gear ladder
    // already learned to ignore — full sim still respects the empirical
    // "this item never wins" signal.
    const catalog = this.gearCatalog?.get(args.characterKey, args.scenario);
    const trashIds = ignoredIdentities(catalog);

    let fullResult: ScanRecord<GearScanResult>;
    try {
      const { result } = await runGearFullSimScan({
        paths: args.runnerPaths,
        baseProfile: args.baseProfile,
        parsed: args.parsedExport,
        trinketLock: args.trinketLock,
        ignoreSet: trashIds,
        iterations: FULL_SIM_ITERATIONS,
        maxCombos: MAX_FULL_SIM_COMBOS,
        onProgress: fsProgress.onProgress,
        onPlanReady: (plan) => {
          const estMin = Math.round((plan.comboCount * FULL_SIM_ITERATIONS) / 60_000);
          console.log(
            `[full-sim] cartesian: ${plan.comboCount} combos at ${FULL_SIM_ITERATIONS} iter ` +
              `(${plan.ringPairs} ring pairs, est ~${estMin} min); trash filtered ${trashIds.size}`,
          );
        },
      });
      fsProgress.stop();
      const fsFinished = Math.floor(Date.now() / 1000);
      const fsDuration = (fsFinished - fsStarted);
      fullResult = {
        status: 'done',
        started_at: fsStarted,
        finished_at: fsFinished,
        data: result,
      };

      // Comparison logging + JSONL persistence.
      const quickFinal = args.quickScans.gear_final?.data as GearScanResult | undefined;
      const quickDps = quickFinal?.winner?.mean_dps ?? 0;
      const fullDps = result.winner?.mean_dps ?? 0;
      const deltaPct = quickDps > 0 ? ((fullDps - quickDps) / quickDps) * 100 : 0;
      const quickSlots = new Map(
        (quickFinal?.winner?.items ?? []).map((i) => [i.slot, i.item.name]),
      );
      const fullSlots = new Map(
        (result.winner?.items ?? []).map((i) => [i.slot, i.item.name]),
      );
      const slotsChanged: Array<{ slot: string; quick: string; full: string }> = [];
      for (const [slot, fullName] of fullSlots) {
        const quickName = quickSlots.get(slot);
        if (quickName !== fullName) {
          slotsChanged.push({ slot, quick: quickName ?? '(empty)', full: fullName });
        }
      }
      const slotsSummary = slotsChanged.length === 0
        ? '0 (identical loadout)'
        : `${slotsChanged.length} (${slotsChanged.map((s) => `${s.slot}: ${s.quick}→${s.full}`).join(', ')})`;
      console.log(
        `[full-sim-compare] quick=${Math.round(quickDps)} dps | full=${Math.round(fullDps)} dps | ` +
          `delta=${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(3)}% | slots_changed=${slotsSummary} | ` +
          `combos=${result.total_combos} | duration=${fsDuration}s`,
      );

      const entry: FullSimHistoryEntry = {
        ts: new Date().toISOString(),
        character_key: args.characterKey,
        scenario: args.scenario,
        quick_winner_dps: quickDps,
        full_winner_dps: fullDps,
        delta_pct: Number(deltaPct.toFixed(3)),
        slots_changed: slotsChanged,
        full_combos: result.total_combos,
        full_duration_s: fsDuration,
      };
      await appendFullSimHistory(entry);
    } catch (err) {
      fsProgress.stop();
      console.error('[full-sim] failed:', (err as Error).message);
      fullResult = {
        status: 'failed',
        started_at: fsStarted,
        finished_at: Math.floor(Date.now() / 1000),
        error: (err as Error).message,
      };
    }

    // Update SimlyResults.lua with the new gear_final_full record so
    // the addon sees it on /reload. Mutate the in-memory mergedResults
    // and re-write atomically.
    const updatedScans: ScanCollection = {
      ...args.quickScans,
      gear_final_full: fullResult,
    };
    const updatedScenarioResult: ScenarioResults = {
      ...args.scenarioResult,
      scans: updatedScans,
    };
    const updatedResults: SimlyResults = {
      ...args.mergedResults,
      scenarios: {
        ...args.existingScenarios,
        [args.scenario]: updatedScenarioResult,
      },
    };
    try {
      await writeLuaFile(
        this.opts.paths.resultsLuaPath,
        'SimlyResults',
        updatedResults as unknown as Parameters<typeof writeLuaFile>[2],
      );
      this.latestResults = updatedResults;
      console.log('[full-sim] wrote SimlyResults.lua with gear_final_full');
    } catch (err) {
      console.error('[full-sim] failed to re-write SimlyResults.lua:', err);
    }
  }
}
