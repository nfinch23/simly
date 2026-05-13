/**
 * Persistent ring pre-scan cache + incremental sim planner. Mirror of
 * trinket-cache.ts; see that file's docstring for the architectural
 * rationale. Cache keyed on `(character_key, scenario)`.
 */

import type { RingPairResult, RingPreScanResult } from '@simly/shared';
import type { ParsedItem } from './simc-export-parser';
import { TOP_RINGS_TO_KEEP as TOP_FROM_CONFIG } from './gear-config';

/**
 * Number of "leader" rings carried forward from one full sim to the
 * next. Re-exported from gear-config.ts so callers don't need a config
 * import; canonical value lives there.
 */
export const TOP_RINGS_TO_KEEP = TOP_FROM_CONFIG;

export interface RingCacheEntry {
  character_key: string;
  scenario: string;
  /** Sorted list of every ring identity that was simmed. Used as the
   * change-detection signature (pool unchanged ⇒ same signature). */
  pool_signature: string;
  /**
   * Hash of the actor's gear context at the time of the sim. See
   * trinket-cache.ts for the rationale on the two-pass stat-reconverge
   * pipeline. Optional + defaulted to empty string for back-compat.
   */
  gear_context_hash?: string;
  /** Every pair simmed in the most recent run. Sorted desc by mean_dps. */
  pairs: RingPairResult[];
  /** The top N leader ring identities, ranked by best appearance. */
  top_ring_identities: string[];
  last_simmed_at: number;
}

interface Schema {
  entries: Record<string, RingCacheEntry>;
}

const KEY_SEP = '|';

function makeCacheKey(
  character_key: string,
  scenario: string,
  gear_context_hash?: string,
): string {
  const base = `${character_key}${KEY_SEP}${scenario}`;
  if (!gear_context_hash) return base;
  return `${base}${KEY_SEP}${gear_context_hash}`;
}

export interface RingCacheOptions {
  cwd?: string;
  name?: string;
}

import type ElectronStore from 'electron-store';
import * as ElectronStoreModule from 'electron-store';

function resolveStoreCtor(): typeof ElectronStore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m: any = ElectronStoreModule;
  for (const candidate of [m, m?.default, m?.default?.default]) {
    if (typeof candidate === 'function') {
      return candidate as typeof ElectronStore;
    }
  }
  const keys = m && typeof m === 'object' ? Object.keys(m) : String(m);
  throw new Error(`electron-store default export is not a constructor; module shape: ${JSON.stringify(keys)}`);
}

export class RingCacheStore {
  private readonly store: ElectronStore<Schema>;

  constructor(opts: RingCacheOptions = {}) {
    const StoreClass = resolveStoreCtor();
    this.store = new StoreClass<Schema>({
      name: opts.name ?? 'ring-cache',
      cwd: opts.cwd,
      defaults: { entries: {} },
    });
  }

  get(
    character_key: string,
    scenario: string,
    gear_context_hash?: string,
  ): RingCacheEntry | undefined {
    const entries = this.store.get('entries') ?? {};
    return entries[makeCacheKey(character_key, scenario, gear_context_hash)];
  }

  put(entry: RingCacheEntry): void {
    this.store.set(
      `entries.${makeCacheKey(entry.character_key, entry.scenario, entry.gear_context_hash)}`,
      entry,
    );
  }

  clear(): void {
    this.store.set('entries', {});
  }

  /**
   * Invalidate one (character, scenario, optional gear-context)'s cache.
   * Called by the scan queue when a gear upgrade is detected — the
   * cached ring pairs were sim'd with the prior gear context, so even
   * though the ring POOL is unchanged, the relative rankings may have
   * shifted.
   */
  invalidate(
    character_key: string,
    scenario: string,
    gear_context_hash?: string,
  ): void {
    const entries = this.store.get('entries') ?? {};
    const next = { ...entries };
    delete next[makeCacheKey(character_key, scenario, gear_context_hash)];
    this.store.set('entries', next);
  }

  /**
   * Invalidate EVERY entry for a (character, scenario) regardless of
   * gear_context_hash. Used when a gear-upgrade cascade happens in the
   * orchestrator.
   */
  invalidateAllContexts(character_key: string, scenario: string): void {
    const entries = this.store.get('entries') ?? {};
    const next: Record<string, RingCacheEntry> = {};
    const baseKey = makeCacheKey(character_key, scenario);
    for (const [k, v] of Object.entries(entries)) {
      if (k === baseKey || k.startsWith(`${baseKey}${KEY_SEP}`)) continue;
      next[k] = v;
    }
    this.store.set('entries', next);
  }
}

/**
 * Stable signature of a ring pool. Identities are sorted before
 * concatenation so order-of-discovery doesn't change the signature.
 */
export function poolSignature(rings: readonly ParsedItem[]): string {
  return [...rings.map((r) => r.identity)].sort().join(',');
}

/**
 * Compute the top N rings from a sorted pair list. Each ring is scored
 * by its best appearance — the highest mean_dps of any pair containing
 * it. Ties broken by identity (deterministic).
 */
export function selectTopRings(
  pairs: readonly RingPairResult[],
  n: number = TOP_RINGS_TO_KEEP,
): string[] {
  const bestByIdentity = new Map<string, number>();
  for (const p of pairs) {
    for (const r of [p.finger1, p.finger2]) {
      const cur = bestByIdentity.get(r.identity) ?? -Infinity;
      if (p.mean_dps > cur) bestByIdentity.set(r.identity, p.mean_dps);
    }
  }
  return Array.from(bestByIdentity.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([identity]) => identity);
}

/**
 * Plan the next ring sim based on the current pool + cache state.
 * Mirrors planTrinketScan: three outcomes — reuse / incremental / full.
 */
export type RingSimPlan =
  | { kind: 'reuse'; result: RingPreScanResult }
  | {
      kind: 'incremental';
      cached: RingCacheEntry;
      cachedTop: ParsedItem[];
      newRings: ParsedItem[];
      pairsToSim: Array<readonly [ParsedItem, ParsedItem]>;
    }
  | { kind: 'full'; rings: ParsedItem[]; reason: string };

export interface PlanRingScanOptions {
  rings: readonly ParsedItem[];
  cache: RingCacheStore;
  character_key: string;
  scenario: string;
  gear_context_hash?: string;
}

export function planRingScan(opts: PlanRingScanOptions): RingSimPlan {
  const rings = [...opts.rings];
  if (rings.length < 2) {
    return { kind: 'full', rings, reason: 'fewer than 2 rings in pool' };
  }
  const cached = opts.cache.get(
    opts.character_key,
    opts.scenario,
    opts.gear_context_hash,
  );
  const sig = poolSignature(rings);
  if (!cached) {
    return { kind: 'full', rings, reason: 'no cache entry yet' };
  }
  if (cached.pool_signature === sig) {
    return {
      kind: 'reuse',
      result: {
        label: 'Best ring pair (single-target Patchwerk) — cached',
        pairs: cached.pairs,
        winner: cached.pairs[0],
      },
    };
  }

  // Pool changed. Did any of the cached top rings vanish?
  const currentIdentities = new Set(rings.map((r) => r.identity));
  const cachedTopAlive = cached.top_ring_identities.filter((id) =>
    currentIdentities.has(id),
  );
  if (cachedTopAlive.length < cached.top_ring_identities.length) {
    return {
      kind: 'full',
      rings,
      reason: `${cached.top_ring_identities.length - cachedTopAlive.length} cached top ring(s) no longer in pool`,
    };
  }

  const cachedIdentities = new Set(
    cached.pool_signature.length > 0 ? cached.pool_signature.split(',') : [],
  );
  const newRings = rings.filter((r) => !cachedIdentities.has(r.identity));
  if (newRings.length === 0) {
    return {
      kind: 'reuse',
      result: {
        label: 'Best ring pair (single-target Patchwerk) — cached',
        pairs: cached.pairs.filter(
          (p) =>
            currentIdentities.has(p.finger1.identity) &&
            currentIdentities.has(p.finger2.identity),
        ),
        winner: cached.pairs.find(
          (p) =>
            currentIdentities.has(p.finger1.identity) &&
            currentIdentities.has(p.finger2.identity),
        ),
      },
    };
  }

  // Incremental: sim every pair involving at least one new ring within
  // (cached top alive ∪ newRings). Cached-top × cached-top pairs are
  // already in the cache.
  const cachedTopItems = rings.filter((r) => cachedTopAlive.includes(r.identity));
  const incrementalPool = [...cachedTopItems, ...newRings];
  const pairsToSim: Array<readonly [ParsedItem, ParsedItem]> = [];
  for (let i = 0; i < incrementalPool.length; i++) {
    for (let j = i + 1; j < incrementalPool.length; j++) {
      const a = incrementalPool[i]!;
      const b = incrementalPool[j]!;
      if (
        cachedTopAlive.includes(a.identity) &&
        cachedTopAlive.includes(b.identity)
      ) {
        continue;
      }
      pairsToSim.push([a, b]);
    }
  }

  return {
    kind: 'incremental',
    cached,
    cachedTop: cachedTopItems,
    newRings,
    pairsToSim,
  };
}

/**
 * Merge fresh pairs from an incremental sim into the cached pair set,
 * then sort + recompute delta_pct. Mirrors mergePairResults in
 * trinket-cache.ts.
 */
export function mergePairResults(
  cachedPairs: readonly RingPairResult[],
  freshPairs: readonly RingPairResult[],
  currentIdentities: ReadonlySet<string>,
): RingPairResult[] {
  const byId = new Map<string, RingPairResult>();
  for (const p of cachedPairs) byId.set(p.pair_id, p);
  for (const p of freshPairs) byId.set(p.pair_id, p);
  const filtered = Array.from(byId.values()).filter(
    (p) =>
      currentIdentities.has(p.finger1.identity) &&
      currentIdentities.has(p.finger2.identity),
  );
  filtered.sort((a, b) => b.mean_dps - a.mean_dps);
  if (filtered.length > 0) {
    const winnerDps = filtered[0]!.mean_dps;
    for (const p of filtered) {
      p.delta_pct = roundTo(((p.mean_dps - winnerDps) / winnerDps) * 100, 2);
    }
  }
  return filtered;
}

function roundTo(n: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}
