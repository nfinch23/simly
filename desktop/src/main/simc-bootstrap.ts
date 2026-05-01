import { existsSync } from 'node:fs';
import { resolveSimcPaths, findLatestSimcBinary } from './simc-paths';
import {
  LatestNightlyStrategy,
  type SimcVersionInfo,
  type SimcVersionSource,
} from './simc-version-source';
import { installSimc, type InstalledSimc } from './simc-installer';

export interface BootstrapResult {
  binPath: string;
  installRoot: string;
  scratchDir: string;
  /** When auto-update succeeded, this carries provenance. Undefined if we used what was already on disk. */
  installedVersion?: SimcVersionInfo;
  /** True when this boot triggered an actual download + extract. */
  installedNew: boolean;
  /** Human-readable note about how we got here, useful for the boot log. */
  source: 'auto-installed' | 'already-installed' | 'preexisting-on-disk' | 'fallback-no-network';
}

export interface BootstrapOptions {
  versionSource?: SimcVersionSource;
  /** Override the install root for tests. */
  installRoot?: string;
  /** Override the scratch dir for tests. */
  scratchDir?: string;
}

/**
 * Bring up the SimC environment before the watcher starts. We:
 *
 *   1. Resolve which version we _should_ be on via the version source
 *      (default: LatestNightlyStrategy — picks the most recent Win64
 *      nightly from downloads.simulationcraft.org).
 *   2. Install it via simc-installer.installSimc() — which is idempotent,
 *      so a fresh boot with the right version already on disk is a no-op
 *      that returns immediately.
 *   3. If the network call or install fails, fall back to whatever
 *      versioned simc.exe is already in the install root. This keeps the
 *      app usable offline as long as you've installed at least once.
 *
 * Result includes the binPath the runner should use plus a boot-log
 * `source` flag so we can tell at a glance whether we just downloaded a
 * new version or used what was on disk.
 */
export async function bootstrapSimc(opts: BootstrapOptions = {}): Promise<BootstrapResult> {
  const paths = resolveSimcPaths({
    installRoot: opts.installRoot,
    scratchDir: opts.scratchDir,
  });
  const versionSource = opts.versionSource ?? new LatestNightlyStrategy();

  let resolved: SimcVersionInfo | undefined;
  try {
    resolved = await versionSource.resolveCurrent();
  } catch (err) {
    console.error('[bootstrap] version source failed:', (err as Error).message);
  }

  if (resolved) {
    try {
      const installed = await installSimc({
        installRoot: paths.installRoot,
        version: resolved,
      });
      return finalize(installed, paths.scratchDir);
    } catch (err) {
      console.error('[bootstrap] installSimc failed:', (err as Error).message);
    }
  }

  // Fallback: use whatever simc.exe is already on disk.
  const existingBin = findLatestSimcBinary(paths.installRoot);
  if (existsSync(existingBin)) {
    return {
      binPath: existingBin,
      installRoot: paths.installRoot,
      scratchDir: paths.scratchDir,
      installedNew: false,
      source: resolved ? 'preexisting-on-disk' : 'fallback-no-network',
    };
  }

  throw new Error(
    `Cannot bootstrap SimC: version source failed, fallback found no existing binary at ${existingBin}. ` +
      'Install once with internet access, or drop a build into the install root manually.',
  );
}

function finalize(installed: InstalledSimc, scratchDir: string): BootstrapResult {
  return {
    binPath: installed.binPath,
    installRoot: installed.versionedDir.replace(/[\\/][^\\/]+$/, ''),
    scratchDir,
    installedVersion: installed.version,
    installedNew: installed.installedNew,
    source: installed.installedNew ? 'auto-installed' : 'already-installed',
  };
}
