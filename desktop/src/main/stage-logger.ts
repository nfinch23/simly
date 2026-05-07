/**
 * Stage progress logging + window-title management for sim runs.
 * Extracted from scan-queue.ts so the queue's orchestration code
 * stays focused on dispatch and the side-effecting UI bits live in
 * one place.
 *
 * Public surface:
 *   - makeStageProgressLogger: per-stage progress callback factory.
 *     Threads SimC stdout/stderr lines through, filters noise, runs
 *     a 30s heartbeat, updates the Simly window title.
 *   - setWindowTitle: defensive BrowserWindow.setTitle wrapper.
 *   - showScanCompleteNotification: 3-layer notify on scan complete
 *     (node-notifier toast, taskbar flash, console log).
 *   - formatRelative: "5m ago" / "2h ago" string for log output.
 *   - isInterestingSimcLine: extracted regex check, exported for
 *     unit testing without spinning up a full progress logger.
 */

import { BrowserWindow } from 'electron';
import notifier from 'node-notifier';
import type { ScanCollection } from '@simly/shared';

/**
 * Update the Simly window's title bar (and therefore taskbar text)
 * with current state. Catches edge cases (window destroyed, no
 * window yet) so callers aren't tied to UI lifecycle.
 */
export function setWindowTitle(title: string): void {
  try {
    const wins = BrowserWindow.getAllWindows();
    if (wins.length === 0) return;
    wins[0]!.setTitle(title);
  } catch (err) {
    console.warn('[notify] setWindowTitle threw:', (err as Error).message);
  }
}

export function terminalTitle(
  outcome: 'ok' | 'failed',
  characterKey: string,
): string {
  return outcome === 'ok'
    ? `Simly — Up to date (${characterKey})`
    : `Simly — Scan failed (${characterKey})`;
}

/**
 * "5s ago" / "2h ago" / "(unknown)" formatter for log lines.
 * Pure — exported separately so it can be tested without mocking
 * Date.
 */
export function formatRelative(unixSeconds: number): string {
  if (!unixSeconds) return '(unknown)';
  const now = Math.floor(Date.now() / 1000);
  const dt = now - unixSeconds;
  if (dt < 60) return `${dt}s ago`;
  if (dt < 3600) return `${Math.floor(dt / 60)}m ago`;
  if (dt < 86400) return `${Math.floor(dt / 3600)}h ago`;
  return `${Math.floor(dt / 86400)}d ago`;
}

/**
 * SimC output filters: keep lines that signal real progress; drop
 * banner / debug noise. Patterns chosen by inspecting actual SimC
 * output — adjust here if SimC output changes. Exported for
 * isolation testing.
 */
export const INTERESTING_SIMC_PATTERNS: readonly RegExp[] = [
  /Generating Baseline/i,
  /Generating Profile Set/i,
  /Profileset.*\d+\s*\/\s*\d+/i,
  /Iteration/i,
  /Generating reports/i,
  /^\s*\[\s*\d+(?:\.\d+)?%\s*\]/, // "[ 42% ]" style
  /seconds?$/i, // SimC prints "X seconds" on timing lines
  /^Done/i,
  /Error|warning/i,
];

/** True when a SimC stdout line looks like real progress (vs banner noise). */
export function isInterestingSimcLine(line: string): boolean {
  return INTERESTING_SIMC_PATTERNS.some((p) => p.test(line));
}

export interface StageProgressLogger {
  onProgress: (event: { stream: 'stdout' | 'stderr' | 'meta'; line: string }) => void;
  setLabel: (label: string) => void;
  stop: () => void;
}

/**
 * Per-stage progress + heartbeat logger. Threads through to the SimC
 * runner's `onProgress` so we get every stdout/stderr line as it's
 * emitted; in parallel runs a 30s timer that emits a "[heartbeat]"
 * line so the user sees something even when SimC is silent. Also
 * keeps the window title fresh with the current stage label and
 * elapsed seconds.
 *
 * Returns:
 *   - `onProgress`: pass to runSimc — logs interesting lines, swallows
 *     noise, and resets the heartbeat clock.
 *   - `setLabel(label)`: update the stage label mid-flight (used by
 *     gear_coarse once the cartesian size is known).
 *   - `stop()`: clear the heartbeat timer. Always called from a
 *     finally / catch so a thrown error doesn't leak the timer.
 */
export function makeStageProgressLogger(
  initialLabel: string,
  characterKey: string,
): StageProgressLogger {
  let label = initialLabel;
  const startedAt = Date.now();
  let lastSeenAt = Date.now();
  const updateTitle = (suffix?: string): void => {
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
    const tail = suffix ? ` — ${suffix}` : '';
    setWindowTitle(`Simly — ${label} (${elapsed}s${tail}) [${characterKey}]`);
  };
  updateTitle();

  // Heartbeat: every 30s, if SimC has been quiet, log so the user
  // knows the process is alive. SimC tends to print rate-limited
  // progress on profileset runs but can go silent for minutes during
  // initial APL parsing on big cartesians.
  const heartbeat = setInterval(() => {
    const sinceLastLine = ((Date.now() - lastSeenAt) / 1000).toFixed(0);
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
    console.log(
      `[heartbeat] ${label}: ${elapsed}s elapsed, ${sinceLastLine}s since last simc output`,
    );
    updateTitle(`silent ${sinceLastLine}s`);
  }, 30_000);

  const onProgress: StageProgressLogger['onProgress'] = (event) => {
    lastSeenAt = Date.now();
    const { line, stream } = event;
    if (stream === 'stderr') {
      // stderr is usually meaningful (warnings / errors).
      console.log(`[simc:err] ${line}`);
      updateTitle();
      return;
    }
    if (isInterestingSimcLine(line)) {
      console.log(`[simc] ${line}`);
      // Pull a short tail for the title — the line itself can be long.
      const short = line.length > 60 ? `${line.slice(0, 57)}…` : line;
      updateTitle(short);
    }
  };

  return {
    onProgress,
    setLabel(next: string) {
      label = next;
      updateTitle();
    },
    stop() {
      clearInterval(heartbeat);
    },
  };
}

/**
 * Tell the user the scan finished. Three layers of signal so the user
 * gets at least one of them no matter what the OS / Focus Assist /
 * dev-mode-electron suppresses:
 *
 *   1. Native Windows toast via Electron's Notification API. Often
 *      suppressed in dev mode because the dev electron.exe isn't
 *      registered as a known app even with setAppUserModelId().
 *   2. Taskbar flash on the Simly window — works reliably regardless
 *      of OS notification settings; user sees an orange-blinking
 *      icon in their taskbar until they click it.
 *   3. Console log — visible in the dev terminal at minimum.
 *
 * Each layer is wrapped in its own try so a failure in one doesn't
 * prevent the others from firing.
 */
export function showScanCompleteNotification(
  scans: ScanCollection,
  characterKey: string,
): void {
  const completed: string[] = [];
  for (const [id, record] of Object.entries(scans)) {
    if (record?.status === 'done') completed.push(id);
  }
  const summary = completed.length === 0
    ? 'No scans completed'
    : `${completed.length} scan${completed.length === 1 ? '' : 's'}: ${completed.join(', ')}`;
  const body = `${characterKey}\n${summary}\n/reload in WoW to see results.`;

  console.log(`[notify] scan complete: ${summary} (for ${characterKey})`);

  // Layer 1: native toast via node-notifier (uses bundled SnoreToast on
  // Windows). Electron's built-in Notification API silently drops toasts
  // in dev mode because it requires a Start Menu shortcut with the
  // AUMID baked in — node-notifier sidesteps that by shipping its own
  // toast helper that handles AUMID registration internally. Works in
  // dev electron without any setup.
  try {
    // appID + sound are Windows-only options on WindowsToaster; the
    // cross-platform Notification type doesn't expose them, so we
    // assemble the options object loosely and pass via cast.
    const opts = {
      title: 'Simly: scan complete',
      message: body,
      appID: 'com.simly.desktop',
      sound: true,
      wait: false,
      timeout: 10,
    } as Parameters<typeof notifier.notify>[0];
    notifier.notify(opts, (err, response) => {
      if (err) console.warn('[notify] node-notifier err:', err.message);
      else console.log('[notify] node-notifier response:', response);
    });
    console.log('[notify] called notifier.notify()');
  } catch (err) {
    console.warn('[notify] notifier threw:', (err as Error).message);
  }

  // Layer 2: flash the taskbar icon. Survives Focus Assist + dev-mode
  // electron quirks. The flash stops when the user focuses the window.
  try {
    const wins = BrowserWindow.getAllWindows();
    if (wins.length > 0) {
      wins[0]!.flashFrame(true);
      wins[0]!.setOverlayIcon(null, 'Scan complete');
      console.log(`[notify] flashed taskbar on ${wins.length} window(s)`);
    } else {
      console.warn('[notify] no BrowserWindow to flash');
    }
  } catch (err) {
    console.warn('[notify] flashFrame threw:', (err as Error).message);
  }
}
