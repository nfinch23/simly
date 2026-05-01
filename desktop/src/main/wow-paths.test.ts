import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWowPaths } from './wow-paths';

describe('resolveWowPaths', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-paths-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('throws when the retail folder is missing', () => {
    expect(() => resolveWowPaths({ retailRoot: join(root, 'nope') })).toThrow(
      /retail folder not found/,
    );
  });

  it('throws when WTF/Account is missing', () => {
    expect(() => resolveWowPaths({ retailRoot: root })).toThrow(
      /WTF[\\/]Account/,
    );
  });

  it('detects a single account folder', () => {
    mkdirSync(join(root, 'WTF', 'Account', '12345678#1'), { recursive: true });
    const paths = resolveWowPaths({ retailRoot: root });
    expect(paths.account).toBe('12345678#1');
    expect(paths.savedVarsPath).toContain('12345678#1');
    expect(paths.savedVarsPath).toContain('Simly.lua');
    expect(paths.resultsLuaPath).toContain('SimlyResults');
  });

  it('ignores the SavedVariables sibling under Account', () => {
    mkdirSync(join(root, 'WTF', 'Account', '12345678#1'), { recursive: true });
    mkdirSync(join(root, 'WTF', 'Account', 'SavedVariables'), { recursive: true });
    const paths = resolveWowPaths({ retailRoot: root });
    expect(paths.account).toBe('12345678#1');
  });

  it('picks the first lexicographically when multiple accounts exist', () => {
    mkdirSync(join(root, 'WTF', 'Account', '12345678#1'), { recursive: true });
    mkdirSync(join(root, 'WTF', 'Account', '99999999#1'), { recursive: true });
    const paths = resolveWowPaths({ retailRoot: root });
    expect(paths.account).toBe('12345678#1');
  });
});
