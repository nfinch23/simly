import { app, BrowserWindow, ipcMain } from 'electron';
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
import { getSettings, setSettings, resetSettings } from './settings';
import { IgnoreListStore } from './ignore-list';
import { startHeartbeat, ensureHeartbeatToc, type HeartbeatHandle } from './heartbeat';
import {
  IPC_QUEUE_STATE_CHANGED,
  IPC_QUEUE_GET_STATE,
  IPC_PROFILE_PASTE,
  IPC_SETTINGS_GET,
  IPC_SETTINGS_SET,
  IPC_IGNORE_LIST_LIST,
  IPC_IGNORE_LIST_REMOVE,
  IPC_IGNORE_LIST_CLEAR,
  IPC_DEV_CLEAR_SIM_CACHE,
  type QueueState,
  type PasteProfileArgs,
  type IgnoreListFilter,
  type RemoveIgnoreEntryArgs,
} from './ipc';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Swallow EPIPE on stdout/stderr writes. The Electron main process
// inherits stdout from electron-vite's dev wrapper; when that pipe
// closes (window reload, dev script exit, etc.) any subsequent
// console.log throws EPIPE and Electron pops a fatal dialog. Tagged
// per-stream so we still see other errors.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EPIPE') throw err;
  });
}
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') return;
  // Re-throw anything else so we still get the fatal dialog for real bugs.
  throw err;
});

const RESULTS_TOC = `## Interface: 120005
## Title: Simly Results
## Notes: Auto-generated results file for Simly. Do not edit manually.
## Author: Noah Finch
## Version: 0.0.0
## Dependencies: Simly

SimlyResults.lua
SimlyHeartbeat.lua
`;

let watcher: WatcherHandle | undefined;
let queue: ScanQueue | undefined;
let heartbeat: HeartbeatHandle | undefined;
// Set during the before-quit handler so the close-to-hide intercept
// knows to actually let the window go when the app is genuinely quitting
// (Ctrl+C, Task Manager kill, etc.) vs. just the user clicking X.
let isQuitting = false;

/** Push queue state to all open renderer windows. */
function pushQueueState(state: QueueState): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_QUEUE_STATE_CHANGED, state);
    }
  }
}

/** Register all ipcMain handlers. Called once before the window opens. */
function registerIpcHandlers(): void {
  // Queue state
  ipcMain.handle(IPC_QUEUE_GET_STATE, () => queue?.getQueueState() ?? {
    isRunning: false,
    characterKey: null,
    scenario: null,
    runStartedAt: null,
    lastCompletedAt: null,
    results: null,
  });

  // Paste-profile trigger
  ipcMain.handle(IPC_PROFILE_PASTE, async (_e, args: PasteProfileArgs) => {
    if (!queue) return;
    await queue.runWithPastedProfile({
      profileScript: args.profileScript,
      characterKey: 'paste-input',
      scenario: 'single_target_patchwerk',
    });
  });

  // Settings
  ipcMain.handle(IPC_SETTINGS_GET, () => getSettings());
  ipcMain.handle(IPC_SETTINGS_SET, (_e, updates: Partial<ReturnType<typeof getSettings>>) =>
    setSettings(updates),
  );

  // Ignore list — share the same store instance the queue uses
  const ignoreListStore = new IgnoreListStore();
  ipcMain.handle(IPC_IGNORE_LIST_LIST, (_e, filter?: IgnoreListFilter) =>
    ignoreListStore.list({ character_key: filter?.characterKey, scenario: filter?.scenario }),
  );
  ipcMain.handle(IPC_IGNORE_LIST_REMOVE, (_e, args: RemoveIgnoreEntryArgs) =>
    ignoreListStore.markManuallyRemoved(args.characterKey, args.scenario, args.itemIdentity),
  );
  ipcMain.handle(IPC_IGNORE_LIST_CLEAR, () => ignoreListStore.clear());

  // Dev tools — full sim cache wipe
  ipcMain.handle(IPC_DEV_CLEAR_SIM_CACHE, async () => {
    if (!queue) {
      return {
        inFlight: false,
        catalogCleared: false,
        trinketCleared: false,
        ignoreCleared: false,
        resultsLuaDeleted: false,
      };
    }
    return queue.clearAllCaches();
  });

  void resetSettings; // available but not wired to IPC in Phase 5 — Settings UI uses setSettings
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 900,
    height: 600,
    title: 'Simly',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
    },
  });

  // Hide instead of destroy when the user clicks the X. The
  // SavedVariables watcher + scan queue keep running in the background;
  // closing the window is treated as "I don't need this debug view
  // right now." Re-opening: launch `npm run dev` again — the
  // single-instance handler below intercepts the second launch and
  // brings the existing window back. This stops every accidental
  // window-close from killing an in-flight sim.
  win.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      win.hide();
    }
  });

  // Re-push queue state whenever the window becomes visible/focused.
  // While the window is hidden Electron sometimes drops queued
  // webContents.send messages (or the renderer's listeners are paused),
  // so a scan that completes off-screen can leave the renderer's
  // QueueState stuck on `isRunning: true`. Pushing on show/focus is
  // cheap (single IPC message) and covers both "user un-hid the window"
  // and "user alt-tabbed back" cases.
  const refreshRenderer = (): void => {
    if (queue && !win.isDestroyed()) {
      win.webContents.send(IPC_QUEUE_STATE_CHANGED, queue.getQueueState());
    }
  };
  win.on('show', refreshRenderer);
  win.on('focus', refreshRenderer);

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
    } else if (ensureHeartbeatToc(tocPath)) {
      // Existing installs predate the heartbeat file; patch their toc
      // to list it so the addon can detect desktop liveness. Safe: the
      // helper only appends if the line is missing.
      console.log('[main] patched SimlyResults.toc to load SimlyHeartbeat.lua');
    }
  } catch (err) {
    console.error('[main] failed to ensure results .toc:', err);
  }

  // Start the desktop-liveness heartbeat. Writes SimlyHeartbeat.lua
  // every 60s; the addon reads it at PLAYER_LOGIN and warns the user
  // if the timestamp is stale (desktop crashed / not running).
  try {
    heartbeat = startHeartbeat({
      resultsAddonDir: paths.resultsAddonDir,
      version: app.getVersion(),
    });
    console.log('[main] heartbeat started');
  } catch (err) {
    console.warn('[main] failed to start heartbeat:', (err as Error).message);
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

  queue = new ScanQueue({ paths, simc, onStateChange: pushQueueState });
  watcher = watchSavedVars(paths.savedVarsPath, (db) => {
    console.log(
      `[main] SavedVars updated: ${db.character.name}-${db.character.realm} (${db.character.class} ${db.character.spec})`,
    );
    queue!.maybeRunForSavedVars(db);
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

// Single-instance lock: a second `npm run dev` (or any other Simly
// launch) will hand off to the already-running instance. The existing
// instance receives `second-instance` and re-shows its (hidden) window.
// Without this, accidentally closing the Simly window would lock the
// user out of the dev view until they killed the npm process.
const gotInstanceLock = app.requestSingleInstanceLock();
if (!gotInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const wins = BrowserWindow.getAllWindows();
    if (wins.length > 0) {
      const win = wins[0]!;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    } else {
      createWindow();
    }
  });
}

app.whenReady().then(async () => {
  registerIpcHandlers();
  await startRoundTrip();
  createWindow();
});

app.on('window-all-closed', () => {
  // Don't quit on window close — see the close-to-hide intercept in
  // createWindow(). The watcher + scan queue stay alive so a sim
  // already in progress (or a future "Update sims" click) still
  // completes without the user reopening the desktop window.
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', async () => {
  isQuitting = true;
  if (heartbeat) heartbeat.stop();
  if (watcher) await watcher.close();
});
