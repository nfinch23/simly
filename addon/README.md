# Craft Compass — Addon

The in-game half of Craft Compass.

## Install (development)

Copy or symlink this folder into your WoW AddOns directory as
`CraftCompass` (the folder name matters — it must match the `.toc` base
name and the SavedVariables global):

```
World of Warcraft/_retail_/Interface/AddOns/CraftCompass/
  CraftCompass.toc
  CraftCompass.lua
```

On Windows from this repo:

```
mklink /D "C:\Program Files (x86)\World of Warcraft\_retail_\Interface\AddOns\CraftCompass" "<repo>\addon"
```

## Manual test plan

### Phase 0
- [ ] Launch WoW with the addon enabled. Chat frame prints `Craft Compass loaded` on login.
