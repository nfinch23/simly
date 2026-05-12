# Simly — Project Scope

**Product display name:** Simly
**Technical identifier (used in code, file names, addon folder, SavedVariables global):** `Simly` (no spaces)
**Author:** Noah Finch
**License:** MIT

Implementation scope for Claude Code agents. Read [DESIGN.md](DESIGN.md) first for the "why." This file is the "what" and "how."

**Hard rule:** Do not implement features outside this scope without updating this document first. If a task feels like it requires deviating, stop and surface it.

---

## 1. Repo Layout

Monorepo. Two main packages plus shared types.

```
Simly/
├── DESIGN.md                          # The why
├── SCOPE.md                           # This file
├── README.md                          # User-facing install + usage docs
├── CLAUDE.md                          # Agent guidance (update as conventions emerge)
├── .gitignore
├── package.json                       # Root: workspaces + shared scripts
├── tsconfig.base.json                 # Shared TS config
│
├── addon/                             # WoW addon (Lua)
│   ├── Simly.toc                     # Addon manifest, declares Simulationcraft as dep
│   ├── Simly.lua                     # Entry point
│   ├── Core/
│   │   ├── Init.lua                   # Event registration, snapshot retry, panel open
│   │   ├── Export.lua                 # Wraps SimulationCraft addon's GetSimcProfile
│   │   ├── ResultsLoader.lua          # Reads SimlyResults global, exposes scans+composed
│   │   └── SavedVars.lua              # SimlyDB schema, snapshot writer, request trigger
│   ├── UI/
│   │   ├── SlashCommand.lua           # /simly handler
│   │   └── Panel.lua                  # In-game scan-status + composed-loadout panel
│   └── README.md                      # Addon-specific notes
│
├── desktop/                           # Companion app (Electron + TS + React)
│   ├── package.json
│   ├── tsconfig.json
│   ├── electron.vite.config.ts        # electron-vite for build
│   ├── src/
│   │   ├── main/                      # Electron main process
│   │   │   ├── index.ts               # App entry, tray, window mgmt, watcher → queue wiring
│   │   │   ├── watcher.ts             # Watches SavedVariables file
│   │   │   ├── lua-parser.ts          # Wraps `luaparse` for SavedVars
│   │   │   ├── lua-writer.ts          # Serializes results table to Lua
│   │   │   ├── simc-runner.ts         # Spawns SimC subprocess, parses json2 output
│   │   │   ├── simc-installer.ts      # Downloads + extracts SimC builds
│   │   │   ├── simc-bootstrap.ts      # Resolve → install → return binPath
│   │   │   ├── simc-version-source.ts # Strategy interface + LatestNightly/MondayWeekly
│   │   │   ├── simc-paths.ts          # Resolve install root + binary location
│   │   │   ├── scan-queue.ts          # Owns pending scans, runs serially
│   │   │   ├── scans/                 # One file per scan stage
│   │   │   │   ├── registry.ts        # Catalog of all scans
│   │   │   │   ├── stat-weights.ts
│   │   │   │   ├── trinket-pre-scan.ts
│   │   │   │   ├── gear-coarse.ts
│   │   │   │   ├── gear-refined.ts
│   │   │   │   ├── gear-final.ts
│   │   │   │   └── consumables.ts     # flask + food + potion + augrune + gems + enchants
│   │   │   ├── composer.ts            # Combine scan winners into SimlyResults.composed
│   │   │   ├── item-pruner.ts         # Stat-weight × multiplier filter; max-upgrade rewriter
│   │   │   ├── ignore-list.ts         # Persistent (char × scenario × item) ignore map
│   │   │   ├── settings.ts            # All thresholds; backed by electron-store
│   │   │   ├── wow-paths.ts           # Resolves WoW install + WTF folder
│   │   │   └── ipc.ts                 # IPC channel definitions for renderer
│   │   ├── renderer/                  # React UI (Raidbots-style results view)
│   │   │   ├── index.html
│   │   │   ├── main.tsx
│   │   │   ├── App.tsx
│   │   │   ├── views/
│   │   │   │   ├── Status.tsx         # What's running, ETA, queue depth
│   │   │   │   ├── Scans.tsx          # Per-scan results + raw SimC input/output
│   │   │   │   ├── Composed.tsx       # Final assembled loadout
│   │   │   │   ├── PasteInput.tsx     # Paste-a-SimC-string entry point
│   │   │   │   └── Settings.tsx       # All thresholds + ignore list editor
│   │   │   └── components/
│   │   ├── preload/
│   │   │   └── index.ts
│   │   └── shared/                    # Symlink or re-export from /shared
│   └── README.md
│
├── shared/                            # Cross-package types + schemas
│   ├── package.json
│   ├── src/
│   │   ├── schema/
│   │   │   ├── savedvars.ts           # TypeScript type for SavedVars input
│   │   │   ├── results.ts             # TypeScript type for results output
│   │   │   └── question.ts            # Question definition type
│   │   └── index.ts
│   └── tsconfig.json
│
├── data/                              # Static data tables (JSON, regenerated per patch)
│   ├── upgrade-tracks.json            # Map item bonus_id → max upgrade tier (Phase 4)
│   ├── currencies.json                # Voidcore + crest sources (Phase 7 / v2)
│   ├── dungeons.json                  # Dungeon → drops mapping (Phase 7 / v2)
│   └── README.md                      # How to regenerate per patch
│
├── scripts/                           # One-off dev scripts
│   └── README.md
│
└── .github/
    └── workflows/
        ├── addon-package.yml          # Build + upload addon to CurseForge/Wago on tag
        └── desktop-release.yml        # Build + upload desktop installers on tag
```

---

## 2. Tech Stack (Locked)

Do not substitute without updating SCOPE.md.

**Desktop app:**
- Electron (latest stable). Not Tauri — chose Electron because it's better-documented for Claude Code agents and binary size doesn't matter for this use case.
- TypeScript everywhere.
- React 18 for the renderer.
- `electron-vite` for build tooling.
- `chokidar` for file watching.
- `luaparse` for parsing SavedVariables files.
- `node:child_process` for SimC subprocess spawning. No need for `execa`.
- `electron-store` for app config persistence.
- `@octokit/rest` for GitHub Releases API (SimC binary downloads).

**Addon:**
- Plain Lua, no framework. No Ace3 unless we hit a real need (and update this doc).
- Use modern `TooltipDataProcessor` API (post-Dragonflight). Do NOT use legacy `GameTooltip:HookScript("OnTooltipSetItem", ...)` — it was deprecated in 10.0.2.
- **Depend on the SimulationCraft addon** (Unlicense, source: `https://github.com/simulationcraft/simc-addon`) as a hard `## Dependencies:` declaration in `Simly.toc`. Call its public `LibStub("AceAddon-3.0"):GetAddon("Simulationcraft"):GetSimcProfile(...)` API at `PLAYER_LOGOUT` to get the real profile string. Do not vendor — `core.lua` is welded to Ace3 + 6 other libs (~800KB total), and the user community already has the addon installed. Re-evaluate vendoring only if we ever ship Simly to users who don't have SimulationCraft.

**Build / CI:**
- GitHub Actions for both addon packaging (CurseForge + Wago via existing actions) and desktop installers (electron-builder for Windows NSIS).
- Mac/Linux desktop builds: out of scope for v1. Don't write the workflows yet.

**Package manager:** npm (not pnpm/yarn). Most boring choice. Workspaces enabled in root `package.json`.

---

## 3. Module Responsibilities

### Addon modules

| Module | Responsibility |
|---|---|
| `Core/Init.lua` | Register events: `PLAYER_LOGIN`. Capture export with retry-until-spec-ready, write `SimlyDB`. Open panel on /simly. |
| `Core/Export.lua` | Defensive wrapper around SimulationCraft addon's `GetSimcProfile()`. Returns `NO_PROFILE_AVAILABLE` sentinel on failure. |
| `Core/SavedVars.lua` | Define `SimlyDB` schema (section 4). Builds the snapshot at login — character meta + simc_export. The addon's panel writes `update_requested_at` here to trigger sims. |
| `Core/ResultsLoader.lua` | Read `SimlyResults` global from sister addon. Surface `scans`, `composed`, `gear_hash` to UI modules. Detect "stale" by comparing `gear_hash` to a fresh hash of currently equipped+bag items. |
| `UI/Panel.lua` | In-game frame opened by `/simly`. Renders scan status list + composed loadout + "Update sims" button. Click → write `update_requested_at = time()` to SimlyDB; user /reloads. |
| `UI/SlashCommand.lua` | `/simly` opens panel. |

(`UI/Tooltip.lua` remains a Phase 8 stretch — see section 6.)

### Desktop modules

| Module | Responsibility |
|---|---|
| `main/index.ts` | App lifecycle. Tray icon. Boot SimC via `simc-bootstrap`. Wire watcher → scan queue. |
| `main/wow-paths.ts` | Locate WoW install. Default `C:\Program Files (x86)\World of Warcraft\_retail_\`; user-overridable. |
| `main/watcher.ts` | Watch `SavedVariables/Simly.lua`. On change, parse via `lua-parser`. If `update_requested_at > last_completed_at`, enqueue scan plan. |
| `main/lua-parser.ts` / `lua-writer.ts` | Lua ↔ JS conversion for SavedVars (read) and SimlyResults (write). |
| `main/simc-version-source.ts` | Pluggable strategy for "which SimC build to pin to." Default: `LatestNightlyStrategy`. Alternatives: `MondayWeeklyStrategy`, future `ManualPinStrategy`. |
| `main/simc-installer.ts` | Given a `SimcVersionInfo`, download + extract under `%LOCALAPPDATA%\Simly\simc\`. Idempotent. |
| `main/simc-bootstrap.ts` | Resolve current version → install if missing → return `binPath`. Falls back to disk if network is down. |
| `main/simc-runner.ts` | Spawn SimC with given profile + iteration count. Capture json2 output. |
| `main/scan-queue.ts` | Owns the queue. Runs scans serially. Updates `SimlyResults.scans` after each completion. Surfaces progress via IPC. |
| `main/scans/registry.ts` | Catalog of all scans. Each scan = `Scan<TResult>` with `id, buildLines(ctx), parseResult(run), persist(ignoreList, result)`. |
| `main/scans/stat-weights.ts` | Scan #1: SimC `--scale_factors`. Returns per-stat weight table. |
| `main/scans/trinket-pre-scan.ts` | Scan #2: all trinket-pair combos, hold else constant. Update ignore list with losers. |
| `main/scans/gear-coarse.ts` / `gear-refined.ts` / `gear-final.ts` | Scans #3-5: progressive elimination ladder with stat-weight pruning + trinket-from-pre-scan + ignore-list filtering. |
| `main/scans/consumables.ts` | Scan #6: vary flask × food × potion × augrune × gems × enchants on winning gear. |
| `main/composer.ts` | Combine winners across all scans into `SimlyResults.composed`. |
| `main/item-pruner.ts` | Apply stat-weight × `stat_weight_multiplier` filter. Trinkets exempt. Crest-upgrade rewriter (every item promoted to 6/6). |
| `main/ignore-list.ts` | Persistent `(character_key, scenario, item_identity)` → `{ best_delta_pct, times_simmed, manually_removed }`. Add/remove/query. Backed by `electron-store`. |
| `main/settings.ts` | All configurable thresholds (section 6 Phase 4). Backed by `electron-store`. Live-editable from renderer. |
| `main/ipc.ts` | Renderer ↔ main channels: `scan-queue-update`, `scan-result-ready`, `settings-update`, `ignore-list-update`, `paste-simc-profile`. |

---

## 4. SavedVariables Schema (Addon → Desktop)

Canonical. Both sides read/write to this exact shape. Addon writes; desktop reads.

File path: `WTF/Account/<acct>/SavedVariables/Simly.lua`

```lua
SimlyDB = {
  schema_version = 2,
  exported_at = 1714435200,        -- Unix timestamp (UTC), when the export was captured
  character = {
    name = "Charname",
    realm = "Stormrage",
    region = "us",
    class = "WARRIOR",
    spec = "Arms",
    level = 80,
  },
  simc_export = "warrior=\"Charname\"\nlevel=80\nrace=human\n...",  -- Raw SimC profile string

  -- Sim trigger fields. The addon writes here when the user clicks
  -- "Update sims" in the in-game panel; the desktop watcher picks it up.
  update_requested_at = 0,         -- Unix timestamp; > last completed scan run = re-queue scans
  active_scenario = "single_target_patchwerk",  -- v1 only this; v2 adds m_plus, aoe_cleave, aoe_funnel
}
```

**Schema rules:**
- Bump `schema_version` on any breaking change. Desktop must check it and refuse to parse unknown versions.
- `simc_export` is the verbatim string from `Core/Export.lua` — do not reformat.
- `update_requested_at` only triggers a re-queue when newer than the last completed run. Avoids re-running on bare /reload.

---

## 5. Results File Schema (Desktop → Addon)

Canonical. Desktop writes; addon reads.

File path: written into a separate addon folder named `SimlyResults/` (sibling to `Simly/`). The file is `SimlyResults.lua` with a `## SavedVariables` directive in its `.toc` so WoW loads it cleanly. **This is critical:** writing into another addon's folder works, but the cleanest pattern (mirrors TSM_AppHelper) is a dedicated results-only addon.

```
Interface/AddOns/SimlyResults/
├── SimlyResults.toc
└── SimlyResults.lua
```

`SimlyResults.toc`:
```
## Interface: 120000
## Title: Simly Results
## Notes: Auto-generated results file for Simly. Do not edit manually.
## Dependencies: Simly
SimlyResults.lua
```

`SimlyResults.lua` (overwritten by desktop app between scans and on completion):
```lua
SimlyResults = {
  schema_version = 2,
  generated_at = 1714435200,        -- last write
  simc_version = "1205-01 (d6f091a)",
  character_key = "Charname-Stormrage-us",
  active_scenario = "single_target_patchwerk",
  gear_hash = "a8b3...",             -- hash of equipped+bag items at sim time; addon flags "stale" if changes

  -- One scan = one stage of the pipeline. Status updated as each completes.
  scans = {
    stat_weights = {
      status = "done",              -- pending | running | done | failed
      started_at = 1714435100,
      finished_at = 1714435130,
      data = { intellect = 1.00, mastery = 0.74, crit = 0.68, haste = 0.62, versatility = 0.55 },
    },
    trinket_pre_scan = {
      status = "done",
      started_at = ..., finished_at = ...,
      data = {
        winner = { trinket1_item_id = 12345, trinket2_item_id = 67890, dps = 234567 },
        alternatives = {
          { trinket1_item_id = ..., trinket2_item_id = ..., dps = ..., delta_pct = -0.5 },
        },
      },
    },
    gear_coarse = { status = "running", started_at = ... },
    gear_refined = { status = "pending" },
    gear_final = { status = "pending" },
    consumables_gems_enchants = { status = "pending" },
  },

  -- The composed final answer. Addon panel renders this prominently.
  -- Populated incrementally as scans finish; nil/empty until gear_final completes.
  composed = {
    label = "Optimal loadout (single-target Patchwerk)",
    gear = {
      head = { item_id = ..., name = "..." },
      neck = { item_id = ..., name = "..." },
      -- ... all 16 slots
    },
    flask = { item_id = ..., name = "Flask of the Magisters" },
    food = { item_id = ..., name = "Silvermoon Parade" },
    potion = { item_id = ..., name = "..." },
    augment_rune = { item_id = ..., name = "..." },
    gems = { -- per-slot
      neck = { gem_id = ..., name = "..." },
    },
    enchants = { -- per-slot
      back = { enchant_id = ..., name = "..." },
    },
    expected_dps = 234567,
  },
}
```

**Schema rules:**
- One file, one character. Multi-character handling stays out of scope per section 8.
- Always write atomically (temp file + rename) — addon reads must never see a partial write.
- The desktop writes the file between every scan so the addon panel can show progress (e.g., `gear_coarse: running` updates to `done` mid-suite). Addon picks up the update at next /reload.

---

## 6. Build Phases

Each phase is a checkpoint with concrete acceptance criteria. Don't move to phase N+1 until phase N's criteria pass.

### Phase 0 — Repo Bootstrap

**Tasks:**
- Initialize npm workspaces in root `package.json`.
- Set up `shared/` package with TS types from sections 4 and 5.
- Set up `desktop/` package with electron-vite scaffold.
- Stub out `addon/` with empty `.toc` and `Simly.lua` printing "Simly loaded" on login.
- Add `.gitignore` (node_modules, dist, .DS_Store, electron-builder output, WoW SavedVariables test data).
- Write a stub `README.md`.

**Acceptance:**
- `npm install` from root works.
- `npm run dev` in `desktop/` opens an empty Electron window.
- Dropping `addon/` into `Interface/AddOns/Simly/` and launching WoW prints "Simly loaded" to chat.

### Phase 1 — Round-Trip Spike

**Tasks:**
- Addon: on `PLAYER_LOGOUT`, write `SimlyDB.simc_export = "PLACEHOLDER_PROFILE"` and a hardcoded character block to SavedVariables.
- Desktop: tray icon. File watcher on the SavedVariables path (auto-detect WoW install via `wow-paths.ts`; user can override). On change, parse with `luaparse`, log the parsed object to console.
- Desktop: write a fixed `SimlyResults.lua` to a separate `SimlyResults/` addon folder. Hardcoded result.
- Addon: separate `SimlyResults` addon defined per section 5. Main `Simly` addon reads `SimlyResults` global on login and prints "Best flask: <name>" to chat.

**Acceptance:**
- Open WoW → /reload → desktop console logs the parsed SavedVars.
- Trigger desktop to write results → /reload → chat shows "Best flask: <hardcoded name>".
- This confirms the architecture end-to-end **before any real sim integration**.

### Phase 2 — Real SimC Integration

**Tasks:**
- Add `## Dependencies: Simulationcraft` to `Simly.toc`. Create `addon/Core/Export.lua` that defensively wraps `LibStub("AceAddon-3.0"):GetAddon("Simulationcraft"):GetSimcProfile(false, false, false)` (handles the addon being missing or the call failing). Wire it on `PLAYER_LOGOUT` to write the real export into `SimlyDB.simc_export`.
- Desktop: `simc-version-source.ts` defines the strategy interface and ships `GitHubNightlyMondayStrategy` as the default — picks the most recent `simulationcraft/simc` nightly published before Monday 23:00 UTC, holds it for the week. Mirrors Raidbots' "weekly" cadence using SimC's own prebuilt nightlies (no scraping, no compile-from-source).
- Desktop: `simc-installer.ts` consumes a resolved version from the strategy, downloads from GitHub Releases, verifies SHA256, extracts. Keeps previous version on disk for rollback.
- Desktop: `simc-runner.ts` spawns SimC with the exported profile + a single hardcoded "best flask" sim variant (use SimC `profileset.<name>=flask=...` to run all variants in one invocation). Pass `json2=output.json` for deterministic parsing.
- Desktop: parse the result JSON, pick the winner, write to `SimlyResults.lua` per section 5 schema.

**Version-source rationale:** Raidbots does not expose a public "current SimC build" feed (probed thoroughly — only per-report disclosure exists). Their weekly build is compiled from `simulationcraft/simc` `main` on Monday nights. We replicate the cadence using SimC's own nightlies — same source code, same prebuilt artifact pipeline SimC's CI publishes. Result: typically within hours of Raidbots' exact build. The strategy interface stays open so we can swap to a Raidbots-mirror, Discord-webhook, or stable-only source later without touching the runner.

**Acceptance:**
- Real character export from a live WoW session triggers a real SimC run.
- Within ~2 minutes (depending on machine), `SimlyResults.lua` updates with a real recommendation.
- /reload shows the recommendation in chat.

### Phase 3 — In-Game Panel + Scan Queue Plumbing

**Goal:** make the addon's "Update sims" button real, with a panel that displays last-sim status. Results data shape changes here from `questions` to `scans` (see section 5). No real Top Gear yet — the existing `best_flask` / `best_food` questions are wrapped as the first two "scans" so the new pipeline carries data end-to-end before scope grows.

**Tasks:**
- `addon/UI/Panel.lua`: in-game frame opened by `/simly`. Shows: last-sim timestamp per scan, currently-running scan if known, "Update sims" button. Reads from `SimlyResults.scans`. No tooltip integration in this phase.
- `addon/UI/SlashCommand.lua`: `/simly` opens panel.
- `addon/Core/SavedVars.lua`: add `update_requested_at` field. "Update sims" button writes the current timestamp into it.
- Desktop: `main/scan-queue.ts` — owns a queue of scans. `processQueue()` runs scans serially against the shared SimC binary. Status updates fire via IPC and are appended to `SimlyResults.scans` between scans.
- Desktop: refactor `questions/registry.ts` into `scans/registry.ts` — same Question abstraction renamed `Scan<TResult>`. Existing best_flask / best_food become the first two scans.
- Desktop: when watcher sees `update_requested_at` newer than the last completed scan run, kicks off the queue.
- Desktop: separate "Paste SimC string" path in renderer — same queue, different input source.

**Acceptance:**
- `/simly` opens an in-game frame showing scan list + last-updated timestamps + a button.
- Clicking the button + /reload kicks off a sim run; panel shows "running" state.
- Pasting a SimC string into the desktop UI also triggers the queue.
- Existing flask + food results continue to populate.

### Phase 4 — Stat Weights Scan + Top Gear Scan (the heavy lift) — ✅ COMPLETE

**Status: shipped to main as PRs #1, #2, then extended through PRs #3–#6 (Phases 5 + 6).** All sub-phases (4a/4b/4c/4d-i/4d-ii/4d-iii/4e) live, plus a quick-sim gate, persistent gear catalog, weapon-aware cartesian, calibrated stat-weight pruner (Phase 6), and a stack of correctness fixes that emerged during live testing on Felfriend (Demo Warlock). <!-- AUTOSYNC: test_count_desktop -->532<!-- /AUTOSYNC --> desktop unit tests pass. See CLAUDE.md "Phase 4 sub-status" through "Phase 6 sub-status" for per-commit detail.

**Goal:** the actual product. "Given my equipped + bag inventory, find the maximum-DPS gear combo for single-target Patchwerk." Implements the multi-stage scan model with stat-weight pruning and the persistent ignore list.

**v1 assumption — infinite crests:** every item is simmed at its maximum upgrade tier (6/6). Bonus IDs are rewritten on the way into SimC to bump each item to max ilvl. v2 will recommend crest spending; v1 just shows what max-out potential looks like.

**Scans run in order, all written to `SimlyResults.scans`:**

1. **`stat_weights`** — SimC `--scale_factors`. Output: `{ int: 1.00, mastery: 0.74, crit: 0.68, ... }`. ~30s. Recomputed every "Update sims" — they drift as gear changes and are needed for step 3's pruning. Not used as the final answer (stat weights are inaccurate at predicting real DPS); only as a coarse filter.
2. **`trinket_pre_scan`** — All trinket-pair combos from equipped + bags. Hold everything else constant. 3000 iterations per profileset. Top-K trinkets carried forward. Trinkets that lose by more than `ignore_threshold_pct` (default 3%) twice consistently are added to the ignore list with `slot=trinket` flag. Trinkets are NEVER pruned by stat weight — only by simulated DPS — because passive/on-use effects can dominate.
3. **`gear_coarse`** — 1000 iterations. For each non-trinket slot, prune candidates: keep items whose stat-weight score × `stat_weight_multiplier` (default 1.2 — tightened from SCOPE-original 1.5 after observing 27-min runs at 1.5×) is at or above the best item's score in that slot. Trinkets are slotted from the pre-scan winners. Cartesian product of survivors across slots. **2H/1H weapon-aware:** when main_hand pool is mixed, splits into two sub-cartesians (1H mains × off_hand pool; 2H mains × no off_hand) to skip simming structurally-zero off_hand contributions on 2H combos. Pruner reads catalog `trash` classifications and skips those items entirely. Items that lose by more than `ignore_threshold_pct` are added to the ignore list (per scenario, per item identity).
4. **`gear_refined`** — 3000 iterations. Top-N survivors from `gear_coarse` (within ~1% of winner). Tighter ignore-list update.
5. **`gear_final`** — 5000+ iterations. Top-M survivors from `gear_refined` (within 0.5% of winner). Final ranked gear list with sidegrades (anything within 0.1% of the winner counts as tied).
6. **`consumables_gems_enchants`** — 5000 iterations. Take winning gear from `gear_final`. Vary flask × food × potion × augment rune × gem combos × enchant combos. Single profileset sim.

**Composed final answer** (`SimlyResults.composed`): the top combination across all scans. Addon panel renders this prominently.

**Persistent ignore list:**
- Stored via `electron-store`, keyed by `(character_key, scenario, item_identity)`.
- `item_identity = item_id : sorted_bonus_ids : crafted_stats` — crest upgrades naturally produce a new identity.
- An item enters the list when it's `> ignore_threshold_pct` behind the winner in its slot AND has been simmed `>= ignore_after_n_sims` times (default 2).
- "Close-but-lost" items (within `keep_threshold_pct`, default 1%) stay eligible — re-simmed every cycle in case context changed.
- Manually removable from the desktop UI (per-item or "clear all").

**Configurable thresholds (live-editable via the Settings view — see `desktop/src/main/settings.ts` and `desktop/src/renderer/views/Settings.tsx`):**
- `DEFAULT_PRUNER_MULTIPLIER` (default 1.2 — tightened from SCOPE-original 1.5 after live testing showed 1.5 produced ~864-combo cartesians on Felfriend → 27min coarse runs)
- `ignore_threshold_pct` (default 3%, in `gear-catalog.ts` as `trash_threshold_pct`)
- `keep_threshold_pct` (used internally by quick-sim swap-test for sidegrade band; classified as `good` in catalog)
- `tie_window_pct` (default 0.1%, in `gear-catalog.ts`)
- `COARSE_KEEP_THRESHOLD_PCT` (1%, refined re-sims combos within this of coarse winner)
- `REFINED_KEEP_THRESHOLD_PCT` (0.5%, final re-sims combos within this of refined winner)
- Iteration counts: 1000 (coarse), 3000 (refined / `REFINED_ITERATIONS`), 5000 (final / `FINAL_ITERATIONS`)
- `TOP_TRINKETS_TO_KEEP` (4, in `trinket-cache.ts`)
- `ignore_after_n_sims` — deferred; current implementation classifies on first observation (catalog status recomputed on every catalog write).

**Acceptance:**
- "Update sims" runs all six scans in 3-15 minutes against a typical character.
- Each scan's status visible in the in-game panel (pending / running / done with timestamp).
- `SimlyResults.composed` shows the top gear loadout the desktop found.
- Ignore list grows as expected; manually clearing an item in desktop re-includes it next run.
- Crest upgrades (item identity changes) automatically clear the item from ignore (new identity = fresh sim).

### Phase 5 — Desktop UI (Raidbots-style results page)

**Goal:** desktop becomes the "deep dive" view — Raidbots-style results page showing every scan with full DPS tables, raw SimC input that produced it, and settings.

**Tasks:**
- `renderer/views/Status.tsx` — what's running right now, ETA, queue depth.
- `renderer/views/Scans.tsx` — for each scan: status, timestamp, full ranked results table, expandable raw SimC input, expandable raw SimC stdout.
- `renderer/views/Composed.tsx` — the assembled "your optimal loadout" view (mirrors what the addon shows).
- `renderer/views/Settings.tsx` — WoW path, all configurable thresholds (section above), SimC version source toggle, ignore-list editor.
- `renderer/views/PasteInput.tsx` — paste-a-SimC-string entry point.
- IPC channels: `scan-queue-update`, `scan-result-ready`, `settings-update`, `ignore-list-update`.

**Acceptance:**
- Tray click opens the desktop window.
- Each scan visible with full results.
- Editing a threshold in settings persists across restarts and applies on the next "Update sims".
- Manual ignore-list management works.

### Phase 6 — Scenario Selector

**Tasks:**
- Add `scenario` field everywhere: SavedVariables, ignore list keys, `SimlyResults.scans` keyed by scenario.
- Desktop settings: "active scenario" picker. Initially: `single_target_patchwerk` only (v1). Phase 6 adds `m_plus`, `aoe_cleave`, `aoe_funnel`.
- Re-running scans for a new scenario produces a new keyed result set. Both sets persist; addon panel shows the active scenario, can switch.

**Acceptance:**
- Switching scenario in the desktop changes which loadout the addon panel shows on next /reload.
- Each scenario has its own scan history and ignore list.

### Phase 7 — Content Recommender (v2 territory; placeholder)

**Goal:** "Now that I know my optimal loadout, what content do I run to improve it?" Plus crest spending recommendations.

**Tasks (deferred):**
- `data/dungeons.json` from KeystoneLoot data tables.
- `data/currencies.json` (Voidcores etc.) for current patch.
- New scan: `best_content` — for each loot source, simulate the highest-impact possible upgrade and rank.
- New scan: `best_crest_spend` — given current crest balance, simulate which item upgrades produce the biggest DPS gain.
- Settings: "highest content tier I'll do" toggle (Delve +N, M+N, raid difficulty).

**Acceptance:** filled in when v1 phases 3-6 are stable.

### Phase 8 — Stretch goals (no commitment)

- **Tooltips** — hovering items shows the Simly line. Originally Phase 3; demoted because the in-game panel covers the same need without per-tooltip lag risk. Build only if the panel UX leaves something to be desired.
- **Auto-rescan on gear change** — hash equipped+bags on /reload, requeue if changed. Currently manual button only.
- **Multi-character roster** — desktop shows all simmed characters with their last loadouts.
- **Multi-spec per character** — same character, different specs treated as separate keyed result sets.

---

## 7. Conventions

**Lua:**
- Tabs for indentation (matches WoW addon community).
- snake_case for SavedVars keys, PascalCase for module names, camelCase for local variables.
- Always namespace: `local addonName, ns = ...` at top of every file; export via `ns.<ModuleName>`.
- No global pollution beyond `SimlyDB` (SavedVar) and `SimlyResults` (results global from sister addon).
- All event handlers go through `Core/Init.lua`.

**TypeScript:**
- Strict mode on (`"strict": true`).
- Two-space indent, single quotes, trailing commas. Use Prettier defaults.
- ESLint: extend `@electron-toolkit/eslint-config-ts`.
- All IPC channels typed via the `shared/` package.

**Commits:**
- Conventional commits format: `feat(addon):`, `fix(desktop):`, `chore(repo):`, etc.
- One logical change per commit.

**Testing:**
- Desktop: `vitest` for unit tests on lua-parser, lua-writer, question-suite logic. No integration tests for v1 (cost > value for a side project).
- Addon: manual test plan in `addon/README.md` — checklist of "load in-game and verify X."

---

## 8. Out of Scope (Explicit Guardrails for Agents)

**Do not implement these in v1.** If a task seems to require them, surface it.

- Combat-related features. No DPS overlays, no rotation helpers, no ability suggestions during combat. Stay strictly in gearing/utility territory to remain compliant with Midnight addon rules.
- Multi-character handling. v1 = one character at a time. The active character on /reload is the one that gets simmed.
- Multi-spec per character. Same character on a different spec is treated as a new run that overwrites the previous. Multi-spec persistence is Phase 8 stretch.
- Cloud sync, accounts, telemetry. Local files only.
- Real-time sim updates. Every result requires /reload to surface in-game. Do not attempt clever workarounds (chat link parsing, screen scraping, memory hooks).
- Mac / Linux desktop builds for v1. Windows only.
- Mobile companion app. No.
- Custom APL editing. Use whatever APL ships with the SimC binary.
- Talent / build optimization. SimC has this; we are not exposing it in v1.
- Crest spending recommendations. v1 assumes infinite crests (every item simmed at max upgrade tier 6/6). Crest spending recommendations are Phase 7 (v2).
- Content recommender ("what should I run next?"). Phase 7 (v2).
- Multiple scenarios in v1. Single-target Patchwerk only. M+ / cleave / funnel land in Phase 6.
- Tooltip integration on bag items. The in-game panel covers the same need; tooltips are Phase 8 stretch.
- Auto-rescan on gear change. Manual button only in v1; auto-detection is Phase 8 stretch.
- Auction house integration. Wrong project.
- Localization. English only for v1.
- Light/dark theme switching in the desktop UI. Use whatever Electron defaults give.

---

## 9. Per-Patch Maintenance Tasks

These are recurring chores, not features. Document each as it comes up.

- SimC version is auto-pinned by `simc-version-source.ts` (default: latest nightly). Manual bump only needed if the active strategy is "manual pin" or the chosen nightly is broken.
- Regenerate `data/upgrade-tracks.json` for any new item upgrade tracks each major patch (Phase 4 dependency).
- Regenerate `data/dungeons.json` and `data/currencies.json` for the content recommender (Phase 7 / v2).
- Bump addon `## Interface:` version in `.toc` for each WoW patch.

---

## 10. Open Questions for Future Phases

These don't block v1 but should be answered before the relevant phase lands:

- **Phase 4:** how do we accurately rewrite an item's bonus_ids to "max upgraded" for SimC? Each item type has a different upgrade-track encoding; we may need a lookup table per slot/track. Likely sourced from SimC's own data files or `data/`.
- **Phase 4:** progressive elimination ladder needs concrete cull thresholds at each stage. Defaults are listed but real numbers come from observing actual sim behavior on a typical character.
- **Phase 4:** when the trinket pre-scan picks the top trinkets, how many do we carry forward? Top 1 pair is too aggressive (might miss synergies with full gear); top 3 pairs grows the cartesian unnecessarily. Pick a number after observing real data.
- **Phase 5:** in-flight scan progress to the addon needs `SimlyResults.lua` to be re-written between scans. Confirm WoW handles addon-loaded files updating mid-session (the sister-addon load happens at /reload, but reading the global from disk is theoretically possible via custom file IO — needs research).
- **Phase 6:** how should the in-game panel let the user switch active scenario without relying on the desktop being open?
- **Phase 7:** sourcing dungeon loot tables (KeystoneLoot vs first-party SimC data vs Wowhead scrape). Pick after Phase 6.
- **Phase 8:** if/when tooltips ship, performance — registering on every Item tooltip post-call adds ~50µs per hover. Acceptable, but verify no regressions with TipTac/LeatrixPlus.
