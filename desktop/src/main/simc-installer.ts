import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import type { SimcVersionInfo } from './simc-version-source';

export interface InstalledSimc {
  binPath: string;
  versionedDir: string;
  version: SimcVersionInfo;
  /** False if the versioned dir was already present and we did nothing. */
  installedNew: boolean;
}

export type BinaryDownloader = (url: string, dest: string) => Promise<void>;
export type ArchiveExtractor = (archivePath: string, destRoot: string) => Promise<void>;

export interface InstallSimcOptions {
  installRoot: string;
  version: SimcVersionInfo;
  /** Override for tests; default downloads via global fetch. */
  download?: BinaryDownloader;
  /** Override for tests; default shells out to 7-Zip. */
  extract?: ArchiveExtractor;
}

/**
 * Ensure the SimC version described by `version` is unpacked under
 * `installRoot`. The .7z naming embeds the version, so the unpacked
 * folder name is deterministic — if it already exists with a simc.exe,
 * we skip the network round-trip entirely.
 *
 * If we do install, the .7z is staged in installRoot and removed after a
 * successful extraction.
 */
export async function installSimc(opts: InstallSimcOptions): Promise<InstalledSimc> {
  const { installRoot, version } = opts;
  const download = opts.download ?? defaultDownload;
  const extract = opts.extract ?? defaultExtract;

  await mkdir(installRoot, { recursive: true });

  const versionedDirName = version.filename.replace(/\.7z$/, '');
  const versionedDir = join(installRoot, versionedDirName);
  const binPath = join(versionedDir, 'simc.exe');

  if (existsSync(binPath) && statSync(binPath).size > 0) {
    return { binPath, versionedDir, version, installedNew: false };
  }

  const archivePath = join(installRoot, version.filename);
  await download(version.downloadUrl, archivePath);
  try {
    await extract(archivePath, installRoot);
  } finally {
    // Best-effort cleanup; archive is large and we have no further use.
    await rm(archivePath, { force: true });
  }

  if (!existsSync(binPath)) {
    throw new Error(
      `Extraction completed but ${binPath} is missing. The archive layout may have changed.`,
    );
  }

  return { binPath, versionedDir, version, installedNew: true };
}

const defaultDownload: BinaryDownloader = async (url, dest) => {
  const res = await fetch(url, {
    headers: { 'user-agent': 'simly/0.0 (+https://github.com/nfinch23/simly)' },
  });
  if (!res.ok || !res.body) {
    throw new Error(`download ${url} failed: ${res.status} ${res.statusText}`);
  }
  await mkdir(join(dest, '..'), { recursive: true });
  // Node's fetch returns a web ReadableStream; convert and pipe to disk.
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest));
};

/** Common 7-Zip install paths on Windows. */
export const KNOWN_SEVEN_ZIP_PATHS: readonly string[] = [
  'C:\\Program Files\\7-Zip\\7z.exe',
  'C:\\Program Files (x86)\\7-Zip\\7z.exe',
  'C:\\ProgramData\\chocolatey\\bin\\7z.exe',
];

export function findSevenZip(candidates: readonly string[] = KNOWN_SEVEN_ZIP_PATHS): string {
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    `7-Zip not found at any known install path (${candidates.join(', ')}). ` +
      'Install 7-Zip from https://www.7-zip.org/download.html or set the path in Settings (TODO Phase 5).',
  );
}

const defaultExtract: ArchiveExtractor = async (archivePath, destRoot) => {
  const sevenZip = findSevenZip();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(sevenZip, ['x', archivePath, `-o${destRoot}`, '-y'], {
      windowsHide: true,
    });
    child.stdout.on('data', (c: Buffer) => stdout.push(c.toString()));
    child.stderr.on('data', (c: Buffer) => stderr.push(c.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? -1));
  });
  if (exitCode !== 0) {
    throw new Error(
      `7z exited with code ${exitCode}.\nstderr:\n${stderr.join('').slice(-1500)}\nstdout tail:\n${stdout.join('').slice(-500)}`,
    );
  }
};

/** Convenience: write a marker file so we can ignore archives left over from a crashed install. */
export async function writeInstallMarker(installRoot: string, version: SimcVersionInfo): Promise<void> {
  await writeFile(
    join(installRoot, '.last-install.json'),
    JSON.stringify({ version: version.tag, installedAt: new Date().toISOString() }, null, 2),
    'utf8',
  );
}
