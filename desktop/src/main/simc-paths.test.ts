import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findLatestSimcBinary } from './simc-paths';

let installRoot: string;

beforeEach(() => {
  installRoot = mkdtempSync(join(tmpdir(), 'simly-simc-paths-'));
});

afterEach(() => {
  rmSync(installRoot, { recursive: true, force: true });
});

function dropVersionDir(name: string, opts?: { withExe?: boolean; mtime?: Date }) {
  const dir = join(installRoot, name);
  mkdirSync(dir, { recursive: true });
  if (opts?.withExe ?? true) {
    writeFileSync(join(dir, 'simc.exe'), 'fake');
  }
  if (opts?.mtime) {
    utimesSync(dir, opts.mtime, opts.mtime);
  }
}

describe('findLatestSimcBinary', () => {
  it('returns a sentinel current/simc.exe path when install root does not exist', () => {
    rmSync(installRoot, { recursive: true, force: true });
    const result = findLatestSimcBinary(installRoot);
    expect(result).toBe(join(installRoot, 'current', 'simc.exe'));
  });

  it('returns the same sentinel when install root has no matching versioned dirs', () => {
    mkdirSync(join(installRoot, 'random-folder'), { recursive: true });
    writeFileSync(join(installRoot, 'simc-readme.txt'), 'noise');
    const result = findLatestSimcBinary(installRoot);
    expect(result).toBe(join(installRoot, 'current', 'simc.exe'));
  });

  it('picks the only versioned dir when one exists', () => {
    dropVersionDir('simc-1205.01.d6f091a-win64');
    expect(findLatestSimcBinary(installRoot)).toBe(
      join(installRoot, 'simc-1205.01.d6f091a-win64', 'simc.exe'),
    );
  });

  it('picks the most-recently-modified versioned dir when multiple exist', () => {
    dropVersionDir('simc-1100.01.aef33c4-win64', { mtime: new Date(2025, 5, 1) });
    dropVersionDir('simc-1205.01.d6f091a-win64', { mtime: new Date(2026, 4, 30) });
    dropVersionDir('simc-1115.02.4739a41-win64', { mtime: new Date(2025, 10, 15) });
    expect(findLatestSimcBinary(installRoot)).toBe(
      join(installRoot, 'simc-1205.01.d6f091a-win64', 'simc.exe'),
    );
  });

  it('skips versioned dirs that lack simc.exe', () => {
    dropVersionDir('simc-1205.01.d6f091a-win64', {
      withExe: false,
      mtime: new Date(2026, 4, 30),
    });
    dropVersionDir('simc-1100.01.aef33c4-win64', {
      withExe: true,
      mtime: new Date(2025, 5, 1),
    });
    expect(findLatestSimcBinary(installRoot)).toBe(
      join(installRoot, 'simc-1100.01.aef33c4-win64', 'simc.exe'),
    );
  });

  it('ignores dirs that do not match the simc-*-win64 pattern', () => {
    dropVersionDir('simc-foo-bar', { mtime: new Date(2026, 4, 30) });
    dropVersionDir('simc-1100.01.aef33c4-win64', { mtime: new Date(2025, 5, 1) });
    expect(findLatestSimcBinary(installRoot)).toBe(
      join(installRoot, 'simc-1100.01.aef33c4-win64', 'simc.exe'),
    );
  });
});
