# Craft Compass — Addon

The in-game half of Craft Compass.

This repo ships **two** addon folders that both need to land under
`Interface/AddOns/`:

- `addon/` → `Interface/AddOns/CraftCompass/` (the main addon)
- `addon-results/` → `Interface/AddOns/CraftCompassResults/` (the auto-generated results file the desktop overwrites)

## Install (development)

Symlinks are easier than copying — every code change picks up on the next `/reload`.

From an admin Command Prompt (substitute your repo path):

```
mklink /D "C:\Program Files (x86)\World of Warcraft\_retail_\Interface\AddOns\CraftCompass" "<repo>\addon"
mklink /D "C:\Program Files (x86)\World of Warcraft\_retail_\Interface\AddOns\CraftCompassResults" "<repo>\addon-results"
```

Or copy each folder once to those locations.

## Manual test plan

### Phase 0
- [x] Launch WoW with the addon enabled. Chat frame prints `Craft Compass loaded` on login.

### Phase 1 — Round-trip spike
- [ ] With both addons installed and the desktop running:
  - On login, chat shows `Craft Compass: best flask = Phial of Tepid Versatility` (the hardcoded placeholder result).
  - On `/reload`, the desktop terminal logs the parsed `CraftCompassDB` block.
- [ ] On logout (or `/reload`), `WTF/Account/<acct>/SavedVariables/CraftCompass.lua` is rewritten with a fresh `exported_at` timestamp.
