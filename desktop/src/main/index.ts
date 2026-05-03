import { app, BrowserWindow } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolveWowPaths, type WowPaths } from './wow-paths';
import { watchSavedVars, type WatcherHandle } from './watcher';
import { writeLuaFile } from './lua-writer';
import { bootstrapSimc, type BootstrapResult } from './simc-bootstrap';
import { ScanQueue } from './scan-queue';
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
  // before any sim has run. ONLY write when no results file exists —
  // overwriting on every boot would clobber a real sim's rich data
  // (scan tables, flask/food names, gear list) and reduce the addon
  // panel to the minimal "Up to date" view until the next full sim.
  if (!existsSync(paths.resultsLuaPath)) {
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
      console.log('[main] wrote placeholder SimlyResults.lua (no prior file found)');
    } catch (err) {
      console.error('[main] failed to write results file:', err);
    }
  } else {
    console.log('[main] preserving existing SimlyResults.lua from prior session');
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

  const queue = new ScanQueue({ paths, simc });
  watcher = watchSavedVars(paths.savedVarsPath, (db) => {
    console.log(
      `[main] SavedVars updated: ${db.character.name}-${db.character.realm} (${db.character.class} ${db.character.spec})`,
    );
    queue.maybeRunForSavedVars(db);
  });
  console.log('[main] watching SavedVariables...');
  console.log(
    '[main] click "Update sims" in the in-game panel and /reload to trigger a run.',
  );
  return paths;
}

// Windows-only: tell the OS our App User Model ID. Without this,
// notification toasts are silently suppressed on Windows 10/11
// because Electron looks like an "unknown app" to the action center.
// Must be called before any Notification is shown — easiest is
// before app.whenReady() resolves.
if (process.platform === 'win32') {
  app.setAppUserModelId('com.simly.desktop');
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
