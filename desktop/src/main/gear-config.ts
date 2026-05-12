/**
 * Centralized configuration for the gear ladder + classification
 * thresholds. SCOPE 4d-iii calls for these to live in a single
 * `gear-config.ts` module so the future Phase 5 settings UI can swap
 * the static defaults for electron-store-backed live-editable values
 * without hunting them down across the codebase.
 *
 * v1: every export is a `const`. Phase 5 will introduce a `getConfig()`
 * accessor that consults electron-store with these as fallback defaults.
 *
 * Keep this file dependency-free (no @simly/shared, no electron) so it
 * can be imported from anywhere in the desktop main process without
 * pulling in side-effecting modules.
 */

// ---------------------------------------------------------------------------
// Gear pruner — coarse-stage cartesian filtering
// ---------------------------------------------------------------------------

/**
 * Multiplier used by the per-slot ilvl pruner. Items survive when
 * `score × multiplier >= slot_max_score`.
 *
 * SCOPE-original was 1.5; tightened to 1.2 after observing 1728-combo
 * cartesians on Felfriend produce 27-min coarse runs at 1.5×. 1.2
 * keeps the iterative dev loop under ~10min while still letting
 * stat-distribution-mismatched items survive long enough for the sim
 * to evaluate them.
 */
export const DEFAULT_PRUNER_MULTIPLIER = 1.2;

/**
 * Hard cap on the gear cartesian. Buildings beyond this throw — caller
 * tightens the multiplier or uses a smaller pool. 5000 combos × 1000
 * iter ≈ many hours; deliberately conservative as a safety rail.
 */
export const DEFAULT_MAX_COMBOS = 5000;

// ---------------------------------------------------------------------------
// Catalog classification (gear-catalog.ts)
// ---------------------------------------------------------------------------

/**
 * Items within ±tie_window_pct of the winner are 'sidegrade' —
 * functionally equivalent on DPS, pick by other criteria
 * (transmog, set bonus, secondary stat preference, etc.).
 */
export const TIE_WINDOW_PCT = 0.1;

/**
 * Items within tie_window..good_threshold of the winner are 'good' —
 * close-but-lost contenders. Re-eligible for future cartesians; could
 * win in a different stat-weights regime.
 */
export const GOOD_THRESHOLD_PCT = 1;

/**
 * Items losing by more than this are 'trash' — consistently outclassed.
 * Excluded from future cartesians (the gear-coarse pruner reads catalog
 * trash classifications and skips those identities).
 */
export const TRASH_THRESHOLD_PCT = 3;

// ---------------------------------------------------------------------------
// Gear ladder (refined + final stages, scan-queue.ts)
// ---------------------------------------------------------------------------

/** Refined re-sims combos within this delta of the coarse-stage winner. */
export const COARSE_KEEP_THRESHOLD_PCT = 1;

/** Final re-sims combos within this delta of the refined-stage winner. */
export const REFINED_KEEP_THRESHOLD_PCT = 0.5;

/** Iterations per profileset for each ladder stage. */
export const COARSE_ITERATIONS = 1000;
export const REFINED_ITERATIONS = 3000;
export const FINAL_ITERATIONS = 5000;

// ---------------------------------------------------------------------------
// Trinket cache (trinket-cache.ts)
// ---------------------------------------------------------------------------

/**
 * Number of "leader" trinkets carried forward from one full sim to the
 * next. New trinkets are simmed against these (incremental path) rather
 * than against the entire historical pool.
 */
export const TOP_TRINKETS_TO_KEEP = 4;

/** Iterations per profileset for the trinket pre-scan stage. */
export const TRINKET_ITERATIONS = 3000;

// ---------------------------------------------------------------------------
// Quick-sim swap test (swap-test.ts)
// ---------------------------------------------------------------------------

/**
 * Iterations per profileset for the swap-test stage. Smaller profileset
 * count than gear_coarse (typically 1-5 vs hundreds) means we can
 * afford more iterations for a decisive verdict.
 */
export const SWAP_TEST_ITERATIONS = 2000;

// ---------------------------------------------------------------------------
// OH sub-sim (oh-pairing.ts; consumed by greedy-search.ts)
// ---------------------------------------------------------------------------

/**
 * % below the best-predicted OH score that counts as "close." When
 * multiple OHs are within this band, greedy emits one `(mh, oh)` swap
 * per close partner instead of locking the single best — letting the
 * sim resolve close calls instead of trusting the stat-vector estimate.
 *
 * Stat-vector predictions are an approximation: OH stat budgets are
 * small (~5-10% of MH) and on-use / proc effects are invisible to the
 * dot product. 1.0% is wider than the catalog tie window (0.1%) but
 * tighter than the gear-coarse keep threshold (1%) — captures the
 * cases where prediction noise could realistically flip the winner.
 */
export const OH_SUBSIM_TIE_PCT = 1.0;

/**
 * Hard cap on how many close OHs greedy will sub-sim for a single MH.
 * Combinatorial growth: 5 MH candidates × 3 OH partners = 15 weapon
 * profilesets per greedy iter. Three keeps the budget bounded while
 * giving room for an MH whose top partners are genuinely close.
 */
export const OH_SUBSIM_MAX_PARTNERS = 3;

// ---------------------------------------------------------------------------
// Ignore list (ignore-list.ts)
// ---------------------------------------------------------------------------

/**
 * Items losing by more than this delta_pct get a row in the ignore-list
 * store. v1 uses this same value as the catalog's trash threshold for
 * consistency; could diverge if SCOPE settings UI separates them.
 */
export const IGNORE_THRESHOLD_PCT = TRASH_THRESHOLD_PCT;
