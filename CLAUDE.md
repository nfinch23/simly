# Simly — Agent Guidance

**Product display name:** Simly
**Code identifier:** `Simly` (no spaces — used in addon folder, SavedVariables, file names)
**Repo folder name:** `Simly`

## Read these first, in order

1. [DESIGN.md](DESIGN.md) — what we're building and why. Read once for context.
2. [SCOPE.md](SCOPE.md) — implementation scope, repo layout, schemas, build phases, and out-of-scope guardrails. **This is the source of truth for any implementation task.**

If a task seems to conflict with SCOPE.md (different tech, different file layout, out-of-scope feature), stop and surface it. Do not silently deviate.

## Project context

- WoW addon + Electron desktop companion app.
- Goal: in-game tooltip + panel answers to common gearing questions, powered by local SimulationCraft runs.
- Solo player, local files only, no cloud, no telemetry.
- Strictly utility-tier addon (Midnight 12.0 compliance — no combat decision automation).

## Build phase tracking

Current phase: **Phases 4, 5, and 6 all shipped to main. Phase 7 (content recommender) is the next SCOPE-defined milestone but is deferred per SCOPE — pre-v1 polish slices are the active work today.** See SCOPE.md section 6 for acceptance criteria; sub-status sections below show what shipped per phase.

Live status (auto-synced on `/ship` — see "Auto-sync on /ship" section):

- Latest main commit: <!-- AUTOSYNC: latest_main_commit -->8b57180<!-- /AUTOSYNC -->
- Merged PRs: <!-- AUTOSYNC: merged_prs -->1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51<!-- /AUTOSYNC -->
- Last synced: <!-- AUTOSYNC: last_synced_at -->2026-05-15T21:07:38Z<!-- /AUTOSYNC -->

### Phase 3 sub-status (all done)

- **3a (schemas v2 + scans rename)** — `a274b91`
- **3b (scan-queue + update_requested_at gate)** — `ef6c6e4`
- **3c (in-game /simly panel)** — `c93da75`

### Phase 4 sub-status (all done)

- **4a (SimC export parser → typed gear pool)** — `7b773fe`. Parses Felfriend's real export into equipped + bag + poolBySlot with stable item identity hashes.
- **4b (stat weights scan)** — `48bc226`. SimC `--scale_factors` stage runs first, surfaces canonical-keyed StatWeights, panel renders sorted desc.
- **4c (trinket pre-scan)** — `bfa7441`. All unordered trinket pairs from pool, hold else constant, 3000 iter; panel shows winner + 3 alternatives. Trinkets exempt from stat-weight pruning by design.
- **4d-i (gear pruner + cartesian builder)** — `582e70c`. Pure logic, ilvl-based scorer with pluggable `Scorer` type, ring pre-pairing, trinket exemption, deterministic profileset emitter with `maxCombos` safety cap. 25 unit tests.
- **4d-ii (gear_coarse scan + ignore-list scaffolding)** — `951358e`. Pruner wired into a real SimC stage @ 1000 iter; ignore-list `electron-store` module added (write-only at this point).
- **4d-iii (refined + final stages + ignore-list reads)** — `16d1a87`. New `scans/gear-rerank.ts` module shared by both stages: `gear_refined` @ 3000 iter on top 1% of coarse survivors, `gear_final` @ 5000 iter on top 0.5% of refined. Catalog cascade through all three stages; composer prefers final > refined > coarse winner.
- **4e (composer + panel gear render)** — `f48d8bf`. New `composed.gear` field on the SimlyResults schema, rendered in the addon panel as a per-slot list with WoW-character-screen ordering. Green = currently equipped, yellow = recommended-but-not-equipped, "[empty — equip!]" for empty slots with recommendations. Off-hand row hidden when main_hand is 2H.

### Phase 4 polish + correctness fixes (post-4e, all on main)

These shipped during live testing on Felfriend (Demo Warlock, Zul'jin):

- **Persistent gear catalog + quick-sim gate + swap test** — `03cf2f1`. `seen_items` map classifies every simmed item as `best`/`good`/`sidegrade`/`trash`/`unknown`. Quick-sim short-circuits to `up_to_date` (no SimC) when bag pool is unchanged, or `swap_test` (small profileset) when only new items arrived; full pipeline only on the upgrade-cascade or first run.
- **Trinket pre-scan cache + multiplier 1.5 → 1.2** — `5b6bded`. Pool-unchanged ⇒ reuse cached pairs; new trinket(s) ⇒ incremental sim of (new × cached top-4) only. Tightened pruner default after observing 27-min coarse runs.
- **Trinket cache invalidation on gear upgrade** — `cacb9a5`. Cached trinket pairs were sim'd against the prior gear context; invalidate when an upgrade-cascade fires.
- **Catalog `trash` → pruner reads** — `36039a5`. Items the catalog classified as trash skip the next gear_coarse cartesian. Free perf win.
- **2H/1H weapon-aware cartesian split + addon equip_loc annotation** — `5a65c1f`. Addon's Export.lua attaches `simly_equip_loc=INVTYPE_*` to every item line; pruner detects 2H mains and drops off_hand from those combos to avoid simming structurally-zero contributions.
- **Junk filter** — `1db41b2`. Addon strips Poor-quality (gray) bag items from the SimC export before sim — vendor trash never reaches the desktop.
- **Catalog summary in addon panel** — `345a23f`. Per-status grouping with color-coded item names so the user can see `trash`/`good`/`sidegrade` directly in `/simly`.
- **Live SimC progress + heartbeat + window title** — `851eb61`. SimC stdout streams to console with per-stage label + 30s heartbeat so silent-but-alive runs are visible.
- **Lua round-trip fixes** — `29256ce` + `32810e3`. Non-ASCII (em dash etc.) escaped as `\ddd` UTF-8 bytes in lua-writer, parser reinterprets latin1 char codes back to UTF-8 → idempotent across refresh cycles.
- **Refresh path fixes** — `1fc0c54`/`0cb4114`/`8966bae`/`634dc6f`. electron-store ESM interop, fresh `SimlyResults.lua` on quick-sim short-circuit, defensive `?? {}` reads, preserve results.lua across dev restarts.
- **Hide-on-close + single-instance** — `63d373f`. Closing the Simly window hides instead of killing the watcher + queue; second `npm run dev` re-shows the existing instance.
- **Scrollable panel + paper-doll-ordered gear list** — `583543d` + `f48d8bf`/`d4dbea9`/`11e16f6`.

### Refactor (post-Phase-4)

- **scan-queue.ts split** — `4e36f97`. 1469-line file split into:
  - `scan-queue.ts` (~1090 LOC): orchestration only.
  - `composer.ts` (189 LOC, +20 tests): pure data-transformation helpers (composeFromScans, deriveGearFromCatalog, synthesizeResultsFromCatalog, refreshScanTimestamps).
  - `stage-logger.ts` (226 LOC, +12 tests): UI side-effects (makeStageProgressLogger, setWindowTitle, showScanCompleteNotification, formatRelative, isInterestingSimcLine).
  - `store-factories.ts` (39 LOC): lazy `tryCreate*` wrappers.

### Phase 5 sub-status (all done)

- **5a (desktop renderer UI + IPC layer)** — PR #4 (`deec248`). Replaces the passive log view with a Raidbots-style results page: Status / Scans / Composed / PasteInput / Settings tabs. New `preload/index.ts` IPC bridge (`window.simly.*`) with sandboxed `BrowserWindow` and `contextBridge`. Renderer subscribes to `IPC_QUEUE_STATE_CHANGED` for live state pushes. Settings view is wired to `electron-store` so threshold changes apply on next sim.

### Phase 6 sub-status (all done)

- **6a (in-game scenario toggle)** — PR #5 (`ca8ba1e`). 4 scenario buttons in `/simly` panel (Single / M+ / Cleave / Funnel). Click sets `SimlyDB.active_scenario`; desktop reads it on next "Update sims".
- **6b (per-scenario result storage + Update all sims)** — PR #5 (`17697ff`). `SimlyResults` schema bumped to v3 with nested `scenarios` map (`Partial<Record<Scenario, ScenarioResults>>`). Switching scenario buttons shows cached results for that scenario instantly without re-simming. New "Update all sims" button runs all 4 scenarios back-to-back (gated by `update_all_requested_at`). v2-flat results files migrate transparently on read.
- **Calibrated stat-weight pruner** — PR #5 (`b736220`). Replaces the hardcoded 1.5x ilvl multiplier with a DPS-model estimate calibrated against the gear catalog's actual sim history. `computeDpsPerIlvlPct(weights, dps)` + `calibrateFromCatalog(catalog, dpsPerIlvlPct)` derive the pruning threshold from measured prediction error rather than a fixed gap. Falls back to the multiplier when catalog has < 5 simmed items per scenario. 18 new tests; expected M+ gear_coarse speedup once catalog is populated.
- **Renderer state-push fix + addon status block fixes** — PR #5 (`b736220`, `249171c`, `0648df4`). Window show/focus events re-push `QueueState` so the Status tab can't get stuck on `isRunning: true` after a scan completes off-screen. Addon status block now reads `generated_at` from active-scenario bucket with v2 fallback, and compares request to MAX `generated_at` across scenarios so switching to an unscanned scenario doesn't falsely show "Scan running".
- **Update All gate hardening** — PR #5 (`3747b0c`). `lastCompletedAllAt` initialized in constructor (defends against stale `update_all_requested_at` re-firing all 4 scenarios on desktop restart). `runAllScenarios` now bumps both `lastCompletedAt` and `lastCompletedAllAt` (prevents spurious single-scenario replay after Update All). Both caught + fixed inline by /ship's pre-landing review.

### What's next

- **Phase 7 — content recommender** (v2 territory; deferred per SCOPE).
- **Pre-v1 polish slices** are the active work today. Live tracking lives in session memory + the `/loop` skill todos. Known open items at this snapshot: stale desktop window title after scan ends, optional "Force full sim" toggle to bypass quick-sim during testing, end-to-end live verification of the calibrated pruner on a real M+ gear_coarse run.

### Phase 2 prep TODOs (still open)

- When real IPC lands, switch `BrowserWindow` to `sandbox: true` and route everything through `contextBridge` in the preload.
- 6 moderate `npm audit` advisories remain, all from one root cause: `esbuild < 0.24.2` dev-server CVE pulled in transitively via `vite`/`vitest`/`electron-vite`. Dev-server-only, doesn't affect built artifacts. Fix requires `vite@6` + `electron-vite@3` (breaking changes) — defer until we have a reason to touch the build setup, or do it as a focused upgrade PR.

### Test counts

- <!-- AUTOSYNC: test_count_desktop -->646<!-- /AUTOSYNC --> desktop unit tests passing (started Phase 4 with ~100). Major suites: `composer` (20), `gear-pruner` (53 — +18 from Phase 6's calibration), `gear-rerank` (8), `gear-coarse` (4), `gear-catalog` (19), `quick-sim` (9), `swap-test` (13), `trinket-cache` (18), `trinket-pre-scan` (6), `swap-test-result-mapping`, `ignore-list` (12), `stage-logger` (12), `lua-parser` (5), `lua-writer` (9), `simc-export-parser` (20), `simc-runner`/`simc-installer`/`simc-version-source`/`simc-paths`/`simc-bootstrap`/`scan-queue`/`scans/registry`/`scans/index`/`scans/best-flask`/`scans/best-food`/`scans/stat-weights`/`wow-paths`.

## gstack

Use the `/browse` skill from gstack for all web browsing. Never use `mcp__claude-in-chrome__*` tools.

Available gstack skills:
`/office-hours`, `/plan-ceo-review`, `/plan-eng-review`, `/plan-design-review`, `/design-consultation`, `/design-shotgun`, `/design-html`, `/review`, `/ship`, `/land-and-deploy`, `/canary`, `/benchmark`, `/browse`, `/connect-chrome`, `/qa`, `/qa-only`, `/design-review`, `/setup-browser-cookies`, `/setup-deploy`, `/retro`, `/investigate`, `/document-release`, `/codex`, `/cso`, `/autoplan`, `/plan-devex-review`, `/devex-review`, `/careful`, `/freeze`, `/guard`, `/unfreeze`, `/gstack-upgrade`, `/learn`.

## Auto-sync on /ship

Volatile fields in `CLAUDE.md` and `SCOPE.md` are wrapped in HTML comment markers like `<!-- AUTOSYNC: <field-name> -->VALUE<!-- /AUTOSYNC -->`. The `/document-release` subagent dispatched by `/ship` (Step 18) refreshes these on every merge.

On every merge, `document-release` should:
1. Find every `<!-- AUTOSYNC: <field-name> -->...<!-- /AUTOSYNC -->` pair in `CLAUDE.md` and `SCOPE.md`
2. Compute the field's current value:
   - `latest_main_commit` — `git rev-parse --short main` after `git fetch origin main`
   - `test_count_desktop` — last `npm test --workspace desktop` output, the line matching `Tests N passed`
   - `merged_prs` — `gh pr list --repo nfinch23/simly --state merged --limit 50 --json number -q 'map(.number) | join(", ")'`
   - `last_synced_at` — current ISO 8601 UTC timestamp (`date -u +%Y-%m-%dT%H:%M:%SZ`)
3. Replace ONLY the value between the marker pair. Never modify text outside the markers and never edit the marker comments themselves.

When a new phase milestone ships, the slice that ships it manually appends a `### Phase N sub-status (all done)` block to the "Build phase tracking" section above. Auto-sync handles the live counters; the narrative is owned by the slice that introduced the work.

If a `/ship` runs in degraded mode (no VERSION/CHANGELOG, document-release skipped), the slice author must manually invoke `/document-release` after merge to refresh the markers.

## Workflow

This project uses one feature branch per slice.

**At session start, before any work:**
- Read the project-context files listed in "Read these first, in order" above
- Confirm you are on `main` (or the project's default branch) and synced with origin
- Pick the slice name yourself (short kebab-case noun phrase reflecting the work — e.g. `calibrated-pruner`, `m-plus-status-fix`, `auto-name-slices`). Tell the user what you picked in your first response of the session — do not ask them to name it. If the user explicitly says "call this <name>", use their name instead.
- Create the feature branch: `git checkout -b feat/<slice-name>`
- Do not work on the default branch directly
- **Verify (and if needed, repoint) the in-game AddOn junction.** WoW loads addon code from `C:\Program Files (x86)\World of Warcraft\_retail_\Interface\AddOns\Simly`, which is a junction that should point to *this worktree's* `addon/` directory. When a prior worktree gets deleted, the junction goes stale and WoW reports "Simly: Dependency missing" (because it can't even read the .toc) — the symptom is misleading, the cause is a dangling junction. Run the check + auto-fix below; it's idempotent and safe to run unconditionally at session start.

  ```powershell
  $expected = "$PWD\addon"
  $junction = 'C:\Program Files (x86)\World of Warcraft\_retail_\Interface\AddOns\Simly'
  $current = (Get-Item $junction -ErrorAction SilentlyContinue).Target
  if ($current -ne $expected) {
    if (Test-Path $junction) { Remove-Item $junction -Force }
    New-Item -ItemType Junction -Path $junction -Target $expected | Out-Null
    "[junction] repointed Simly addon → $expected"
  } else {
    "[junction] already pointing at this worktree"
  }
  ```

**During the session:**
- Commit per logical unit on the feature branch (a function + its passing test, or a small cohesive change)
- Continuous checkpoint mode is on — auto-`WIP:` commits happen automatically
- Test-first where any test plan flags 3-star coverage
- When you hit a decision the planning docs do not answer, stop and ask the user — do not guess
- Never `git add -A`; stage only files you intentionally changed

**At session end:**
- Confirm all tests pass before declaring done
- Summarize what landed and what (if anything) is still open
- Run `/ship` to push the feature branch and open a PR (note: this project's `/ship` runs in degraded mode without VERSION/CHANGELOG; that's expected for pre-v1)
- After `/ship` completes successfully, run `gh pr merge --squash --delete-branch` to land the slice on the default branch
- Sync the default branch locally:
  - If you are in a worktree where `main` is checked out elsewhere (verify with `git worktree list`), skip the local checkout and instead run `gh pr view <pr> --json mergeCommit` to confirm the merge committed on the remote
  - Otherwise run `git checkout main && git pull` and verify `git log --oneline -3` shows the merged slice
- Override: if the user says "stop after `/ship`, I want to review the PR" or similar, do not run the merge — leave the PR open and the branch checked out

**Commits:**
- Conventional-style messages (`feat:`, `fix:`, `test:`, `chore:`, `docs:`, `refactor:`)
- Keep messages concrete; explain why in the body if the what is obvious from the diff
