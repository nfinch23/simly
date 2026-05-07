import { describe, expect, it } from 'vitest';
import {
  buildDiagnosticEntry,
  formatDiagnosticLine,
  formatDiagnosticSummary,
  predictComboDps,
  predictItemSwapDps,
  summarizeDiagnostics,
} from './pruner-diagnostic';

describe('predictItemSwapDps', () => {
  it('returns positive DPS for an ilvl upgrade', () => {
    // 10 ilvl gain × 0.3 %/ilvl × 100k baseline = +3% = +3000 dps
    const dps = predictItemSwapDps({
      candidate_ilvl: 280,
      incumbent_ilvl: 270,
      baseline_dps: 100_000,
      dps_per_ilvl_pct: 0.3,
    });
    expect(dps).toBeCloseTo(3000, 1);
  });

  it('returns negative DPS for a downgrade', () => {
    const dps = predictItemSwapDps({
      candidate_ilvl: 260,
      incumbent_ilvl: 270,
      baseline_dps: 100_000,
      dps_per_ilvl_pct: 0.3,
    });
    expect(dps).toBeCloseTo(-3000, 1);
  });

  it('returns 0 for equal ilvl', () => {
    const dps = predictItemSwapDps({
      candidate_ilvl: 270,
      incumbent_ilvl: 270,
      baseline_dps: 100_000,
      dps_per_ilvl_pct: 0.3,
    });
    expect(dps).toBe(0);
  });
});

describe('predictComboDps', () => {
  it('sums per-item ilvl deltas', () => {
    // 3 swaps with deltas +5, +10, -2 = +13 ilvl × 0.3% × 100k = +3900
    const dps = predictComboDps({
      swaps: [
        { candidate_ilvl: 280, incumbent_ilvl: 275 },
        { candidate_ilvl: 285, incumbent_ilvl: 275 },
        { candidate_ilvl: 273, incumbent_ilvl: 275 },
      ],
      baseline_dps: 100_000,
      dps_per_ilvl_pct: 0.3,
    });
    expect(dps).toBeCloseTo(3900, 1);
  });

  it('returns 0 for empty swaps', () => {
    expect(
      predictComboDps({
        swaps: [],
        baseline_dps: 100_000,
        dps_per_ilvl_pct: 0.3,
      }),
    ).toBe(0);
  });
});

describe('buildDiagnosticEntry', () => {
  it('computes positive error_pp when prediction over-shoots', () => {
    // baseline 100k, candidate 102k → actual +2% → +2000 dps
    // predicted +3000 dps = +3% → error = +1pp
    const entry = buildDiagnosticEntry({
      label: 'test',
      baseline_dps: 100_000,
      candidate_dps: 102_000,
      predicted_delta_dps: 3_000,
      outcome: 'accepted',
    });
    expect(entry.actual_delta_dps).toBe(2_000);
    expect(entry.actual_pct).toBeCloseTo(2.0, 2);
    expect(entry.predicted_pct).toBeCloseTo(3.0, 2);
    expect(entry.error_pp).toBeCloseTo(1.0, 2);
  });

  it('computes negative error_pp when prediction under-shoots (breakpoint signal)', () => {
    // Sim found a breakpoint → actual gain is bigger than predicted.
    const entry = buildDiagnosticEntry({
      label: 'breakpoint pair',
      baseline_dps: 100_000,
      candidate_dps: 105_000,
      predicted_delta_dps: 1_000,
      outcome: 'winner',
    });
    expect(entry.actual_pct).toBeCloseTo(5.0, 2);
    expect(entry.predicted_pct).toBeCloseTo(1.0, 2);
    expect(entry.error_pp).toBeCloseTo(-4.0, 2);
  });

  it('handles zero baseline gracefully (avoids divide-by-zero)', () => {
    const entry = buildDiagnosticEntry({
      label: 'edge',
      baseline_dps: 0,
      candidate_dps: 1_000,
      predicted_delta_dps: 500,
      outcome: 'rejected',
    });
    expect(entry.predicted_pct).toBe(0);
    expect(entry.actual_pct).toBe(0);
    expect(entry.error_pp).toBe(0);
  });
});

describe('formatDiagnosticLine', () => {
  it('renders a complete diagnostic line', () => {
    const entry = buildDiagnosticEntry({
      label: 'greedy iter 2: chest=Lightbinder',
      baseline_dps: 100_000,
      candidate_dps: 102_400,
      predicted_delta_dps: 3_000,
      outcome: 'accepted',
    });
    const line = formatDiagnosticLine(entry);
    expect(line).toContain('[diagnostic]');
    expect(line).toContain('greedy iter 2: chest=Lightbinder');
    expect(line).toContain('predicted=+3.00%');
    expect(line).toContain('actual=+2.40%');
    expect(line).toContain('error=+0.60pp');
    expect(line).toContain('ACCEPTED');
  });

  it('formats negative deltas with explicit signs', () => {
    const entry = buildDiagnosticEntry({
      label: 'rejected_item',
      baseline_dps: 100_000,
      candidate_dps: 99_000,
      predicted_delta_dps: -500,
      outcome: 'rejected',
    });
    const line = formatDiagnosticLine(entry);
    expect(line).toContain('actual=-1.00%');
    expect(line).toContain('predicted=-0.50%');
    expect(line).toContain('REJECTED');
  });
});

describe('summarizeDiagnostics', () => {
  it('returns zeros for empty input', () => {
    const s = summarizeDiagnostics([], 'greedy');
    expect(s.count).toBe(0);
    expect(s.mean_error_pp).toBe(0);
    expect(s.max_abs_error_pp).toBe(0);
  });

  it('computes mean / p50 / p90 / max across multiple entries', () => {
    const entries = [
      buildDiagnosticEntry({
        label: 'e1', baseline_dps: 100, candidate_dps: 102,
        predicted_delta_dps: 1, outcome: 'accepted',
      }),
      buildDiagnosticEntry({
        label: 'e2', baseline_dps: 100, candidate_dps: 103,
        predicted_delta_dps: 2, outcome: 'accepted',
      }),
      buildDiagnosticEntry({
        label: 'e3', baseline_dps: 100, candidate_dps: 105,
        predicted_delta_dps: 6, outcome: 'accepted',
      }),
    ];
    // error_pp values: 1-2=-1, 2-3=-1, 6-5=+1 → all magnitude 1
    const s = summarizeDiagnostics(entries, 'greedy');
    expect(s.count).toBe(3);
    expect(s.max_abs_error_pp).toBeCloseTo(1, 2);
  });

  it('formats summary line with correct sign + decimal places', () => {
    const entries = [
      buildDiagnosticEntry({
        label: 'e1', baseline_dps: 100_000, candidate_dps: 102_000,
        predicted_delta_dps: 3_000, outcome: 'accepted',
      }),
    ];
    const s = summarizeDiagnostics(entries, 'greedy');
    const line = formatDiagnosticSummary(s);
    expect(line).toContain('[diagnostic] greedy summary');
    expect(line).toContain('1 sims');
    expect(line).toContain('mean_error=+1.00pp');
  });
});
