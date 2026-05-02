import { app, BrowserWindow } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolveWowPaths, type WowPaths } from './wow-paths';
import { watchSavedVars, type WatcherHandle } from './watcher';
import { writeLuaFile } from './lua-writer';
import { bootstrapSimc, type BootstrapResult } from './simc-bootstrap';
import { runSimc } from './simc-runner';
import {
  buildAllScanLines,
  parseAllScanRecords,
} from './scans/registry';
import { STATIC_DESTRO_WARLOCK_PROFILE } from './static-profile';
import {
  RESULTS_SCHEMA_VERSION,
  type BestFlaskResult,
  type BestFoodResult,
  type ComposedLoadout,
  type ScanCollection,
  type SimlyResults,
} from '@simly/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));

const RESULTS_TOC = `## Interface: 120005
## Title: Simly Results
## Notes: Auto-generated results file for Simly. Do not edit manually.
## Author: Noah Finch
## Version: 0.0.0
## Dependencies: Simly

SimlyResults.lua
`;

let watcher: WatcherHandle | undefined;

function createWindow(): void {
  const win = new BrowserWindow({
    width: 900,
    height: 600,
    title: 'Simly',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  });

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

async function startRoundTrip(): Promise<WowPaths | undefined> {
  let paths: WowPaths;
  try {
    paths = resolveWowPaths();
  } catch (err) {
    console.error('[main] could not resolve WoW paths:', err);
    console.error(
      '[main] phase 1 spike disabled. Install WoW or override the retail root once Settings UI lands.',
    );
    return undefined;
  }

  console.log('[main] retailRoot:', paths.retailRoot);
  console.log('[main] account:', paths.account);
  console.log('[main] savedVarsPath:', paths.savedVarsPath);
  console.log('[main] resultsLuaPath:', paths.resultsLuaPath);

  // Ensure the sister addon's .toc exists. WoW won't load the addon
  // without one, so the user would silently see no results in chat. We
  // never overwrite an existing .toc in case the user has customized it.
  try {
    await mkdir(paths.resultsAddonDir, { recursive: true });
    const tocPath = join(paths.resultsAddonDir, 'SimlyResults.toc');
    if (!existsSync(tocPath)) {
      await writeFile(tocPath, RESULTS_TOC, 'utf8');
      console.log('[main] wrote SimlyResults.toc (was missing)');
    }
  } catch (err) {
    console.error('[main] failed to ensure results .toc:', err);
  }

  // Seed a placeholder file so the addon loads cleanly on first /reload
  // before any sim has run. Replaced as soon as a real sim completes.
  const placeholder: SimlyResults = {
    schema_version: RESULTS_SCHEMA_VERSION,
    generated_at: Math.floor(Date.now() / 1000),
    simc_version: 'placeholder',
    character_key: 'placeholder-character',
    active_scenario: 'single_target_patchwerk',
    scans: {},
  };
  try {
    await writeLuaFile(
      paths.resultsLuaPath,
      'SimlyResults',
      placeholder as unknown as Parameters<typeof writeLuaFile>[2],
    );
    console.log('[main] wrote placeholder SimlyResults.lua (will be replaced by first sim)');
  } catch (err) {
    console.error('[main] failed to write results file:', err);
  }

  // Bring up SimC: resolve the version we should be on, install if
  // missing, fall back to whatever's on disk if the network is down.
  // Done at boot rather than per-sim so we pay the install cost once
  // and the runner has a stable binPath to reuse for every sim.
  let simc: BootstrapResult;
  try {
    simc = await bootstrapSimc();
    if (simc.installedVersion) {
      console.log(
        `[boot] simc ${simc.installedVersion.tag} ${simc.source} (binPath: ${simc.binPath})`,
      );
    } else {
      console.log(`[boot] simc ${simc.source} (binPath: ${simc.binPath})`);
    }
  } catch (err) {
    console.error('[boot] simc bootstrap failed:', err);
    console.error('[boot] sim runs disabled until SimC is available.');
    return paths;
  }

  let simInFlight = false;
  watcher = watchSavedVars(paths.savedVarsPath, (db) => {
    console.log(
      `[main] SavedVars updated: ${db.character.name}-${db.character.realm} (${db.character.class} ${db.character.spec})`,
    );
    if (simInFlight) {
      console.log('[main] sim already in flight; skipping until current run finishes');
      return;
    }
    simInFlight = true;
    void runFlaskSim(paths, simc, db).finally(() => {
      simInFlight = false;
    });
  });
  console.log('[main] watching SavedVariables...');
  return paths;
}

/** Sentinel values the addon writes when it can't produce a real export. */
const ADDON_FALLBACK_SENTINELS = new Set([
  'PLACEHOLDER_PROFILE',
  'NO_PROFILE_AVAILABLE',
]);

async function runFlaskSim(
  paths: WowPaths,
  simc: BootstrapResult,
  db: import('@simly/shared').SimlyDB,
): Promise<void> {
  const character = db.character;
  const characterKey = `${character.name}-${character.realm}-${character.region}`;

  // Prefer the real character profile written by the SimulationCraft
  // addon at PLAYER_LOGOUT. Fall back to our hand-written static profile
  // when the addon couldn't generate one (sentinel) — keeps Phase 1
  // SavedVars from old logouts working and lets dev iterate without
  // requiring an in-game logout for every run.
  const exportTrimmed = (db.simc_export ?? '').trim();
  const useRealExport =
    exportTrimmed.length > 0 && !ADDON_FALLBACK_SENTINELS.has(exportTrimmed);
  const baseProfile = useRealExport ? exportTrimmed : STATIC_DESTRO_WARLOCK_PROFILE;
  if (!useRealExport) {
    console.log(
      `[sim] simc_export is "${exportTrimmed.slice(0, 40)}"; using static fallback profile`,
    );
  } else {
    console.log(`[sim] using real character export (${exportTrimmed.length} bytes)`);
  }

  const profileScript = [baseProfile, '', buildAllScanLines()].join('\n');

  console.log(`[sim] starting consumables sim for ${characterKey} via ${simc.binPath}`);
  const startedAt = Math.floor(Date.now() / 1000);
  const t0 = Date.now();
  let run;
  try {
    run = await runSimc({
      paths: { binPath: simc.binPath, scratchDir: simc.scratchDir },
      profileScript,
      iterations: 1000,
      scratchTag: `consumables-${Date.now()}`,
    });
  } catch (err) {
    console.error('[sim] simc run failed:', err);
    return;
  }
  const finishedAt = Math.floor(Date.now() / 1000);
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `[sim] simc ${run.simcVersion} (${run.gitRevision.slice(0, 8)}) finished in ${dt}s with ${run.profilesets.length} profileset(s)`,
  );

  const scans = parseAllScanRecords(run, startedAt, finishedAt);
  if (Object.keys(scans).length === 0) {
    console.error('[sim] no scan results in SimC output');
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
    character_key: characterKey,
    active_scenario: 'single_target_patchwerk',
    scans,
    composed,
  };

  try {
    await writeLuaFile(
      paths.resultsLuaPath,
      'SimlyResults',
      results as unknown as Parameters<typeof writeLuaFile>[2],
    );
    console.log('[sim] wrote SimlyResults.lua — /reload in WoW to see it');
  } catch (err) {
    console.error('[sim] failed to write SimlyResults.lua:', err);
  }
}

/**
 * Phase 3 v1-shim composer: assemble the addon-facing `composed` view
 * from the two consumable scans we actually run today. Phase 4 replaces
 * this with `composer.ts` that combines results from the full gear ladder.
 */
function composeFromConsumableScans(scans: ScanCollection): ComposedLoadout | undefined {
  const flask = scans.best_flask?.data as BestFlaskResult | undefined;
  const food = scans.best_food?.data as BestFoodResult | undefined;
  if (!flask && !food) return undefined;
  return {
    label: 'Best consumables (single-target Patchwerk)',
    flask: flask?.best ? { item_id: flask.best.item_id, name: flask.best.name } : undefined,
    food: food?.best ? { item_id: food.best.item_id, name: food.best.name } : undefined,
  };
}

app.whenReady().then(async () => {
  await startRoundTrip();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', async () => {
  if (watcher) await watcher.close();
});
