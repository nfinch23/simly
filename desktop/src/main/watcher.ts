import chokidar from 'chokidar';
import { readFile } from 'node:fs/promises';
import { parseSavedVars } from './lua-parser';
import type { SimlyDB } from '@simly/shared';

const DEBOUNCE_MS = 200;

export interface WatcherHandle {
  close: () => Promise<void>;
}

/**
 * Watch the SavedVariables file. WoW writes the file atomically on /reload
 * or logout, but we still debounce to dodge the rare partial-read window.
 * On each settled change we parse and hand the typed object to onUpdate;
 * parse failures are logged and skipped (next write will probably succeed).
 */
export function watchSavedVars(
  path: string,
  onUpdate: (db: SimlyDB) => void,
): WatcherHandle {
  let timer: NodeJS.Timeout | undefined;

  const handle = async (): Promise<void> => {
    try {
      const source = await readFile(path, 'utf8');
      const db = parseSavedVars(source);
      onUpdate(db);
    } catch (err) {
      console.error('[watcher] parse failed:', err);
    }
  };

  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void handle();
    }, DEBOUNCE_MS);
  };

  const watcher = chokidar.watch(path, {
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: DEBOUNCE_MS, pollInterval: 50 },
  });

  watcher.on('add', schedule);
  watcher.on('change', schedule);
  watcher.on('error', (err) => console.error('[watcher] error:', err));

  return {
    close: async () => {
      if (timer) clearTimeout(timer);
      await watcher.close();
    },
  };
}
