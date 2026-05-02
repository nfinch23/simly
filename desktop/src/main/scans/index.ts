import type { SimcRunResult } from '../simc-runner';

/**
 * A Scan is one stage in the multi-stage sim pipeline. Each scan knows
 * how to extend a SimC profile with the variants it needs (`buildLines`)
 * and how to read the resulting profileset DPS back out into a typed
 * result (`parseResult`).
 *
 * Multiple scans can be merged into a single SimC invocation by
 * concatenating their `buildLines()`; the `profilesetPrefix` keeps each
 * scan's profileset names in a private namespace. v1's flask + food
 * scans share one invocation; Phase 4 splits the gear ladder into
 * separate runs so iterations can ramp.
 */
export interface Scan<TResult> {
  id: string;
  /** Namespace prefix for this question's profileset names. */
  profilesetPrefix: string;
  /** Lines appended to the SimC profile to enumerate variants. */
  buildLines(): string;
  /** Pull this question's result out of a sim run, or undefined if absent. */
  parseResult(run: SimcRunResult): TResult | undefined;
}

export interface ProfilesetCandidate {
  /** Stable key used in the profileset name; should be a valid SimC identifier. */
  key: string;
  /** Right-hand side of the profileset line (e.g. "flask=phial_of_tepid_versatility"). */
  simcLine: string;
}

/**
 * Format the candidate list into SimC `profileset."<prefix>_<key>"+="<simcLine>"` lines.
 * Each line nests the candidate inside a profileset whose name we recognize on the
 * way back out via {@link matchProfilesetsByPrefix}.
 */
export function buildProfilesetLines(
  prefix: string,
  candidates: readonly ProfilesetCandidate[],
): string {
  return candidates
    .map((c) => `profileset."${prefix}_${c.key}"+="${c.simcLine}"`)
    .join('\n');
}

export interface MatchedProfileset<C> {
  candidate: C;
  mean: number;
  stddev: number;
}

/**
 * Match SimC's profileset results back to typed candidate objects by name.
 * Profilesets whose names don't start with `<prefix>_` or whose suffix
 * isn't a known candidate key are skipped — callers can run multiple
 * scans in one sim and each will only see its own results.
 */
export function matchProfilesetsByPrefix<C extends { key: string }>(
  run: SimcRunResult,
  prefix: string,
  candidates: readonly C[],
): MatchedProfileset<C>[] {
  const byName = new Map<string, C>(
    candidates.map((c) => [`${prefix}_${c.key}`, c]),
  );
  const out: MatchedProfileset<C>[] = [];
  for (const p of run.profilesets) {
    const candidate = byName.get(p.name);
    if (!candidate) continue;
    out.push({ candidate, mean: p.mean, stddev: p.stddev });
  }
  return out;
}

export function roundTo(n: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}
