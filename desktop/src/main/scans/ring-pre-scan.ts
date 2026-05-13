import type { RingPreScanResult, RingPairResult } from '@simly/shared';
import {
  allUnorderedPairs,
  formatItemLine,
  type ParsedItem,
} from '../simc-export-parser';
import { runSimc, type RunnerPaths, type SimcRunResult } from '../simc-runner';
import { RING_ITERATIONS } from '../gear-config';

/**
 * Build a SimC profileset script for an explicit list of ring pairs.
 * Mirror of buildTrinketProfilesetScriptFromPairs but writes finger1/
 * finger2 SimC lines. Pair names are identity-derived (sorted, hashed)
 * so cached and freshly sim'd pairs share names — useful when merging
 * incremental sim results back into a cached pair set.
 */
export function buildRingProfilesetScriptFromPairs(
  pairs: ReadonlyArray<readonly [ParsedItem, ParsedItem]>,
): {
  script: string;
  pairsByName: Map<string, { r1: ParsedItem; r2: ParsedItem }>;
} {
  const lines: string[] = [];
  const pairsByName = new Map<string, { r1: ParsedItem; r2: ParsedItem }>();
  for (const [r1, r2] of pairs) {
    const name = pairKey(r1, r2);
    pairsByName.set(name, { r1, r2 });
    lines.push(`profileset."${name}"+="${formatItemLine(r1, 'finger1')}"`);
    lines.push(`profileset."${name}"+="${formatItemLine(r2, 'finger2')}"`);
  }
  return { script: lines.join('\n'), pairsByName };
}

/**
 * Stable pair name from two ring identities. Sorted so (a, b) and
 * (b, a) produce the same key — pair identity doesn't depend on which
 * ParsedItem ended up as finger1.
 */
export function pairKey(r1: ParsedItem, r2: ParsedItem): string {
  const [a, b] = [r1.identity, r2.identity].sort();
  return `r_${shortHash(a!)}_${shortHash(b!)}`;
}

/** Short deterministic hash — collision-tolerant; only needs uniqueness within a single sim run. */
function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * Build a SimC profileset script that varies finger1 + finger2 across
 * every unordered pair from the given ring pool. Thin wrapper over
 * `buildRingProfilesetScriptFromPairs` for the full-pool case.
 */
export function buildRingProfilesetScript(rings: readonly ParsedItem[]): {
  script: string;
  pairsByName: Map<string, { r1: ParsedItem; r2: ParsedItem }>;
} {
  const pairs: Array<readonly [ParsedItem, ParsedItem]> = [];
  for (const [r1, r2] of allUnorderedPairs(rings)) pairs.push([r1, r2]);
  return buildRingProfilesetScriptFromPairs(pairs);
}

export interface RunRingPreScanOptions {
  paths: RunnerPaths;
  baseProfile: string;
  rings: readonly ParsedItem[];
  /** Per-profileset iterations. Default 3000 (mirror trinket SCOPE 4c). */
  iterations?: number;
  /** Streamed progress lines from SimC stdout/stderr. */
  onProgress?: Parameters<typeof runSimc>[0]['onProgress'];
}

/** Spawn the SimC subprocess for the ring pre-scan. */
export async function runRingPreScanSim(
  opts: RunRingPreScanOptions,
): Promise<{ run: SimcRunResult; pairsByName: ReturnType<typeof buildRingProfilesetScript>['pairsByName'] }> {
  const iterations = opts.iterations ?? RING_ITERATIONS;
  const { script, pairsByName } = buildRingProfilesetScript(opts.rings);
  const profileScript = [opts.baseProfile.trim(), '', script].join('\n');
  const run = await runSimc({
    paths: opts.paths,
    profileScript,
    iterations,
    scratchTag: `ring-pre-${Date.now()}`,
    onProgress: opts.onProgress,
  });
  return { run, pairsByName };
}

export interface RunRingPairsOptions {
  paths: RunnerPaths;
  baseProfile: string;
  pairs: ReadonlyArray<readonly [ParsedItem, ParsedItem]>;
  iterations?: number;
  onProgress?: Parameters<typeof runSimc>[0]['onProgress'];
}

/**
 * Sim a specific list of ring pairs (the incremental path). Used when
 * the ring cache has results for the existing top rings and we only
 * want to evaluate new ring(s) against them.
 */
export async function runRingPairsSim(
  opts: RunRingPairsOptions,
): Promise<{ run: SimcRunResult; pairsByName: ReturnType<typeof buildRingProfilesetScriptFromPairs>['pairsByName'] }> {
  const iterations = opts.iterations ?? RING_ITERATIONS;
  const { script, pairsByName } = buildRingProfilesetScriptFromPairs(opts.pairs);
  const profileScript = [opts.baseProfile.trim(), '', script].join('\n');
  const run = await runSimc({
    paths: opts.paths,
    profileScript,
    iterations,
    scratchTag: `ring-pairs-${Date.now()}`,
    onProgress: opts.onProgress,
  });
  return { run, pairsByName };
}

/**
 * Convert raw profileset results into typed pair results, without the
 * sort + delta_pct backfill that the full-result builder does. Used by
 * the cache merge path: caller combines fresh pairs with cached pairs
 * and re-sorts/re-deltas the union as one.
 */
export function profilesetsToPairResults(
  run: SimcRunResult,
  pairsByName: ReadonlyMap<string, { r1: ParsedItem; r2: ParsedItem }>,
): RingPairResult[] {
  const out: RingPairResult[] = [];
  for (const profileset of run.profilesets) {
    const meta = pairsByName.get(profileset.name);
    if (!meta) continue;
    out.push({
      pair_id: profileset.name,
      finger1: itemRef(meta.r1),
      finger2: itemRef(meta.r2),
      mean_dps: profileset.mean,
      delta_pct: 0,
    });
  }
  return out;
}

/**
 * Sort + backfill delta_pct on a flat pair list, then wrap as the
 * result shape the addon panel reads.
 */
export function finalizeRingResult(pairs: RingPairResult[]): RingPreScanResult {
  pairs.sort((a, b) => b.mean_dps - a.mean_dps);
  if (pairs.length > 0) {
    const winnerDps = pairs[0]!.mean_dps;
    for (const p of pairs) {
      p.delta_pct = roundTo(((p.mean_dps - winnerDps) / winnerDps) * 100, 2);
    }
  }
  return {
    label: 'Best ring pair (single-target Patchwerk)',
    pairs,
    winner: pairs[0],
  };
}

/** Convert profileset results back into typed ring-pair results. */
export function parseRingPreScanResult(
  run: SimcRunResult,
  pairsByName: ReturnType<typeof buildRingProfilesetScript>['pairsByName'],
): RingPreScanResult {
  const pairs: RingPairResult[] = [];
  for (const profileset of run.profilesets) {
    const meta = pairsByName.get(profileset.name);
    if (!meta) continue;
    pairs.push({
      pair_id: profileset.name,
      finger1: itemRef(meta.r1),
      finger2: itemRef(meta.r2),
      mean_dps: profileset.mean,
      delta_pct: 0,
    });
  }
  pairs.sort((a, b) => b.mean_dps - a.mean_dps);
  if (pairs.length > 0) {
    const winnerDps = pairs[0]!.mean_dps;
    for (const p of pairs) {
      p.delta_pct = roundTo(((p.mean_dps - winnerDps) / winnerDps) * 100, 2);
    }
  }
  return {
    label: 'Best ring pair (single-target Patchwerk)',
    pairs,
    winner: pairs[0],
  };
}

function itemRef(item: ParsedItem) {
  return {
    item_id: item.item_id,
    name: item.name,
    ilvl: item.ilvl,
    identity: item.identity,
  };
}

function roundTo(n: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}
