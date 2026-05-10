#!/usr/bin/env node
/**
 * Pre-flight check that catches a Conductor-worktree footgun:
 *
 *   The WoW client reads addons from `Interface/AddOns/Simly/`, typically
 *   set up as a directory junction pointing into our repo's `addon/` dir.
 *   When the user creates a new Conductor worktree (each branch lives in
 *   its own copy of the repo), the junction silently keeps pointing at
 *   the OLD worktree. /reload in WoW then loads stale Lua, and there's
 *   no warning anywhere — the dev wonders why their addon edits aren't
 *   taking effect. We lost a multi-hour debug session to this once.
 *
 * Solution: every `npm run dev` (via the predev hook) probes the WoW
 * addons folder, reads the symlink target, and warns when it points
 * somewhere other than THIS worktree's addon dir.
 *
 * Non-fatal — startup proceeds either way. The warning is loud enough
 * to catch the dev's eye before they spend an hour debugging.
 *
 * Skipped silently on non-Windows (the gotcha doesn't exist on macOS/Linux).
 * Skipped silently when no Simly addon entry exists (user might not have
 * WoW installed, or might just not be testing the addon side today).
 */

import { existsSync } from 'node:fs';
import { readlink } from 'node:fs/promises';
import { dirname, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Default WoW addons paths to probe, in order. Returns the first one
 * that exists on disk, or undefined. Exposed for testability.
 */
export const DEFAULT_WOW_ADDON_PATHS = [
  'C:\\Program Files (x86)\\World of Warcraft\\_retail_\\Interface\\AddOns\\Simly',
  'C:\\Program Files\\World of Warcraft\\_retail_\\Interface\\AddOns\\Simly',
];

/**
 * Pure comparison helper. Returns 'match' when target points at the
 * expected dir, 'mismatch' otherwise. Case-insensitive (Windows path
 * comparison) with normalized separators and trailing-slash trimmed.
 */
export function compareSymlinkTarget(target, expected) {
  const norm = (p) => normalize(p).toLowerCase().replace(/[\\/]+$/, '');
  return norm(target) === norm(expected) ? 'match' : 'mismatch';
}

/**
 * Resolve THIS worktree's addon directory by walking up from the
 * script's location: `<repo>/desktop/scripts/check-wow-symlink.mjs`
 *  → `<repo>/addon`. Pure — exposed for testability.
 */
export function resolveExpectedAddonPath(scriptDir) {
  return resolve(scriptDir, '..', '..', 'addon');
}

/**
 * Find the first WoW addons path that exists on disk. Returns
 * undefined if none found.
 */
function findWowAddonPath(candidates) {
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return undefined;
}

function printMismatchWarning({ symlinkPath, target, expected }) {
  const repointCommand =
    `powershell -NoProfile -Command "Remove-Item '${symlinkPath}' -Force; New-Item -ItemType Junction -Path '${symlinkPath}' -Target '${expected}'"`;
  console.warn('');
  console.warn('⚠  WARNING: WoW addon symlink points at a different worktree.');
  console.warn(`   Expected: ${expected}`);
  console.warn(`   Actual:   ${target}`);
  console.warn('');
  console.warn('   The WoW client will load the OLD addon code from the wrong worktree.');
  console.warn("   /reload in-game won't pick up changes you make on this branch.");
  console.warn('');
  console.warn('   Fix:');
  console.warn(`     ${repointCommand}`);
  console.warn('');
}

async function main() {
  // Skip on non-Windows — the junction-staleness footgun is Windows-only.
  if (process.platform !== 'win32') return;

  const expected = resolveExpectedAddonPath(__dirname);
  const symlinkPath = findWowAddonPath(DEFAULT_WOW_ADDON_PATHS);
  if (!symlinkPath) {
    // No WoW install (or no Simly entry yet) — totally fine.
    return;
  }

  let target;
  try {
    target = await readlink(symlinkPath);
  } catch (err) {
    // Could be a real directory (not a symlink), permission denied, or
    // a junction the runtime can't read. Don't block startup; log a hint.
    console.warn(
      `[symlink-check] Could not read ${symlinkPath} as a symlink: ${err.message}. ` +
      'If this is a regular directory, replace it with a junction pointing at ' +
      `${expected}.`,
    );
    return;
  }

  if (compareSymlinkTarget(target, expected) === 'match') {
    // All good. Stay silent.
    return;
  }

  printMismatchWarning({ symlinkPath, target, expected });
}

// ESM module: only run main when invoked directly, not when imported by tests.
const isMainModule =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((err) => {
    console.warn(`[symlink-check] Unexpected error: ${err.message}`);
  });
}
