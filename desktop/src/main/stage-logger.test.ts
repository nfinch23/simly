import { describe, expect, it, vi } from 'vitest';
import {
  formatRelative,
  isInterestingSimcLine,
  INTERESTING_SIMC_PATTERNS,
  terminalTitle,
} from './stage-logger';

describe('formatRelative', () => {
  it('returns "(unknown)" for falsy input', () => {
    expect(formatRelative(0)).toBe('(unknown)');
  });

  it('formats < 60s as "Ns ago"', () => {
    const now = Math.floor(Date.now() / 1000);
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    expect(formatRelative(now - 5)).toBe('5s ago');
    expect(formatRelative(now - 59)).toBe('59s ago');
    vi.restoreAllMocks();
  });

  it('formats 1-59 minutes as "Nm ago"', () => {
    const now = Math.floor(Date.now() / 1000);
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    expect(formatRelative(now - 60)).toBe('1m ago');
    expect(formatRelative(now - 65)).toBe('1m ago');
    expect(formatRelative(now - 600)).toBe('10m ago');
    vi.restoreAllMocks();
  });

  it('formats 1+ hours as "Nh ago"', () => {
    const now = Math.floor(Date.now() / 1000);
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    expect(formatRelative(now - 3600)).toBe('1h ago');
    expect(formatRelative(now - 7200)).toBe('2h ago');
    vi.restoreAllMocks();
  });

  it('formats 1+ days as "Nd ago"', () => {
    const now = Math.floor(Date.now() / 1000);
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    expect(formatRelative(now - 86_400)).toBe('1d ago');
    expect(formatRelative(now - 86_400 * 3)).toBe('3d ago');
    vi.restoreAllMocks();
  });
});

describe('isInterestingSimcLine', () => {
  it('matches SimC progress markers', () => {
    expect(isInterestingSimcLine('Generating Baseline: 1/2 [...]')).toBe(true);
    expect(isInterestingSimcLine('Generating Profile Set 5/100')).toBe(true);
    expect(isInterestingSimcLine('Profileset 23/864')).toBe(true);
  });

  it('matches Iteration / report / done lines', () => {
    expect(isInterestingSimcLine('Iteration: 500/1000')).toBe(true);
    expect(isInterestingSimcLine('Generating reports...')).toBe(true);
    expect(isInterestingSimcLine('Done')).toBe(true);
  });

  it('matches percentage progress markers', () => {
    expect(isInterestingSimcLine('  [ 42% ]')).toBe(true);
    expect(isInterestingSimcLine('[ 100.0% ]')).toBe(true);
  });

  it('matches errors and warnings', () => {
    expect(isInterestingSimcLine('Error: something broke')).toBe(true);
    expect(isInterestingSimcLine('warning: deprecated')).toBe(true);
  });

  it('matches "X seconds" timing lines', () => {
    expect(isInterestingSimcLine('  300 seconds')).toBe(true);
    expect(isInterestingSimcLine('5 second')).toBe(true);
  });

  it('does NOT match banner / boilerplate lines', () => {
    expect(isInterestingSimcLine('SimulationCraft 1205-01 for World of Warcraft')).toBe(false);
    expect(isInterestingSimcLine('Build Date: 2026-05-04')).toBe(false);
    expect(isInterestingSimcLine('')).toBe(false);
    expect(isInterestingSimcLine('--- Player Character: Felfriend ---')).toBe(false);
  });

  it('exposes the pattern array for inspection', () => {
    expect(INTERESTING_SIMC_PATTERNS.length).toBeGreaterThan(0);
    expect(INTERESTING_SIMC_PATTERNS[0]).toBeInstanceOf(RegExp);
  });
});

describe('terminalTitle', () => {
  it('returns "Up to date" for ok outcome', () => {
    expect(terminalTitle('ok', 'Felfriend-Zuljin')).toBe(
      'Simly — Up to date (Felfriend-Zuljin)',
    );
  });

  it('returns "Scan failed" for failed outcome', () => {
    expect(terminalTitle('failed', 'Felfriend-Zuljin')).toBe(
      'Simly — Scan failed (Felfriend-Zuljin)',
    );
  });

  it('handles empty character key (unhandled-throw degenerate case)', () => {
    expect(terminalTitle('failed', '')).toBe('Simly — Scan failed ()');
  });
});
