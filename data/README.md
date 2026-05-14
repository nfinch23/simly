# Data

Static data tables used by the desktop app. Regenerated per WoW patch.

Source: the [Wolkenschutz/KeystoneLoot](https://github.com/Wolkenschutz/KeystoneLoot) fork — actively maintained for Midnight; the upstream `Numynum/KeystoneLoot` stopped at DF S4. Their `data/*.lua` files are parsed by `scripts/regen-content-tables.mjs` and emitted here as JSON.

Files (all generated, do not edit manually):

- `dungeons.json` — current-season M+ dungeon list with per-dungeon item-id loot pools (8 dungeons in Midnight S1).
- `raids.json` — current-tier raid list with per-boss × per-difficulty item-id loot pools (LFR / Normal / Heroic / Mythic).
- `items.json` — item-id → `{ slot_id, slot_name, icon, classes: { classId: [specIds] }, stats }`. Drives class/spec filtering and slot resolution.
- `upgrade-tracks.json` — dungeon/raid upgrade tracks (Champion / Hero / Greatvault / LFR / Normal / Heroic / Mythic) with `bonus_id ↔ ilvl` mapping per rank. Will eventually feed real bonus-id rewriting on the upgrade-priority scan.
- `keystone-mapping.json` — M+ key level → `endOfRun` + `greatVault` tier rules. Translates "I'll run +10 keys" into "drops at Hero rank 3 ilvl."

## Regenerating

Once a patch ships and KeystoneLoot updates (usually within a day or two):

```bash
node scripts/regen-content-tables.mjs
```

Idempotent. Commit the resulting `*.json` files.

## Out of scope

- **World content** — Delves and Ritual Sites aren't in KeystoneLoot. Hand-curated `world-loot.json` is a follow-up slice; the content-tier picker already exposes the toggles so we know the user intent.
- **Currencies** — Dawncrest balances come from the addon at runtime, not a static file.
