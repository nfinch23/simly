/**
 * Phase 4d-ii — persistent ignore list, write-only API.
 *
 * Tracks `(character_key, scenario, item_identity)` rows. After a gear
 * ladder run, the queue calls `recordObservations` with each item's
 * best delta-pct across all combos containing it. Items that lost by
 * more than `ignore_threshold_pct` (default 3%) get a row written /
 * incremented; items within the keep window are not recorded.
 *
 * 4d-iii adds `getIgnoredIdentities()` reads — at that point the
 * pruner consults this store before scoring. Today this module just
 * builds up history.
 *
 * Backed by electron-store. The store path is overridable via `cwd`
 * so tests can point it at a temp directory; production lets
 * electron-store default to `app.getPath('userData')`.
 */

// electron-store@11 is ESM-only with a default export. electron-vite
// externalizes deps into a CJS main bundle, so the import is resolved
// at runtime via Node's CJS->ESM interop. Depending on the path, the
// constructor lands at `module`, `module.default`, or
// `module.default.default` (double-wrapping happens when `esModuleInterop`
// emits `__importDefault` around an already-wrapped namespace). Probe
// all three rather than fight the bundler interop matrix.
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

export interface IgnoreEntry {
  /** `Charname-Realm-region` style — matches `SimlyResults.character_key`. */
  character_key: string;
  /** v1 always 'single_target_patchwerk'. */
  scenario: string;
  /** Stable identity hash from the parser. */
  item_identity: string;
  /** Item id (informational; identity is the lookup key). */
  item_id: number;
  /** Friendly name for display. */
  name: string;
  /** SimC slot name. */
  slot: string;
  /**
   * Best (= least-negative) delta_pct ever observed for this item. -3.5
   * means "even the best combo containing this item lost by 3.5%". A
   * value of 0 or positive would not have been recorded — items only
   * land here when they consistently lose.
   */
  best_delta_pct: number;
  /** Number of times this item has been simmed and lost. */
  times_simmed: number;
  /** True if the user manually marked this item as "do not ignore". */
  manually_removed?: boolean;
  /** Last time we observed this item losing. Unix seconds. */
  last_seen_at: number;
}

interface Schema {
  entries: Record<string, IgnoreEntry>;
}

const KEY_SEP = '|';

export function makeIgnoreKey(
  character_key: string,
  scenario: string,
  item_identity: string,
): string {
  return `${character_key}${KEY_SEP}${scenario}${KEY_SEP}${item_identity}`;
}

export interface IgnoreListOptions {
  /**
   * Override electron-store's default `app.getPath('userData')` location.
   * Required in tests (no electron app context). Production passes
   * undefined and lets electron-store resolve.
   */
  cwd?: string;
  /** Override the store filename. Default: 'ignore-list'. */
  name?: string;
}

export class IgnoreListStore {
  private readonly store: ElectronStore<Schema>;

  constructor(opts: IgnoreListOptions = {}) {
    const StoreClass = resolveStoreCtor();
    this.store = new StoreClass<Schema>({
      name: opts.name ?? 'ignore-list',
      cwd: opts.cwd,
      defaults: { entries: {} },
    });
  }

  /**
   * Record one item's loss. If a row already exists, increment
   * times_simmed and tighten best_delta_pct to the least-negative seen.
   * If `delta_pct` is >= -ignore_threshold_pct, the call is a no-op
   * (we only track items that lost meaningfully).
   */
  recordObservation(input: {
    character_key: string;
    scenario: string;
    item_identity: string;
    item_id: number;
    name: string;
    slot: string;
    delta_pct: number;
    /** Threshold above which an item counts as "consistently losing". Default 3. */
    ignore_threshold_pct?: number;
  }): void {
    const threshold = input.ignore_threshold_pct ?? 3;
    if (input.delta_pct > -threshold) return;

    const key = makeIgnoreKey(input.character_key, input.scenario, input.item_identity);
    const entries = this.store.get('entries') ?? {};
    const existing = entries[key];
    const now = Math.floor(Date.now() / 1000);
    const next: IgnoreEntry = existing
      ? {
          ...existing,
          // Best (least-negative) delta seen — if this run was less bad
          // than a prior one, that's still bad enough to track.
          best_delta_pct: Math.max(existing.best_delta_pct, input.delta_pct),
          times_simmed: existing.times_simmed + 1,
          last_seen_at: now,
        }
      : {
          character_key: input.character_key,
          scenario: input.scenario,
          item_identity: input.item_identity,
          item_id: input.item_id,
          name: input.name,
          slot: input.slot,
          best_delta_pct: input.delta_pct,
          times_simmed: 1,
          last_seen_at: now,
        };
    this.store.set(`entries.${key}`, next);
  }

  /** Bulk write helper — used by the scan queue after a gear stage. */
  recordObservations(
    inputs: Array<Parameters<IgnoreListStore['recordObservation']>[0]>,
  ): void {
    for (const input of inputs) this.recordObservation(input);
  }

  /** List entries, optionally filtered. Useful for the renderer's settings view (Phase 5). */
  list(filter?: { character_key?: string; scenario?: string }): IgnoreEntry[] {
    const out: IgnoreEntry[] = [];
    for (const entry of Object.values(this.store.get('entries') ?? {})) {
      if (filter?.character_key && entry.character_key !== filter.character_key) continue;
      if (filter?.scenario && entry.scenario !== filter.scenario) continue;
      out.push(entry);
    }
    return out;
  }

  /** Single-row lookup — 4d-iii uses this to short-circuit the pruner. */
  get(character_key: string, scenario: string, item_identity: string): IgnoreEntry | undefined {
    const key = makeIgnoreKey(character_key, scenario, item_identity);
    return (this.store.get('entries') ?? {})[key];
  }

  /** Wipe all rows. Used by tests; renderer settings will expose this in Phase 5. */
  clear(): void {
    this.store.set('entries', {});
  }

  /** Mark a row as manually removed; pruner ignores it on read in 4d-iii. */
  markManuallyRemoved(character_key: string, scenario: string, item_identity: string): void {
    const key = makeIgnoreKey(character_key, scenario, item_identity);
    const entries = this.store.get('entries') ?? {};
    const existing = entries[key];
    if (!existing) return;
    this.store.set(`entries.${key}`, { ...existing, manually_removed: true });
  }
}

/**
 * Compute per-item best delta from a gear scan's combos. Each item
 * appearing in any combo gets one row keyed by identity; the recorded
 * delta_pct is the best (least-negative) delta among combos containing
 * that item. Trinkets are excluded — the 4c pre-scan owns trinket
 * elimination decisions.
 */
export function computeItemObservations(
  combos: ReadonlyArray<{
    delta_pct: number;
    items: ReadonlyArray<{ slot: string; item: { item_id: number; name: string; identity: string } }>;
  }>,
): Array<{
  item_identity: string;
  item_id: number;
  name: string;
  slot: string;
  delta_pct: number;
}> {
  const best = new Map<
    string,
    { item_id: number; name: string; slot: string; delta_pct: number }
  >();
  for (const combo of combos) {
    for (const ref of combo.items) {
      if (ref.slot === 'trinket1' || ref.slot === 'trinket2') continue;
      const cur = best.get(ref.item.identity);
      if (!cur || combo.delta_pct > cur.delta_pct) {
        best.set(ref.item.identity, {
          item_id: ref.item.item_id,
          name: ref.item.name,
          slot: ref.slot,
          delta_pct: combo.delta_pct,
        });
      }
    }
  }
  return Array.from(best.entries()).map(([identity, v]) => ({
    item_identity: identity,
    item_id: v.item_id,
    name: v.name,
    slot: v.slot,
    delta_pct: v.delta_pct,
  }));
}
