import { app, BrowserWindow } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveWowPaths, type WowPaths } from './wow-paths';
import { watchSavedVars, type WatcherHandle } from './watcher';
import { writeLuaFile } from './lua-writer';
import { buildPlaceholderResults } from './question-suite';

const __dirname = dirname(fileURLToPath(import.meta.url));

let watcher: WatcherHandle | undefined;

function createWindow(): void {
  const win = new BrowserWindow({
    width: 900,
    height: 600,
    title: 'Craft Compass',
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

  const placeholder = buildPlaceholderResults('placeholder-character');
  try {
    await writeLuaFile(
      paths.resultsLuaPath,
      'CraftCompassResults',
      placeholder as unknown as Parameters<typeof writeLuaFile>[2],
    );
    console.log('[main] wrote placeholder CraftCompassResults.lua');
  } catch (err) {
    console.error('[main] failed to write results file:', err);
  }

  watcher = watchSavedVars(paths.savedVarsPath, (db) => {
    console.log('[main] parsed CraftCompassDB:');
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
