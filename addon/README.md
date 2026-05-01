# Simly — Addon

The in-game half of Simly.

This repo ships **two** addon folders that both need to land under
`Interface/AddOns/`:

- `addon/` → `Interface/AddOns/Simly/` (the main addon)
- `addon-results/` → `Interface/AddOns/SimlyResults/` (the auto-generated results file the desktop overwrites)

## Install (development)

Symlinks are easier than copying — every code change picks up on the next `/reload`.

From an admin Command Prompt (substitute your repo path):

```
mklink /D "C:\Program Files (x86)\World of Warcraft\_retail_\Interface\AddOns\Simly" "<repo>\addon"
mklink /D "C:\Program Files (x86)\World of Warcraft\_retail_\Interface\AddOns\SimlyResults" "<repo>\addon-results"
```

Or copy each folder once to those locations.

## Manual test plan

### Phase 0
- [x] Launch WoW with the addon enabled. Chat frame prints `Simly loaded` on login.

### Phase 1 — Round-trip spike
- [ ] With both addons installed and the desktop running:
  - On login, chat shows `Simly: best flask = Phial of Tepid Versatility` (the hardcoded placeholder result).
  - On `/reload`, the desktop terminal logs the parsed `SimlyDB` block.
- [ ] On logout (or `/reload`), `WTF/Account/<acct>/SavedVariables/Simly.lua` is rewritten with a fresh `exported_at` timestamp.
