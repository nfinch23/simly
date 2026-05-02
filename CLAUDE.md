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

Current phase: **Phases 0/1/2 complete; Phase 3 in progress (3a + 3b shipped, 3c started)** — see SCOPE.md section 6 for acceptance criteria.

### Phase 3 sub-status

- **3a (schemas v2 + scans rename) — DONE** — committed at `a274b91`
- **3b (scan-queue + update_requested_at gate) — DONE** — committed at `ef6c6e4`. Confirmed live: `[queue] no new request ... idle` on /reload without a button click.
- **3c (in-game /simly panel) — IN PROGRESS, NOT COMMITTED.** Two files exist as untracked in the worktree:
  - `addon/UI/Panel.lua` — frame skeleton with Best loadout / Scans / SimC version blocks + "Update sims" + "/reload" buttons
  - `addon/UI/SlashCommand.lua` — `/simly [show|hide|toggle]` handler
  - **Still TODO before 3c can ship:**
    1. Add both files to `addon/Simly.toc` load list (Panel.lua before SlashCommand.lua)
    2. Sync into main checkout (`cp` from worktree per the usual git-in-worktree workflow)
    3. Smoke test in WoW: `/simly` opens panel; "Update sims" button bumps `update_requested_at`; `/reload` triggers a sim
    4. Commit the three changes (toc + 2 new Lua files) as Phase 3c
    5. Mark Phase 3 complete + Phase 4 next in this tracker

Update this line as phases complete.

### Phase 2 prep TODOs

- When real IPC lands, switch `BrowserWindow` to `sandbox: true` and route everything through `contextBridge` in the preload.
- 6 moderate `npm audit` advisories remain, all from one root cause: `esbuild < 0.24.2` dev-server CVE pulled in transitively via `vite`/`vitest`/`electron-vite`. Dev-server-only, doesn't affect built artifacts. Fix requires `vite@6` + `electron-vite@3` (breaking changes) — defer until we have a reason to touch the build setup, or do it as a focused upgrade PR.

## gstack

Use the `/browse` skill from gstack for all web browsing. Never use `mcp__claude-in-chrome__*` tools.

Available gstack skills:
`/office-hours`, `/plan-ceo-review`, `/plan-eng-review`, `/plan-design-review`, `/design-consultation`, `/design-shotgun`, `/design-html`, `/review`, `/ship`, `/land-and-deploy`, `/canary`, `/benchmark`, `/browse`, `/connect-chrome`, `/qa`, `/qa-only`, `/design-review`, `/setup-browser-cookies`, `/setup-deploy`, `/retro`, `/investigate`, `/document-release`, `/codex`, `/cso`, `/autoplan`, `/plan-devex-review`, `/devex-review`, `/careful`, `/freeze`, `/guard`, `/unfreeze`, `/gstack-upgrade`, `/learn`.
