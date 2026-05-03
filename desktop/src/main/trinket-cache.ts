/**
 * Persistent trinket pre-scan cache + incremental sim planner.
 *
 * SCOPE: re-simming all C(n, 2) trinket pairs every "Update sims" is
 * 60s+ of wasted work when the bag pool didn't change. Instead:
 *
 *   - First run: full sim of all pairs, cache the results + the top
 *     N "leader" trinkets (those appearing in the best-DPS pairs).
 *   - Pool unchanged: skip the sim entirely, return the cached result.
 *   - One or more new trinkets dropped into the bag: sim only the
 *     pairs that involve a new trinket, merge with cached pairs, take
 *     the global top-DPS pair as the new winner.
 *   - A previously-leader trinket disappeared: invalidate, fall back
 *     to a full sim.
 *
 * Cache keyed on `(character_key, scenario)`. v1 is single-character,
 * single-scenario, but the keys exist so future scenarios don't need
 * a schema bump.
 */

import type { TrinketPairResult, TrinketPreScanResult } from '@simly/shared';
import type { ParsedItem } from './simc-export-parser';

/** Number of "leader" trinkets carried forward from one full sim to the next. */
export const TOP_TRINKETS_TO_KEEP = 4;

export interface TrinketCacheEntry {
  character_key: string;
  scenario: string;
  /** Sorted list of every trinket identity that was simmed. Used as the
   * change-detection signature (pool unchanged ⇒ same signature). */
  pool_signature: string;
  /** Every pair simmed in the most recent run. Sorted desc by mean_dps. */
  pairs: TrinketPairResult[];
  /** The top N leader trinket identities, ranked by best appearance.
   * New trinkets are simmed against these, not the entire historical pool. */
  top_trinket_identities: string[];
  last_simmed_at: number;
}

interface Schema {
  entries: Record<string, TrinketCacheEntry>;
}

const KEY_SEP = '|';

function makeCacheKey(character_key: string, scenario: string): string {
  return `${character_key}${KEY_SEP}${scenario}`;
}

export interface TrinketCacheOptions {
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

export class TrinketCacheStore {
  private readonly store: ElectronStore<Schema>;

  constructor(opts: TrinketCacheOptions = {}) {
    const StoreClass = resolveStoreCtor();
    this.store = new StoreClass<Schema>({
      name: opts.name ?? 'trinket-cache',
      cwd: opts.cwd,
      defaults: { entries: {} },
    });
  }

  get(character_key: string, scenario: string): TrinketCacheEntry | undefined {
    // electron-store's `defaults` apply on first construction but a
    // file-system-side delete (e.g., user wiping cache for testing)
    // can leave the in-memory cache with no `entries` key. Defaulting
    // here keeps callers from seeing undefined.
    const entries = this.store.get('entries') ?? {};
    return entries[makeCacheKey(character_key, scenario)];
  }

  put(entry: TrinketCacheEntry): void {
    this.store.set(`entries.${makeCacheKey(entry.character_key, entry.scenario)}`, entry);
  }

  clear(): void {
    this.store.set('entries', {});
  }
}

/**
 * Stable signature of a trinket pool. Identities are sorted before
 * concatenation so order-of-discovery doesn't change the signature.
 */
export function poolSignature(trinkets: readonly ParsedItem[]): string {
  return [...trinkets.map((t) => t.identity)].sort().join(',');
}

/**
 * Compute the top N trinkets from a sorted pair list. Each trinket
 * is scored by its best appearance — the highest mean_dps of any pair
 * containing it. Ties broken by identity (deterministic). The top N
 * identities are kept; the rest can be dropped as "consistently
 * losing" without further sim attention until they're re-introduced
 * (e.g. via a manual cache clear).
 */
export function selectTopTrinkets(
  pairs: readonly TrinketPairResult[],
  n: number = TOP_TRINKETS_TO_KEEP,
): string[] {
  const bestByIdentity = new Map<string, number>();
  for (const p of pairs) {
    for (const t of [p.trinket1, p.trinket2]) {
      const cur = bestByIdentity.get(t.identity) ?? -Infinity;
      if (p.mean_dps > cur) bestByIdentity.set(t.identity, p.mean_dps);
    }
  }
  return Array.from(bestByIdentity.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([identity]) => identity);
}

/**
 * Plan the next trinket sim based on the current pool + cache state.
 * Three outcomes:
 *
 *   - `reuse`: pool signature unchanged ⇒ no sim needed; the cached
 *     `result` is returned to the addon panel as-is.
 *   - `incremental`: at least one new trinket but every cached top
 *     trinket is still in the pool. Run a small sim of every
 *     unordered pair involving at least one new trinket (against the
 *     cached top trinkets + against the other new trinkets). Merge
 *     with cached pairs.
 *   - `full`: no cache, OR a previously-top trinket vanished, OR the
 *     pool collapsed below the leader set. Full sim of `trinkets`.
 *
 * The planner does not run any sim itself — caller dispatches based
 * on `kind`.
 */
export type TrinketSimPlan =
  | { kind: 'reuse'; result: TrinketPreScanResult }
  | {
      kind: 'incremental';
      cached: TrinketCacheEntry;
      cachedTop: ParsedItem[];
      newTrinkets: ParsedItem[];
      pairsToSim: Array<readonly [ParsedItem, ParsedItem]>;
    }
  | { kind: 'full'; trinkets: ParsedItem[]; reason: string };

export interface PlanTrinketScanOptions {
  trinkets: readonly ParsedItem[];
  cache: TrinketCacheStore;
  character_key: string;
  scenario: string;
}

export function planTrinketScan(opts: PlanTrinketScanOptions): TrinketSimPlan {
  const trinkets = [...opts.trinkets];
  if (trinkets.length < 2) {
    return { kind: 'full', trinkets, reason: 'fewer than 2 trinkets in pool' };
  }
  const cached = opts.cache.get(opts.character_key, opts.scenario);
  const sig = poolSignature(trinkets);
  if (!cached) {
    return { kind: 'full', trinkets, reason: 'no cache entry yet' };
  }
  if (cached.pool_signature === sig) {
    return {
      kind: 'reuse',
      result: {
        label: 'Best trinket pair (single-target Patchwerk) — cached',
        pairs: cached.pairs,
        winner: cached.pairs[0],
      },
    };
  }

  // Pool changed. Did any of the cached top trinkets vanish?
  const currentIdentities = new Set(trinkets.map((t) => t.identity));
  const cachedTopAlive = cached.top_trinket_identities.filter((id) =>
    currentIdentities.has(id),
  );
  if (cachedTopAlive.length < cached.top_trinket_identities.length) {
    return {
      kind: 'full',
      trinkets,
      reason: `${cached.top_trinket_identities.length - cachedTopAlive.length} cached top trinket(s) no longer in pool`,
    };
  }

  // Every cached leader is still around. Find any genuinely-new trinkets
  // — present today but not in the cached pool signature. The signature
  // is concatenated identities, so reconstruct the cached identity set
  // by splitting it. (Tolerates the empty-string edge case.)
  const cachedIdentities = new Set(
    cached.pool_signature.length > 0 ? cached.pool_signature.split(',') : [],
  );
  const newTrinkets = trinkets.filter((t) => !cachedIdentities.has(t.identity));
  if (newTrinkets.length === 0) {
    // Pool changed but nothing new arrived — only removals. Cached
    // results are still valid for the survivors.
    return {
      kind: 'reuse',
      result: {
        label: 'Best trinket pair (single-target Patchwerk) — cached',
        pairs: cached.pairs.filter(
          (p) =>
            currentIdentities.has(p.trinket1.identity) &&
            currentIdentities.has(p.trinket2.identity),
        ),
        winner: cached.pairs.find(
          (p) =>
            currentIdentities.has(p.trinket1.identity) &&
            currentIdentities.has(p.trinket2.identity),
        ),
      },
    };
  }

  // Incremental: sim every pair involving at least one new trinket
  // within (cached top alive ∪ newTrinkets). Cached-top × cached-top
  // pairs are already in the cache and don't need re-sim.
  const cachedTopItems = trinkets.filter((t) => cachedTopAlive.includes(t.identity));
  const incrementalPool = [...cachedTopItems, ...newTrinkets];
  const pairsToSim: Array<readonly [ParsedItem, ParsedItem]> = [];
  for (let i = 0; i < incrementalPool.length; i++) {
    for (let j = i + 1; j < incrementalPool.length; j++) {
      const a = incrementalPool[i]!;
      const b = incrementalPool[j]!;
      // Skip if both are cached top items (already simmed).
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
    newTrinkets,
    pairsToSim,
  };
}

/**
 * Merge fresh pairs from an incremental sim into the cached pair set,
 * then sort + recompute delta_pct. Pair de-duplication is by `pair_id`
 * — fresh pairs win over cached when the same pair_id is present in
 * both (defensive; shouldn't happen if planTrinketScan filtered
 * correctly, but cheap to guarantee).
 */
export function mergePairResults(
  cachedPairs: readonly TrinketPairResult[],
  freshPairs: readonly TrinketPairResult[],
  /** Identities in the current pool — pairs referencing missing trinkets are dropped. */
  currentIdentities: ReadonlySet<string>,
): TrinketPairResult[] {
  const byId = new Map<string, TrinketPairResult>();
  for (const p of cachedPairs) byId.set(p.pair_id, p);
  for (const p of freshPairs) byId.set(p.pair_id, p);
  const filtered = Array.from(byId.values()).filter(
    (p) =>
      currentIdentities.has(p.trinket1.identity) &&
      currentIdentities.has(p.trinket2.identity),
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
