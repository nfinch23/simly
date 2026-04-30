# WowSim — Agent Guidance

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

Current phase: **Phase 0 (repo bootstrap)** — see SCOPE.md section 6 for acceptance criteria.

Update this line as phases complete.

## gstack

Use the `/browse` skill from gstack for all web browsing. Never use `mcp__claude-in-chrome__*` tools.

Available gstack skills:
`/office-hours`, `/plan-ceo-review`, `/plan-eng-review`, `/plan-design-review`, `/design-consultation`, `/design-shotgun`, `/design-html`, `/review`, `/ship`, `/land-and-deploy`, `/canary`, `/benchmark`, `/browse`, `/connect-chrome`, `/qa`, `/qa-only`, `/design-review`, `/setup-browser-cookies`, `/setup-deploy`, `/retro`, `/investigate`, `/document-release`, `/codex`, `/cso`, `/autoplan`, `/plan-devex-review`, `/devex-review`, `/careful`, `/freeze`, `/guard`, `/unfreeze`, `/gstack-upgrade`, `/learn`.
