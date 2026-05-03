import type { TrinketPreScanResult, TrinketPairResult } from '@simly/shared';
import {
  allUnorderedPairs,
  formatItemLine,
  type ParsedItem,
} from '../simc-export-parser';
import { runSimc, type RunnerPaths, type SimcRunResult } from '../simc-runner';

/**
 * Build a SimC profileset script for an explicit list of trinket
 * pairs. Each pair gets a deterministic name `t_<idA>_<idB>` derived
 * from the source trinkets' identities (sorted), so cached and freshly
 * sim'd pairs share names — useful when merging incremental sim
 * results back into a cached pair set.
 */
export function buildTrinketProfilesetScriptFromPairs(
  pairs: ReadonlyArray<readonly [ParsedItem, ParsedItem]>,
): {
  script: string;
  pairsByName: Map<string, { t1: ParsedItem; t2: ParsedItem }>;
} {
  const lines: string[] = [];
  const pairsByName = new Map<string, { t1: ParsedItem; t2: ParsedItem }>();
  for (const [t1, t2] of pairs) {
    const name = pairKey(t1, t2);
    pairsByName.set(name, { t1, t2 });
    lines.push(`profileset."${name}"+="${formatItemLine(t1, 'trinket1')}"`);
    lines.push(`profileset."${name}"+="${formatItemLine(t2, 'trinket2')}"`);
  }
  return { script: lines.join('\n'), pairsByName };
}

/**
 * Stable pair name from two trinket identities. Sorted so (a, b) and
 * (b, a) produce the same key — pair identity doesn't depend on which
 * ParsedItem ended up as trinket1.
 */
export function pairKey(t1: ParsedItem, t2: ParsedItem): string {
  const [a, b] = [t1.identity, t2.identity].sort();
  // Hash to keep the profileset name short and SimC-safe (no slashes
  // or special chars from the identity).
  return `t_${shortHash(a!)}_${shortHash(b!)}`;
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
 * Build a SimC profileset script that varies trinket1 + trinket2
 * across every unordered pair from the given trinket pool. Thin
 * wrapper over `buildTrinketProfilesetScriptFromPairs` for the
 * full-pool case (initial sim or full re-run).
 */
export function buildTrinketProfilesetScript(trinkets: readonly ParsedItem[]): {
  script: string;
  pairsByName: Map<string, { t1: ParsedItem; t2: ParsedItem }>;
} {
  const pairs: Array<readonly [ParsedItem, ParsedItem]> = [];
  for (const [t1, t2] of allUnorderedPairs(trinkets)) pairs.push([t1, t2]);
  return buildTrinketProfilesetScriptFromPairs(pairs);
}

export interface RunTrinketPreScanOptions {
  paths: RunnerPaths;
  baseProfile: string;
  trinkets: readonly ParsedItem[];
  /** Per-profileset iterations. Default 3000 per SCOPE 4c. */
  iterations?: number;
  /** Streamed progress lines from SimC stdout/stderr. */
  onProgress?: Parameters<typeof runSimc>[0]['onProgress'];
}

/** Spawn the SimC subprocess for the trinket pre-scan. */
export async function runTrinketPreScanSim(
  opts: RunTrinketPreScanOptions,
): Promise<{ run: SimcRunResult; pairsByName: ReturnType<typeof buildTrinketProfilesetScript>['pairsByName'] }> {
  const iterations = opts.iterations ?? 3000;
  const { script, pairsByName } = buildTrinketProfilesetScript(opts.trinkets);
  const profileScript = [opts.baseProfile.trim(), '', script].join('\n');
  const run = await runSimc({
    paths: opts.paths,
    profileScript,
    iterations,
    scratchTag: `trinket-pre-${Date.now()}`,
    onProgress: opts.onProgress,
  });
  return { run, pairsByName };
}

export interface RunTrinketPairsOptions {
  paths: RunnerPaths;
  baseProfile: string;
  pairs: ReadonlyArray<readonly [ParsedItem, ParsedItem]>;
  iterations?: number;
  onProgress?: Parameters<typeof runSimc>[0]['onProgress'];
}

/**
 * Sim a specific list of trinket pairs (the incremental path). Used
 * when the trinket cache has results for the existing top trinkets
 * and we only want to evaluate new trinket(s) against them.
 */
export async function runTrinketPairsSim(
  opts: RunTrinketPairsOptions,
): Promise<{ run: SimcRunResult; pairsByName: ReturnType<typeof buildTrinketProfilesetScriptFromPairs>['pairsByName'] }> {
  const iterations = opts.iterations ?? 3000;
  const { script, pairsByName } = buildTrinketProfilesetScriptFromPairs(opts.pairs);
  const profileScript = [opts.baseProfile.trim(), '', script].join('\n');
  const run = await runSimc({
    paths: opts.paths,
    profileScript,
    iterations,
    scratchTag: `trinket-pairs-${Date.now()}`,
    onProgress: opts.onProgress,
  });
  return { run, pairsByName };
}

/**
 * Convert raw profileset results into typed pair results, without the
 * sort + delta_pct backfill that the full-result builder does. Used
 * by the cache merge path: caller combines fresh pairs with cached
 * pairs and re-sorts/re-deltas the union as one.
 */
export function profilesetsToPairResults(
  run: SimcRunResult,
  pairsByName: ReadonlyMap<string, { t1: ParsedItem; t2: ParsedItem }>,
): TrinketPairResult[] {
  const out: TrinketPairResult[] = [];
  for (const profileset of run.profilesets) {
    const meta = pairsByName.get(profileset.name);
    if (!meta) continue;
    out.push({
      pair_id: profileset.name,
      trinket1: itemRef(meta.t1),
      trinket2: itemRef(meta.t2),
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
export function finalizeTrinketResult(pairs: TrinketPairResult[]): TrinketPreScanResult {
  pairs.sort((a, b) => b.mean_dps - a.mean_dps);
  if (pairs.length > 0) {
    const winnerDps = pairs[0]!.mean_dps;
    for (const p of pairs) {
      p.delta_pct = roundTo(((p.mean_dps - winnerDps) / winnerDps) * 100, 2);
    }
  }
  return {
    label: 'Best trinket pair (single-target Patchwerk)',
    pairs,
    winner: pairs[0],
  };
}

/** Convert profileset results back into typed trinket-pair results. */
export function parseTrinketPreScanResult(
  run: SimcRunResult,
  pairsByName: ReturnType<typeof buildTrinketProfilesetScript>['pairsByName'],
): TrinketPreScanResult {
  const pairs: TrinketPairResult[] = [];
  for (const profileset of run.profilesets) {
    const meta = pairsByName.get(profileset.name);
    if (!meta) continue;
    pairs.push({
      pair_id: profileset.name,
      trinket1: itemRef(meta.t1),
      trinket2: itemRef(meta.t2),
      mean_dps: profileset.mean,
      delta_pct: 0, // backfilled after sort
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
    label: 'Best trinket pair (single-target Patchwerk)',
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
