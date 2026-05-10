import { describe, expect, it } from 'vitest';
// @ts-expect-error — .mjs source imported directly for the pure-helpers
// tests. The script lives at desktop/scripts/check-wow-symlink.mjs.
import {
  compareSymlinkTarget,
  resolveExpectedAddonPath,
  DEFAULT_WOW_ADDON_PATHS,
} from './check-wow-symlink.mjs';

describe('compareSymlinkTarget', () => {
  it('returns "match" for identical paths', () => {
    expect(
      compareSymlinkTarget(
        'C:\\Users\\dev\\repo\\addon',
        'C:\\Users\\dev\\repo\\addon',
      ),
    ).toBe('match');
  });

  it('is case-insensitive (Windows path semantics)', () => {
    expect(
      compareSymlinkTarget(
        'C:\\Users\\Dev\\Repo\\addon',
        'c:\\users\\dev\\repo\\addon',
      ),
    ).toBe('match');
  });

  it('treats forward and backward slashes as equivalent', () => {
    expect(
      compareSymlinkTarget('C:/Users/dev/repo/addon', 'C:\\Users\\dev\\repo\\addon'),
    ).toBe('match');
  });

  it('strips trailing slashes before comparing', () => {
    expect(
      compareSymlinkTarget('C:\\Users\\dev\\repo\\addon\\', 'C:\\Users\\dev\\repo\\addon'),
    ).toBe('match');
    expect(
      compareSymlinkTarget('C:\\Users\\dev\\repo\\addon', 'C:\\Users\\dev\\repo\\addon/'),
    ).toBe('match');
  });

  it('returns "mismatch" when target is a different worktree', () => {
    // The footgun this whole script exists to catch.
    expect(
      compareSymlinkTarget(
        'C:\\Users\\dev\\repo\\.claude\\worktrees\\stale-branch\\addon',
        'C:\\Users\\dev\\repo\\.claude\\worktrees\\active-branch\\addon',
      ),
    ).toBe('mismatch');
  });

  it('returns "mismatch" for any non-equal pair', () => {
    expect(compareSymlinkTarget('C:\\foo', 'C:\\bar')).toBe('mismatch');
  });
});

describe('resolveExpectedAddonPath', () => {
  it('walks up two directories from the script dir to reach the addon dir', () => {
    // Script at <repo>/desktop/scripts/check-wow-symlink.mjs
    // Two levels up = <repo>, then /addon
    const result = resolveExpectedAddonPath(
      'C:\\Users\\dev\\Simly\\desktop\\scripts',
    );
    // Use .toLowerCase() because path.resolve normalizes case differently
    // across implementations.
    expect(result.toLowerCase()).toBe('c:\\users\\dev\\simly\\addon');
  });

  it('handles trailing separator on the script dir input', () => {
    const result = resolveExpectedAddonPath(
      'C:\\Users\\dev\\Simly\\desktop\\scripts\\',
    );
    expect(result.toLowerCase()).toBe('c:\\users\\dev\\simly\\addon');
  });
});

describe('DEFAULT_WOW_ADDON_PATHS', () => {
  it('lists the 32-bit Program Files path before the 64-bit one', () => {
    // Battle.net installs WoW into Program Files (x86) by default; check
    // it first to avoid a false negative when only the legacy path exists.
    expect(DEFAULT_WOW_ADDON_PATHS[0]).toContain('Program Files (x86)');
    expect(DEFAULT_WOW_ADDON_PATHS[1]).not.toContain('(x86)');
  });

  it('targets the retail Simly addon dir', () => {
    for (const p of DEFAULT_WOW_ADDON_PATHS) {
      expect(p).toContain('_retail_\\Interface\\AddOns\\Simly');
    }
  });
});
