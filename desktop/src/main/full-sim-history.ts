/**
 * Append-only JSONL writer for full-sim comparison records. Dev tool —
 * lets us watch how accurate the greedy pipeline is vs the exhaustive
 * cartesian across many runs without a schema bump.
 *
 * Each call appends one line:
 *   {"ts":"...","character":"...","quick_winner_dps":...,"full_winner_dps":...,...}
 *
 * Lives in electron's userData dir so it co-locates with electron-store
 * caches and survives across desktop restarts. On Windows that's
 * roughly `%APPDATA%/@simly/desktop/full-sim-history.jsonl`.
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { app } from 'electron';

export interface FullSimHistoryEntry {
  /** ISO 8601 UTC. */
  ts: string;
  character_key: string;
  scenario: string;
  /** Best mean DPS from the quick (greedy + breakpoint) pipeline. */
  quick_winner_dps: number;
  /** Best mean DPS from the full cartesian sim. */
  full_winner_dps: number;
  /** (full - quick) / quick × 100. Positive = full found more DPS than quick missed. */
  delta_pct: number;
  /** Per-slot differences between the two winners. Empty array = identical loadout. */
  slots_changed: Array<{ slot: string; quick: string; full: string }>;
  /** Cartesian size the full sim ran. */
  full_combos: number;
  /** Wall-clock seconds the full sim took (SimC + setup). */
  full_duration_s: number;
}

/**
 * Resolve the JSONL path. Optional `overrideDir` lets tests inject a
 * temp dir without spinning up electron — production callers leave it
 * unset and we use electron's `userData`.
 */
export function fullSimHistoryPath(overrideDir?: string): string {
  const dir = overrideDir ?? app.getPath('userData');
  return join(dir, 'full-sim-history.jsonl');
}

/**
 * Append one comparison record. Creates the file (and parent dir) if
 * missing. Never throws on disk errors — logs and swallows so a
 * history-write failure doesn't tank the whole sim run.
 */
export async function appendFullSimHistory(
  entry: FullSimHistoryEntry,
  overrideDir?: string,
): Promise<void> {
  const path = fullSimHistoryPath(overrideDir);
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    console.warn(
      '[full-sim-history] write failed:',
      (err as Error).message,
      'path=' + path,
    );
  }
}

/**
 * Read every entry from the history file. Skips malformed lines (logs
 * once per bad line). Returns an empty array if the file doesn't exist
 * yet — first-run case.
 */
export async function readFullSimHistory(
  overrideDir?: string,
): Promise<FullSimHistoryEntry[]> {
  const path = fullSimHistoryPath(overrideDir);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: FullSimHistoryEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as FullSimHistoryEntry);
    } catch (err) {
      console.warn(
        '[full-sim-history] skipping malformed line:',
        (err as Error).message,
      );
    }
  }
  return out;
}
