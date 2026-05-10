import { describe, expect, it } from 'vitest';
import {
  buildDiagnosticEntry,
  buildStatVectorDiagnosticEntry,
  formatDiagnosticLine,
  formatDiagnosticSummary,
  predictComboDps,
  predictDpsFromStatDelta,
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

describe('predictDpsFromStatDelta', () => {
  const incumbent = {
    intellect: 234, strength: 0, agility: 0,
    haste_rating: 180, crit_rating: 120, mastery_rating: 95, versatility_rating: 60,
  };

  it('multiplies stat deltas by their weights and sums', () => {
    // candidate: +20 int, +50 haste. Weights: int=33, haste=15.
    // Expected: 20*33 + 50*15 = 660 + 750 = 1410.
    const candidate = { ...incumbent, intellect: 254, haste_rating: 230 };
    const r = predictDpsFromStatDelta({
      incumbent, candidate,
      weights: { intellect: 33, haste: 15 },
    });
    expect(r.predicted_delta_dps).toBeCloseTo(1410, 1);
    expect(r.per_stat_contributions['intellect']).toBeCloseTo(660, 1);
    expect(r.per_stat_contributions['haste']).toBeCloseTo(750, 1);
  });

  it('returns negative DPS when stats decrease', () => {
    const candidate = { ...incumbent, intellect: 200, haste_rating: 100 };
    const r = predictDpsFromStatDelta({
      incumbent, candidate,
      weights: { intellect: 33, haste: 15 },
    });
    // Δint=-34, Δhaste=-80. Expected: -34*33 + -80*15 = -1122 - 1200 = -2322.
    expect(r.predicted_delta_dps).toBeCloseTo(-2322, 1);
  });

  it('returns 0 when candidate stats are identical to incumbent', () => {
    expect(predictDpsFromStatDelta({
      incumbent, candidate: { ...incumbent },
      weights: { intellect: 33, haste: 15 },
    }).predicted_delta_dps).toBe(0);
  });

  it('treats missing weights as zero', () => {
    const candidate = { ...incumbent, intellect: 254, mastery_rating: 200 };
    const r = predictDpsFromStatDelta({
      incumbent, candidate,
      weights: { intellect: 33 }, // no mastery weight
    });
    // mastery delta ignored. Δint=20, weight=33 → 660.
    expect(r.predicted_delta_dps).toBeCloseTo(660, 1);
  });
});

describe('buildStatVectorDiagnosticEntry', () => {
  it('exposes positive unexplained_pp when sim exceeds stat-vector prediction (Elderoot Spire pattern)', () => {
    const entry = buildStatVectorDiagnosticEntry({
      label: 'main_hand=Elderoot Spire',
      baseline_dps: 71_326,
      candidate_dps: 75_233, // +5.48% ≈ +3907 dps actual
      predicted_delta_dps_ilvl: -735, // legacy ilvl-proxy said -1.03%
      predicted_delta_dps_stat_vector: 654, // stat-vector says +0.92%
      outcome: 'accepted',
    });
    expect(entry.actual_pct).toBeCloseTo(5.48, 1);
    expect(entry.predicted_pct_stat_vector).toBeCloseTo(0.92, 1);
    expect(entry.unexplained_pp).toBeGreaterThan(4); // structural gap
    expect(entry.unexplained_dps).toBeGreaterThan(3000);
    // Legacy fields still populated:
    expect(entry.error_pp).toBeCloseTo(-6.51, 1);
  });

  it('shows near-zero unexplained_pp on a clean armor swap', () => {
    const entry = buildStatVectorDiagnosticEntry({
      label: 'chest=Plain',
      baseline_dps: 100_000,
      candidate_dps: 102_000,
      predicted_delta_dps_ilvl: 1_800,
      predicted_delta_dps_stat_vector: 1_950,
      outcome: 'accepted',
    });
    expect(Math.abs(entry.unexplained_pp ?? 999)).toBeLessThan(0.5);
  });

  it('handles zero baseline gracefully', () => {
    const entry = buildStatVectorDiagnosticEntry({
      label: 'edge', baseline_dps: 0, candidate_dps: 100,
      predicted_delta_dps_ilvl: 50, predicted_delta_dps_stat_vector: 75,
      outcome: 'accepted',
    });
    expect(entry.predicted_pct_stat_vector).toBe(0);
    expect(entry.unexplained_pp).toBe(0);
  });
});

describe('formatDiagnosticLine (stat-vector mode)', () => {
  it('renders the stat-vector format when entry has stat-vector fields', () => {
    const entry = buildStatVectorDiagnosticEntry({
      label: 'main_hand=Elderoot Spire',
      baseline_dps: 71_326, candidate_dps: 75_233,
      predicted_delta_dps_ilvl: -735, predicted_delta_dps_stat_vector: 654,
      outcome: 'accepted',
    });
    const line = formatDiagnosticLine(entry);
    expect(line).toContain('predicted (stat-vector)=+0.92%');
    expect(line).toContain('actual=+5.48%');
    expect(line).toContain('unexplained=+');
    expect(line).toContain('ACCEPTED');
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
