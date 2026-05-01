# Simly

In-game SimulationCraft answers for World of Warcraft. A WoW addon plus an
Electron desktop companion app that runs SimC locally and writes the
recommendations back into the game as tooltip annotations and an in-game
panel.

See [DESIGN.md](DESIGN.md) for the why and [SCOPE.md](SCOPE.md) for the what.

## Status

Phase 0 — repo bootstrap. Not usable yet.

## Repo layout

- `addon/` — WoW addon (Lua), installs as `Interface/AddOns/Simly/`.
- `addon-results/` — Sister addon that holds the auto-generated results file the desktop overwrites; installs as `Interface/AddOns/SimlyResults/`.
- `desktop/` — Electron + TypeScript + React companion app.
- `shared/` — Cross-package TypeScript types and schemas.
- `data/` — Static data tables (regenerated per WoW patch).

## Quick start (development)

```
npm install
npm run dev
```

`npm run dev` launches the Electron desktop app from `desktop/`.

To load the addon in WoW, copy the `addon/` folder into
`World of Warcraft/_retail_/Interface/AddOns/Simly/` (the folder name
must be `Simly`, with no spaces). Launch WoW; the chat frame should
print `Simly loaded` on login.

## License

MIT — see [LICENSE](LICENSE).
