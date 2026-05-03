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

Current phase: **Phases 0/1/2/3 + 4a/4b/4c complete; Phase 4d (gear ladder + ignore list) next, split into 4d-i / 4d-ii / 4d-iii** — see SCOPE.md section 6 for acceptance criteria.

### Phase 3 sub-status (all done)

- **3a (schemas v2 + scans rename)** — `a274b91`
- **3b (scan-queue + update_requested_at gate)** — `ef6c6e4`
- **3c (in-game /simly panel)** — `c93da75`

### Phase 4 sub-status

- **4a (SimC export parser → typed gear pool)** — `7b773fe`. Parses Felfriend's real export into equipped + bag + poolBySlot with stable item identity hashes.
- **4b (stat weights scan)** — `48bc226`. SimC `--scale_factors` stage runs first, surfaces canonical-keyed StatWeights, panel renders sorted desc.
- **4c (trinket pre-scan)** — `bfa7441`. All unordered trinket pairs from pool, hold else constant, 3000 iter; panel shows winner + 3 alternatives. Trinkets exempt from stat-weight pruning by design.
- **4d (gear ladder + ignore list)** — NEXT. Split into:
  - **4d-i**: pruning + cartesian product builder (pure logic, no SimC). Take parsed gear pool + stat weights, score per slot, prune by `multiplier × top_score` (default 1.5×, configurable). Trinkets fixed from 4c winner. Generate cartesian-product profilesets. Heavy unit tests.
  - **4d-ii**: first gear scan integration. Wire the 4d-i pruner into a new `gear_coarse` scan @ 1000 iter. Surface result. Add electron-store ignore-list scaffolding (write-only).
  - **4d-iii**: refined + final stages + ignore-list reads. `gear_refined` @ 3000 iter on top survivors, `gear_final` @ 5000 iter with sidegrade window (0.1%). Pruner consults ignore-list.
- **4e (composer + panel gear render)** — pending after 4d. Assemble final loadout into `composed.gear`, render in panel.

### Polish that landed alongside Phase 4

- `0ca1881`: SecureActionButton fix for ReloadUI() in panel buttons
- `97cffee` / `edc3ae0` / `3cd619f`: live status indicator in panel + window title updates + flashFrame
- `7360249` / `628f206`: node-notifier for Windows toasts (electron's native API drops them in dev)
- `91e8c8e`: in-game "fresh results" popup with sound on PLAYER_LOGIN when SimlyResults.generated_at > last_seen_generated_at
- `ff8f566`: replaced "Phase 0 — empty window" renderer text with usage instructions

Update this line as phases complete.

### Phase 2 prep TODOs

- When real IPC lands, switch `BrowserWindow` to `sandbox: true` and route everything through `contextBridge` in the preload.
- 6 moderate `npm audit` advisories remain, all from one root cause: `esbuild < 0.24.2` dev-server CVE pulled in transitively via `vite`/`vitest`/`electron-vite`. Dev-server-only, doesn't affect built artifacts. Fix requires `vite@6` + `electron-vite@3` (breaking changes) — defer until we have a reason to touch the build setup, or do it as a focused upgrade PR.

## gstack

Use the `/browse` skill from gstack for all web browsing. Never use `mcp__claude-in-chrome__*` tools.

Available gstack skills:
`/office-hours`, `/plan-ceo-review`, `/plan-eng-review`, `/plan-design-review`, `/design-consultation`, `/design-shotgun`, `/design-html`, `/review`, `/ship`, `/land-and-deploy`, `/canary`, `/benchmark`, `/browse`, `/connect-chrome`, `/qa`, `/qa-only`, `/design-review`, `/setup-browser-cookies`, `/setup-deploy`, `/retro`, `/investigate`, `/document-release`, `/codex`, `/cso`, `/autoplan`, `/plan-devex-review`, `/devex-review`, `/careful`, `/freeze`, `/guard`, `/unfreeze`, `/gstack-upgrade`, `/learn`.
