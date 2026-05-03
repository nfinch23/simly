import type { TrinketPreScanResult, TrinketPairResult } from '@simly/shared';
import {
  allUnorderedPairs,
  formatItemLine,
  type ParsedItem,
} from '../simc-export-parser';
import { runSimc, type RunnerPaths, type SimcRunResult } from '../simc-runner';

/**
 * Build a SimC profileset script that varies trinket1 + trinket2
 * across every unordered pair from the given trinket pool. Returns
 * the script body and a map from profileset name back to the source
 * trinkets so we can read results back into typed pairs.
 *
 * Profileset names look like `t_<i>_<j>` where i < j are indices into
 * the trinket pool — keeps names short (no item ids leaking) and the
 * mapping is deterministic for round-trip parsing.
 */
export function buildTrinketProfilesetScript(trinkets: readonly ParsedItem[]): {
  script: string;
  pairsByName: Map<string, { i: number; j: number; t1: ParsedItem; t2: ParsedItem }>;
} {
  const lines: string[] = [];
  const pairsByName = new Map<string, { i: number; j: number; t1: ParsedItem; t2: ParsedItem }>();
  let idx = 0;
  for (const [t1, t2] of allUnorderedPairs(trinkets)) {
    // Find the original indices i < j so the name encodes both.
    const i = trinkets.indexOf(t1);
    const j = trinkets.indexOf(t2);
    const name = `t_${i}_${j}`;
    pairsByName.set(name, { i, j, t1, t2 });
    lines.push(`profileset."${name}"+="${formatItemLine(t1, 'trinket1')}"`);
    lines.push(`profileset."${name}"+="${formatItemLine(t2, 'trinket2')}"`);
    idx++;
  }
  return { script: lines.join('\n'), pairsByName };
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
