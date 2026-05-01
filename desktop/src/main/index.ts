import { app, BrowserWindow } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolveWowPaths, type WowPaths } from './wow-paths';
import { watchSavedVars, type WatcherHandle } from './watcher';
import { writeLuaFile } from './lua-writer';
import { buildPlaceholderResults } from './question-suite';
import { resolveSimcPaths } from './simc-paths';
import { runSimc } from './simc-runner';
import {
  buildFlaskProfilesetLines,
  parseBestFlask,
} from './questions/best-flask';
import { STATIC_DESTRO_WARLOCK_PROFILE } from './static-profile';
import { RESULTS_SCHEMA_VERSION, type SimlyResults } from '@simly/shared';

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
  const placeholder = buildPlaceholderResults('placeholder-character');
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
    void runFlaskSim(paths, db.character).finally(() => {
      simInFlight = false;
    });
  });
  console.log('[main] watching SavedVariables...');
  return paths;
}

async function runFlaskSim(
  paths: WowPaths,
  character: { name: string; realm: string; region: string },
): Promise<void> {
  const characterKey = `${character.name}-${character.realm}-${character.region}`;
  const simcPaths = resolveSimcPaths();
  const profileScript = [
    STATIC_DESTRO_WARLOCK_PROFILE,
    '',
    buildFlaskProfilesetLines(),
  ].join('\n');

  console.log(`[sim] starting flask sim for ${characterKey} via ${simcPaths.binPath}`);
  const t0 = Date.now();
  let run;
  try {
    run = await runSimc({
      paths: simcPaths,
      profileScript,
      iterations: 1000,
      scratchTag: `flask-${Date.now()}`,
    });
  } catch (err) {
    console.error('[sim] simc run failed:', err);
    return;
  }
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `[sim] simc ${run.simcVersion} (${run.gitRevision.slice(0, 8)}) finished in ${dt}s with ${run.profilesets.length} profileset(s)`,
  );

  const bestFlask = parseBestFlask(run);
  if (!bestFlask) {
    console.error('[sim] no matching flask results in SimC output');
    return;
  }
  console.log(
    `[sim] best flask: ${bestFlask.best.name} @ ${bestFlask.best.dps} dps`,
  );

  const results: SimlyResults = {
    schema_version: RESULTS_SCHEMA_VERSION,
    generated_at: Math.floor(Date.now() / 1000),
    simc_version: `${run.simcVersion} (${run.gitRevision.slice(0, 8)})`,
    character_key: characterKey,
    questions: { best_flask: bestFlask },
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
