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
import { TOP_TRINKETS_TO_KEEP as TOP_FROM_CONFIG } from './gear-config';

/**
 * Number of "leader" trinkets carried forward from one full sim to the
 * next. Re-exported from gear-config.ts so callers don't need a config
 * import; canonical value lives there.
 */
export const TOP_TRINKETS_TO_KEEP = TOP_FROM_CONFIG;

export interface TrinketCacheEntry {
  character_key: string;
  scenario: string;
  /** Sorted list of every trinket identity that was simmed. Used as the
   * change-detection signature (pool unchanged ⇒ same signature). */
  pool_signature: string;
  /**
   * Hash of the actor's gear context at the time of the sim. Empty
   * string for the "baseline" context (pass-1 of the two-pass-stat-
   * reconverge pipeline, OR any pre-reconverge orchestrator). Pass-2
   * stores a `hashGearContext()` of the converged gear so its results
   * cache independently from pass-1.
   *
   * Optional + defaulted to empty string for back-compat: orchestrators
   * that never set a hash get the same cache slot as legacy single-pass
   * code.
   */
  gear_context_hash?: string;
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

/**
 * Build the cache key tuple. `gear_context_hash` is part of the key
 * (not just the entry payload) so pass-1 and pass-2 of the two-pass
 * stat-reconverge pipeline cache independently — same character, same
 * scenario, different converged actor → different entries.
 *
 * Back-compat: empty/undefined hash collapses to the legacy two-part
 * key. Existing cache files keep working without invalidation.
 */
function makeCacheKey(
  character_key: string,
  scenario: string,
  gear_context_hash?: string,
): string {
  const base = `${character_key}${KEY_SEP}${scenario}`;
  if (!gear_context_hash) return base;
  return `${base}${KEY_SEP}${gear_context_hash}`;
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

  get(
    character_key: string,
    scenario: string,
    gear_context_hash?: string,
  ): TrinketCacheEntry | undefined {
    // electron-store's `defaults` apply on first construction but a
    // file-system-side delete (e.g., user wiping cache for testing)
    // can leave the in-memory cache with no `entries` key. Defaulting
    // here keeps callers from seeing undefined.
    const entries = this.store.get('entries') ?? {};
    return entries[makeCacheKey(character_key, scenario, gear_context_hash)];
  }

  put(entry: TrinketCacheEntry): void {
    this.store.set(
      `entries.${makeCacheKey(entry.character_key, entry.scenario, entry.gear_context_hash)}`,
      entry,
    );
  }

  clear(): void {
    this.store.set('entries', {});
  }

  /**
   * Invalidate one (character, scenario, optional gear-context)'s
   * cache. Called by the scan queue when a gear upgrade is detected —
   * the cached trinket pairs were sim'd with the prior gear context,
   * so even though the trinket POOL is unchanged, the relative
   * rankings may have shifted. Removing the entry forces the next
   * trinket_pre_scan to do a fresh full sim with the new context.
   *
   * When `gear_context_hash` is omitted, only the baseline-keyed entry
   * is removed (mirrors legacy single-pass semantics). Pass-callers
   * can clear their specific slot by supplying the hash.
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
   * orchestrator — every cached pass's results are stale relative to
   * the new converged actor.
   */
  invalidateAllContexts(character_key: string, scenario: string): void {
    const entries = this.store.get('entries') ?? {};
    const next: Record<string, TrinketCacheEntry> = {};
    const baseKey = makeCacheKey(character_key, scenario);
    for (const [k, v] of Object.entries(entries)) {
      if (k === baseKey || k.startsWith(`${baseKey}${KEY_SEP}`)) continue;
      next[k] = v;
    }
    this.store.set('entries', next);
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
  /**
   * Optional gear-context axis on the cache key. Pass-1 of two-pass-
   * stat-reconverge omits this (baseline equipped gear). Pass-2 sets
   * it to `hashGearContext(converged_gear)` so its sim caches
   * independently.
   */
  gear_context_hash?: string;
}

export function planTrinketScan(opts: PlanTrinketScanOptions): TrinketSimPlan {
  const trinkets = [...opts.trinkets];
  if (trinkets.length < 2) {
    return { kind: 'full', trinkets, reason: 'fewer than 2 trinkets in pool' };
  }
  const cached = opts.cache.get(
    opts.character_key,
    opts.scenario,
    opts.gear_context_hash,
  );
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
