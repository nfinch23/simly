import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendFullSimHistory,
  fullSimHistoryPath,
  readFullSimHistory,
  type FullSimHistoryEntry,
} from './full-sim-history';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'simly-full-sim-history-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function fakeEntry(overrides: Partial<FullSimHistoryEntry> = {}): FullSimHistoryEntry {
  return {
    ts: '2026-05-13T22:30:00Z',
    character_key: 'Felfriend-Zuljin-us',
    scenario: 'single_target_patchwerk',
    quick_winner_dps: 73757,
    full_winner_dps: 73812,
    delta_pct: 0.075,
    slots_changed: [],
    full_combos: 1247,
    full_duration_s: 1480,
    ...overrides,
  };
}

describe('appendFullSimHistory + readFullSimHistory round-trip', () => {
  it('appends a single entry and reads it back', async () => {
    const entry = fakeEntry();
    await appendFullSimHistory(entry, tmp);
    const read = await readFullSimHistory(tmp);
    expect(read).toEqual([entry]);
  });

  it('appends multiple entries preserving order', async () => {
    const a = fakeEntry({ ts: '2026-05-13T22:30:00Z', full_winner_dps: 73812 });
    const b = fakeEntry({ ts: '2026-05-13T23:00:00Z', full_winner_dps: 74000 });
    await appendFullSimHistory(a, tmp);
    await appendFullSimHistory(b, tmp);
    const read = await readFullSimHistory(tmp);
    expect(read).toHaveLength(2);
    expect(read[0]!.ts).toBe('2026-05-13T22:30:00Z');
    expect(read[1]!.ts).toBe('2026-05-13T23:00:00Z');
    expect(read[1]!.full_winner_dps).toBe(74000);
  });

  it('returns empty array when the history file does not exist yet', async () => {
    const read = await readFullSimHistory(tmp);
    expect(read).toEqual([]);
  });

  it('skips malformed lines without throwing', async () => {
    const good = fakeEntry();
    const path = fullSimHistoryPath(tmp);
    writeFileSync(
      path,
      JSON.stringify(good) + '\n' + '{not valid json\n' + JSON.stringify({ ...good, ts: '2026-05-14T00:00:00Z' }) + '\n',
      'utf8',
    );
    const read = await readFullSimHistory(tmp);
    // Two valid entries; the malformed one is skipped.
    expect(read).toHaveLength(2);
    expect(read[0]!.ts).toBe('2026-05-13T22:30:00Z');
    expect(read[1]!.ts).toBe('2026-05-14T00:00:00Z');
  });
});
