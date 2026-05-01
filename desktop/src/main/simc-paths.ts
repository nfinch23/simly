import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface SimcPaths {
  binPath: string;
  scratchDir: string;
  installRoot: string;
}

/**
 * Resolve the SimC install layout under %LOCALAPPDATA%/Simly/.
 *
 * Layout we expect after the Phase 2b installer lands:
 *   simc/
 *     simc-<patch>.<minor>.<hash>-win64/
 *       simc.exe
 *     ...older versions...
 *
 * We pick the most-recently-modified versioned directory rather than
 * relying on a `current` junction — Node's `existsSync` flat-out refuses
 * to follow junctions created via `mklink /J` in some environments
 * (returns false even when the target is reachable). Scanning sidesteps
 * the bug entirely and lets the future installer just drop new versions
 * without touching anything else.
 */
export function resolveSimcPaths(override?: Partial<SimcPaths>): SimcPaths {
  const localAppData = process.env['LOCALAPPDATA'];
  if (!localAppData) {
    throw new Error('LOCALAPPDATA env var not set; cannot resolve SimC paths');
  }
  const simlyRoot = join(localAppData, 'Simly');
  const installRoot = override?.installRoot ?? join(simlyRoot, 'simc');
  const scratchDir = override?.scratchDir ?? join(simlyRoot, 'scratch');

  const binPath = override?.binPath ?? findLatestSimcBinary(installRoot);
  return { binPath, scratchDir, installRoot };
}

export function findLatestSimcBinary(installRoot: string): string {
  if (!existsSync(installRoot)) {
    return join(installRoot, 'current', 'simc.exe');
  }
  const candidates: Array<{ name: string; mtimeMs: number }> = [];
  for (const name of readdirSync(installRoot)) {
    if (!name.startsWith('simc-') || !name.endsWith('-win64')) continue;
    const exe = join(installRoot, name, 'simc.exe');
    if (!existsSync(exe)) continue;
    candidates.push({ name, mtimeMs: statSync(join(installRoot, name)).mtimeMs });
  }
  if (candidates.length === 0) {
    return join(installRoot, 'current', 'simc.exe');
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return join(installRoot, candidates[0]!.name, 'simc.exe');
}
