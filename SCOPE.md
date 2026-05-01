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
│   ├── Simly.toc                     # Addon manifest
│   ├── Simly.lua                     # Entry point
│   ├── Core/
│   │   ├── Init.lua                   # Addon initialization, event registration
│   │   ├── Export.lua                 # SimC profile export (vendored from SimC addon)
│   │   ├── ResultsLoader.lua          # Loads results table from disk-written file
│   │   └── SavedVars.lua              # SavedVariables schema + accessors
│   ├── UI/
│   │   ├── Tooltip.lua                # GameTooltip post-call hooks
│   │   ├── SlashCommand.lua           # /cc handler (v1)
│   │   └── Panel.lua                  # In-game question picker (v1)
│   ├── Libs/
│   │   └── (vendored deps if any)
│   └── README.md                      # Addon-specific notes
│
├── desktop/                           # Companion app (Electron + TS + React)
│   ├── package.json
│   ├── tsconfig.json
│   ├── electron.vite.config.ts        # electron-vite for build
│   ├── src/
│   │   ├── main/                      # Electron main process
│   │   │   ├── index.ts               # App entry, tray, window mgmt
│   │   │   ├── watcher.ts             # Watches SavedVariables file
│   │   │   ├── lua-parser.ts          # Wraps `luaparse` for SavedVars
│   │   │   ├── lua-writer.ts          # Serializes results table to Lua
│   │   │   ├── simc-runner.ts         # Spawns SimC subprocess, streams output
│   │   │   ├── simc-installer.ts      # Downloads SimC from GitHub Releases
│   │   │   ├── question-suite.ts      # Defines + dispatches the question set
│   │   │   ├── wow-paths.ts           # Resolves WoW install + WTF folder
│   │   │   └── ipc.ts                 # IPC channel definitions for renderer
│   │   ├── renderer/                  # React UI (deep-dive view)
│   │   │   ├── index.html
│   │   │   ├── main.tsx
│   │   │   ├── App.tsx
│   │   │   ├── views/
│   │   │   │   ├── Status.tsx         # Idle / simming / done
│   │   │   │   ├── Queue.tsx          # Sim queue + history
│   │   │   │   ├── Results.tsx        # Last results + raw SimC output
│   │   │   │   └── Settings.tsx       # WoW path, pinned SimC version, etc.
│   │   │   └── components/            # Shared components
│   │   ├── preload/                   # Electron preload bridge
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
│   ├── currencies.json                # Voidcore + currency drop sources
│   ├── dungeons.json                  # Dungeon → drops mapping (cribbed from KeystoneLoot)
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
| `Core/Init.lua` | Register events: `ADDON_LOADED`, `PLAYER_LOGIN`, `PLAYER_LOGOUT`. Load results on login. Trigger export on logout. |
| `Core/Export.lua` | Thin wrapper that calls SimulationCraft addon's `GetSimcProfile()` to produce the simc-format profile string. SimulationCraft is a hard dependency in `Simly.toc`. |
| `Core/SavedVars.lua` | Define `SimlyDB` SavedVariables table. Read/write helpers. |
| `Core/ResultsLoader.lua` | Read `SimlyResults.lua` file (loaded as a separate addon — see section 5) and expose its data via a Lua module. |
| `UI/Tooltip.lua` | Register `TooltipDataProcessor.AddTooltipPostCall` for `Item` tooltips. Look up item ID in results table. Append a `Simly:` line. |
| `UI/SlashCommand.lua` | `/cc` command. v1 only — opens panel. |
| `UI/Panel.lua` | Question picker frame. v1 only. |

### Desktop modules

| Module | Responsibility |
|---|---|
| `main/index.ts` | App lifecycle. Tray icon. Renderer window (hidden by default; tray click toggles). |
| `main/wow-paths.ts` | Locate WoW install. Default to `C:\Program Files (x86)\World of Warcraft\_retail_\`; user-overridable in Settings. |
| `main/watcher.ts` | Watch `WTF/Account/<acct>/SavedVariables/Simly.lua`. Debounce file events (Lua flush is atomic; no need to wait long, but 200ms debounce avoids partial reads). |
| `main/lua-parser.ts` | Parse SavedVars file. Extract `SimlyDB` table. Return typed object. |
| `main/lua-writer.ts` | Serialize a JS object as a Lua source file (top-level `SimlyResults = { ... }`). |
| `main/simc-version-source.ts` | Pluggable strategy that decides _which_ SimC version to pin to. Returns `{ tag, downloadUrl, sha256?, publishedAt }`. Default impl: `GitHubNightlyMondayStrategy` — picks the most recent `simulationcraft/simc` nightly release published before Monday 23:00 UTC, holds it for the week. Other strategies (manual pin, stable-only, future Raidbots-mirror) are swappable behind this interface. |
| `main/simc-installer.ts` | Given a resolved version from `simc-version-source`, download from `simulationcraft/simc` GitHub Releases. Verify SHA256 if provided. Extract to app data dir. Cache previous version for rollback. |
| `main/simc-runner.ts` | Spawn SimC subprocess with profile + APL. Stream stdout for progress. Use `json2=` flag for deterministic output. Parse final JSON for DPS. |
| `main/question-suite.ts` | Define the question set. Each question = `{ id, label, mutateProfile(profile), parseResult(simcOutput) }`. Loop through enabled questions when a new export arrives. |
| `main/ipc.ts` | Renderer ↔ main IPC channels: `sim-status`, `sim-progress`, `sim-result`, `settings-update`. |

---

## 4. SavedVariables Schema (Addon → Desktop)

Canonical. Both sides read/write to this exact shape. Addon writes; desktop reads.

File path: `WTF/Account/<acct>/SavedVariables/Simly.lua`

```lua
SimlyDB = {
  schema_version = 1,
  exported_at = 1714435200,        -- Unix timestamp (UTC)
  character = {
    name = "Charname",
    realm = "Stormrage",
    region = "us",
    class = "WARRIOR",
    spec = "Arms",
    level = 80,
  },
  simc_export = "warrior=\"Charname\"\nlevel=80\nrace=human\n...",  -- Raw SimC profile
  -- Optional: in-game requests for v1
  requests = {                      -- Empty in MVP. v1: addon writes which question to answer.
    -- { id = "best_dungeon", queued_at = 1714435200 },
  },
}
```

**Schema rules:**
- Bump `schema_version` on any breaking change. Desktop must check it and refuse to parse unknown versions.
- `simc_export` is the verbatim string from `Core/Export.lua` — do not reformat.
- `requests` is empty in MVP. v1 populates it from in-game UI clicks.

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

`SimlyResults.lua` (overwritten by desktop app on every sim completion):
```lua
SimlyResults = {
  schema_version = 1,
  generated_at = 1714435200,
  simc_version = "1100-01",
  character_key = "Charname-Stormrage-us",  -- Must match SavedVars character
  questions = {
    best_flask = {
      label = "Best flask",
      best = { item_id = 212265, name = "Phial of Tepid Versatility", dps = 1234567 },
      alternatives = {
        { item_id = 212266, name = "Phial of Elemental Chaos", dps = 1230000, delta_pct = -0.37 },
      },
    },
    best_gems = {
      label = "Best gems",
      slots = {
        { slot = "neck", item_id = 12345, gem_id = 213743, gem_name = "Crystalline Sapphire" },
      },
    },
    -- Additional questions follow same shape: top-level key = question id.
  },
}
```

**Schema rules:**
- One file, one character. If the user plays multiple characters, write character-keyed sub-tables in a future schema bump.
- Always write the full file atomically (temp file + rename) to avoid the addon reading a partial write.

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

### Phase 3 — Tooltip Hook

**Tasks:**
- `addon/UI/Tooltip.lua`: Register `TooltipDataProcessor.AddTooltipPostCall(Enum.TooltipDataType.Item, ...)`. On each item tooltip, look up the item ID in `SimlyResults.questions.best_flask.alternatives` (and `.best`). If matched, append a colored line: `|cff00ff00Simly: best flask (+1.2% DPS)|r` or similar.
- Verify against TipTac, LeatrixPlus loaded — confirm no conflict.

**Acceptance:**
- Hovering any flask in inventory shows a Simly line.
- Best flask shows "(best)"; alternatives show their delta.
- No errors when other tooltip-modifying addons are loaded.

### Phase 4 — Question Suite Expansion

**Tasks:**
- Refactor `simc-runner.ts` and `question-suite.ts` so each "question" is an object with `mutateProfile(profile, candidates)` and `parseResult(output)` methods. Add: `best_flask`, `best_food`, `best_potion`, `best_phial`, `best_weapon_enchant`, `best_gems`.
- Each runs as a separate SimC invocation (or a single multi-profile invocation if SimC supports it cleanly — check `profileset.` syntax in SimC docs first).
- Tooltip hook handles all six question types (consumables + gems).

**Acceptance:**
- Single /reload triggers the full six-question suite.
- All six question types show in tooltips on relevant items.
- Total sim time is acceptable (target: under 10 minutes on mid-range hardware).

### Phase 5 — Desktop UI (Status + History)

**Tasks:**
- `renderer/views/Status.tsx`: shows "Idle / Simming question N of M / Done at HH:MM".
- `renderer/views/Queue.tsx`: simulation queue with progress bars per question.
- `renderer/views/Results.tsx`: last completed results + raw SimC output expandable per question.
- `renderer/views/Settings.tsx`: WoW path override, pinned SimC version toggle, enabled questions checklist.
- IPC channels per `main/ipc.ts`.

**Acceptance:**
- Tray click opens the desktop window.
- Sim progress visible in real time.
- Settings persisted via `electron-store` across app restarts.

### Phase 6 — Dungeon + BiS Questions (data-dependent)

**Tasks:**
- `data/dungeons.json`: seed from KeystoneLoot's data tables (read its addon files; reformat as JSON). One-time port; document the regeneration process in `data/README.md`.
- `data/currencies.json`: hand-curated voidcore-and-similar mapping for current patch.
- `question-suite.ts`: add `best_dungeon` (rank dungeons by expected upgrade DPS delta given currency-aware upgrade simulation) and `bis_for_difficulty` (BiS list filtered by item drop difficulty).
- Settings UI: difficulty filter selector ("Heroic only", "Mythic", "M+ keys up to N", etc.).

**Acceptance:**
- Picking "Heroic only" in settings produces a heroic-only BiS list within the next sim cycle.
- Best-dungeon recommendation reflects current currency drops.

### Phase 7 — In-Game Panel (Approach C transition)

**Tasks:**
- `addon/UI/Panel.lua`: in-game frame opened by `/cc`. Shows the question list, last-updated timestamps per question, and click-to-queue (writes to `SimlyDB.requests`).
- Desktop: when `requests` is non-empty in the SavedVars, prioritize those questions in the next sim cycle.
- Settings UI in addon (basic): which questions to show in tooltips.

**Acceptance:**
- `/cc` opens the panel.
- Queueing a question from the panel and /reloading triggers only that question's sim.
- The casual user can ignore the desktop entirely; the desktop is now optional UI for power users.

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
- Cloud sync, accounts, telemetry. Local files only.
- Real-time sim updates. Every result requires /reload to surface in-game. Do not attempt clever workarounds (chat link parsing, screen scraping, memory hooks).
- Mac / Linux desktop builds for v1. Windows only.
- Mobile companion app. No.
- Custom APL editing. Use whatever APL ships with the SimC binary.
- Talent / build optimization. SimC has this; we are not exposing it in v1. Future scope.
- Auction house integration. Wrong project.
- Localization. English only for v1.
- Light/dark theme switching in the desktop UI. Use whatever Electron defaults give.

---

## 9. Per-Patch Maintenance Tasks

These are recurring chores, not features. Document each as it comes up.

- SimC version is auto-pinned by `simc-version-source.ts` (default: GitHub nightly, Monday-cadence). Manual bump only needed if auto-update is disabled or the chosen nightly is broken.
- Regenerate `data/dungeons.json` from KeystoneLoot's latest data after each major patch.
- Update `data/currencies.json` for new patch currencies.
- Bump addon `## Interface:` version in `.toc` for each WoW patch.

---

## 10. Open Questions for Future Phases

These don't block v1 but should be answered before v2:

- How to surface "your sim is stale; gear changed since last run" to the user.
- Whether to support partial sim reruns (only re-sim affected questions when one item changes).
- Whether to show in-game progress for in-flight sims (likely needs a chat-frame timer hack since IPC is /reload-bound).
- Multi-character roster view in the desktop UI.
- Sharing recommendations between guild members (would require leaving the local-only premise).
