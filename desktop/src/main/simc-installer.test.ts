import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findSevenZip, installSimc, KNOWN_SEVEN_ZIP_PATHS } from './simc-installer';
import type { SimcVersionInfo } from './simc-version-source';

let installRoot: string;

beforeEach(() => {
  installRoot = mkdtempSync(join(tmpdir(), 'simly-installer-'));
});

afterEach(() => {
  rmSync(installRoot, { recursive: true, force: true });
});

const fakeVersion: SimcVersionInfo = {
  tag: '1205.01.d6f091a',
  patch: '1205.01',
  gitHash: 'd6f091a',
  filename: 'simc-1205.01.d6f091a-win64.7z',
  downloadUrl: 'http://example.test/simc-1205.01.d6f091a-win64.7z',
  publishedAt: new Date('2026-05-01T06:19:00Z'),
};

describe('installSimc', () => {
  it('skips download/extract when the versioned dir already has simc.exe', async () => {
    const versionedDir = join(installRoot, 'simc-1205.01.d6f091a-win64');
    mkdirSync(versionedDir, { recursive: true });
    writeFileSync(join(versionedDir, 'simc.exe'), 'pretend-binary-content');

    const download = vi.fn();
    const extract = vi.fn();

    const result = await installSimc({
      installRoot,
      version: fakeVersion,
      download,
      extract,
    });

    expect(result.installedNew).toBe(false);
    expect(result.binPath).toBe(join(versionedDir, 'simc.exe'));
    expect(download).not.toHaveBeenCalled();
    expect(extract).not.toHaveBeenCalled();
  });

  it('downloads then extracts when nothing is on disk', async () => {
    let downloadedTo: string | undefined;
    let extractedFrom: string | undefined;
    const download = vi.fn(async (_url: string, dest: string) => {
      downloadedTo = dest;
      writeFileSync(dest, 'fake-archive-bytes');
    });
    const extract = vi.fn(async (archive: string, destRoot: string) => {
      extractedFrom = archive;
      const versionedDir = join(destRoot, 'simc-1205.01.d6f091a-win64');
      mkdirSync(versionedDir, { recursive: true });
      writeFileSync(join(versionedDir, 'simc.exe'), 'fake-binary');
    });

    const result = await installSimc({
      installRoot,
      version: fakeVersion,
      download,
      extract,
    });

    expect(result.installedNew).toBe(true);
    expect(result.binPath).toBe(
      join(installRoot, 'simc-1205.01.d6f091a-win64', 'simc.exe'),
    );
    expect(downloadedTo).toBe(join(installRoot, fakeVersion.filename));
    expect(extractedFrom).toBe(join(installRoot, fakeVersion.filename));
  });

  it('removes the .7z after a successful extract', async () => {
    const archivePath = join(installRoot, fakeVersion.filename);
    const download = async (_url: string, dest: string) => {
      writeFileSync(dest, 'archive-bytes');
    };
    const extract = async (_archive: string, destRoot: string) => {
      const versionedDir = join(destRoot, 'simc-1205.01.d6f091a-win64');
      mkdirSync(versionedDir, { recursive: true });
      writeFileSync(join(versionedDir, 'simc.exe'), 'binary');
    };

    await installSimc({ installRoot, version: fakeVersion, download, extract });
    expect(existsSync(archivePath)).toBe(false);
  });

  it('removes the .7z even when extraction fails', async () => {
    const archivePath = join(installRoot, fakeVersion.filename);
    const download = async (_url: string, dest: string) => {
      writeFileSync(dest, 'archive-bytes');
    };
    const extract = async () => {
      throw new Error('fake 7z failure');
    };

    await expect(
      installSimc({ installRoot, version: fakeVersion, download, extract }),
    ).rejects.toThrow(/fake 7z failure/);
    expect(existsSync(archivePath)).toBe(false);
  });

  it('throws a descriptive error when extraction succeeds but simc.exe is missing', async () => {
    const download = async (_url: string, dest: string) => {
      writeFileSync(dest, 'archive-bytes');
    };
    const extract = async (_archive: string, destRoot: string) => {
      // Extract creates the dir but not the exe (e.g. archive layout shifted)
      const versionedDir = join(destRoot, 'simc-1205.01.d6f091a-win64');
      mkdirSync(versionedDir, { recursive: true });
    };

    await expect(
      installSimc({ installRoot, version: fakeVersion, download, extract }),
    ).rejects.toThrow(/Extraction completed but .* is missing/);
  });

  it('treats a zero-byte simc.exe as missing and re-downloads', async () => {
    const versionedDir = join(installRoot, 'simc-1205.01.d6f091a-win64');
    mkdirSync(versionedDir, { recursive: true });
    writeFileSync(join(versionedDir, 'simc.exe'), '');

    let downloaded = false;
    const download = async (_url: string, dest: string) => {
      downloaded = true;
      writeFileSync(dest, 'archive');
    };
    const extract = async (_archive: string, destRoot: string) => {
      const dir = join(destRoot, 'simc-1205.01.d6f091a-win64');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'simc.exe'), 'real-binary');
    };

    const result = await installSimc({
      installRoot,
      version: fakeVersion,
      download,
      extract,
    });
    expect(downloaded).toBe(true);
    expect(result.installedNew).toBe(true);
  });
});

describe('findSevenZip', () => {
  it('returns the first candidate that exists on disk', () => {
    // Use installRoot as a stand-in for a "found 7z.exe" — write a fake one
    // and place it ahead in the candidate list.
    const fake = join(installRoot, '7z.exe');
    writeFileSync(fake, 'fake');
    expect(findSevenZip([fake, '/definitely/does/not/exist.exe'])).toBe(fake);
  });

  it('throws a descriptive error when no candidate exists', () => {
    expect(() =>
      findSevenZip(['/nope/1.exe', '/nope/2.exe']),
    ).toThrow(/7-Zip not found/);
  });

  it('default candidate list includes the standard Program Files install', () => {
    expect(KNOWN_SEVEN_ZIP_PATHS).toContain('C:\\Program Files\\7-Zip\\7z.exe');
  });
});
