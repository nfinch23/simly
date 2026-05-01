import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bootstrapSimc } from './simc-bootstrap';
import type { SimcVersionInfo, SimcVersionSource } from './simc-version-source';

let installRoot: string;
let scratchDir: string;

beforeEach(() => {
  installRoot = mkdtempSync(join(tmpdir(), 'simly-bootstrap-'));
  scratchDir = mkdtempSync(join(tmpdir(), 'simly-bootstrap-scratch-'));
});

afterEach(() => {
  rmSync(installRoot, { recursive: true, force: true });
  rmSync(scratchDir, { recursive: true, force: true });
});

const fakeVersion: SimcVersionInfo = {
  tag: '1205.01.d6f091a',
  patch: '1205.01',
  gitHash: 'd6f091a',
  filename: 'simc-1205.01.d6f091a-win64.7z',
  downloadUrl: 'http://example.test/simc.7z',
  publishedAt: new Date('2026-05-01T06:19:00Z'),
};

function fakeSource(version: SimcVersionInfo): SimcVersionSource {
  return { resolveCurrent: async () => version };
}

function failingSource(reason: string): SimcVersionSource {
  return {
    resolveCurrent: async () => {
      throw new Error(reason);
    },
  };
}

function dropExistingBinary(): string {
  const versionedDir = join(installRoot, fakeVersion.filename.replace(/\.7z$/, ''));
  mkdirSync(versionedDir, { recursive: true });
  const bin = join(versionedDir, 'simc.exe');
  writeFileSync(bin, 'pretend-binary');
  return bin;
}

describe('bootstrapSimc', () => {
  it('reports already-installed when the binary is on disk for the resolved version', async () => {
    const expectedBin = dropExistingBinary();

    const result = await bootstrapSimc({
      versionSource: fakeSource(fakeVersion),
      installRoot,
      scratchDir,
    });

    expect(result.source).toBe('already-installed');
    expect(result.installedNew).toBe(false);
    expect(result.binPath).toBe(expectedBin);
    expect(result.installedVersion?.tag).toBe(fakeVersion.tag);
  });

  it('falls back to existing on-disk binary when the version source fails', async () => {
    const expectedBin = dropExistingBinary();

    const result = await bootstrapSimc({
      versionSource: failingSource('network down'),
      installRoot,
      scratchDir,
    });

    expect(result.source).toBe('fallback-no-network');
    expect(result.installedNew).toBe(false);
    expect(result.binPath).toBe(expectedBin);
    expect(result.installedVersion).toBeUndefined();
  });

  it('throws when both version source AND fallback come up empty', async () => {
    await expect(
      bootstrapSimc({
        versionSource: failingSource('no network'),
        installRoot,
        scratchDir,
      }),
    ).rejects.toThrow(/Cannot bootstrap SimC/);
  });

  it('uses default LatestNightlyStrategy when no source override is given', async () => {
    // Drop a binary so the fallback path resolves it. Stub fetch so the
    // default strategy can't reach the real internet — keeps CI offline.
    const expectedBin = dropExistingBinary();
    const fetchStub = vi.fn(async () => {
      throw new Error('network disabled in test');
    });
    vi.stubGlobal('fetch', fetchStub);
    try {
      const result = await bootstrapSimc({ installRoot, scratchDir });
      expect(result.binPath).toBe(expectedBin);
      expect(result.source).toBe('fallback-no-network');
      expect(fetchStub).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
