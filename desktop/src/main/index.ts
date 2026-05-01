import { app, BrowserWindow } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolveWowPaths, type WowPaths } from './wow-paths';
import { watchSavedVars, type WatcherHandle } from './watcher';
import { writeLuaFile } from './lua-writer';
import { buildPlaceholderResults } from './question-suite';

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

  const placeholder = buildPlaceholderResults('placeholder-character');
  try {
    await writeLuaFile(
      paths.resultsLuaPath,
      'SimlyResults',
      placeholder as unknown as Parameters<typeof writeLuaFile>[2],
    );
    console.log('[main] wrote placeholder SimlyResults.lua');
  } catch (err) {
    console.error('[main] failed to write results file:', err);
  }

  watcher = watchSavedVars(paths.savedVarsPath, (db) => {
    console.log('[main] parsed SimlyDB:');
    console.dir(db, { depth: null });
  });
  console.log('[main] watching SavedVariables...');
  return paths;
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
