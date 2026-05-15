import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureHeartbeatToc,
  formatHeartbeatLua,
  HEARTBEAT_FILENAME,
  HEARTBEAT_TOC_LINE,
  startHeartbeat,
} from './heartbeat';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'simly-heartbeat-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('formatHeartbeatLua', () => {
  it('emits a plain Lua global assignment with alive_at / started_at / version', () => {
    const out = formatHeartbeatLua({ aliveAt: 1714435200, startedAt: 1714435000, version: '0.1.0' });
    expect(out).toContain('SimlyHeartbeat = {');
    expect(out).toContain('alive_at = 1714435200,');
    expect(out).toContain('started_at = 1714435000,');
    expect(out).toContain('version = "0.1.0",');
  });

  it('quotes the version safely so a quote in the value cannot break the Lua', () => {
    const out = formatHeartbeatLua({ aliveAt: 1, startedAt: 1, version: 'evil"quote' });
    // JSON.stringify escapes the inner quote; the Lua loader will see
    // a well-formed string with a literal quote inside.
    expect(out).toContain('version = "evil\\"quote",');
  });
});

describe('startHeartbeat', () => {
  it('writes SimlyHeartbeat.lua immediately on start', async () => {
    const hb = startHeartbeat({
      resultsAddonDir: dir,
      version: 'test-0.0.0',
      intervalMs: 60_000, // doesn't matter; we only check the initial write
    });
    await hb.ready;
    hb.stop();
    const path = join(dir, HEARTBEAT_FILENAME);
    expect(existsSync(path)).toBe(true);
    const lua = readFileSync(path, 'utf8');
    expect(lua).toContain('SimlyHeartbeat = {');
    expect(lua).toContain('version = "test-0.0.0",');
  });

  it('stop() is idempotent', async () => {
    const hb = startHeartbeat({ resultsAddonDir: dir, version: '0' });
    await hb.ready;
    hb.stop();
    expect(() => hb.stop()).not.toThrow();
  });
});

describe('ensureHeartbeatToc', () => {
  const tocPath = (): string => join(dir, 'SimlyResults.toc');

  it('returns false when the toc does not exist', () => {
    expect(ensureHeartbeatToc(tocPath())).toBe(false);
  });

  it('appends the heartbeat line when missing', () => {
    writeFileSync(
      tocPath(),
      '## Interface: 120005\n## Title: Simly Results\n\nSimlyResults.lua\n',
      'utf8',
    );
    expect(ensureHeartbeatToc(tocPath())).toBe(true);
    const after = readFileSync(tocPath(), 'utf8');
    expect(after).toContain(HEARTBEAT_TOC_LINE);
    // Original content still present.
    expect(after).toContain('SimlyResults.lua');
  });

  it('returns false when the heartbeat line is already present (idempotent)', () => {
    writeFileSync(
      tocPath(),
      '## Interface: 120005\n\nSimlyResults.lua\nSimlyHeartbeat.lua\n',
      'utf8',
    );
    expect(ensureHeartbeatToc(tocPath())).toBe(false);
  });

  it('matches the bare line only, not substrings inside another filename', () => {
    writeFileSync(
      tocPath(),
      '## Interface: 120005\n\nSimlyResults.lua\nMySimlyHeartbeat.lua.bak\n',
      'utf8',
    );
    // The .bak line should NOT count as a match.
    expect(ensureHeartbeatToc(tocPath())).toBe(true);
  });
});
