local addonName, ns = ...

local SCHEMA_VERSION = 2
local DEFAULT_SCENARIO = "single_target_patchwerk"

-- All supported scenarios in display order. Key matches the Scenario
-- union type in shared/schema/savedvars.ts; label is shown in the panel.
local SCENARIOS = {
	{ key = "single_target_patchwerk", label = "Single" },
	{ key = "m_plus",                  label = "M+"     },
	{ key = "aoe_cleave",              label = "Cleave"  },
	{ key = "aoe_funnel",              label = "Funnel"  },
}

local SavedVars = {}
ns.SavedVars = SavedVars
SavedVars.SCENARIOS = SCENARIOS

-- Build the full SavedVariables payload for the active character.
-- Called on PLAYER_LOGIN (see Core/Init.lua) once spec data is ready.
-- Asks the SimulationCraft addon for the real profile string; if that
-- fails, writes the NO_PROFILE_AVAILABLE sentinel and the desktop runner
-- falls back to its built-in static profile.
--
-- Schema v2 (see SCOPE.md section 4):
--   - update_requested_at: written by the in-game panel's "Update sims"
--     button. Desktop watcher kicks the scan queue when this is newer
--     than the last completed run.
--   - active_scenario: which scenario the user has selected. v1 only
--     supports single_target_patchwerk; v2 adds m_plus / aoe_*.
--
-- Preserves existing values from the prior session for fields the addon
-- shouldn't overwrite (update_requested_at, active_scenario).
function SavedVars.WriteSnapshot()
	local _, class = UnitClass("player")
	local spec = "Unknown"
	local specIndex = GetSpecialization and GetSpecialization()
	if specIndex then
		local _, specName = GetSpecializationInfo(specIndex)
		if specName then spec = specName end
	end

	local profile, err = ns.Export.BuildProfile()
	if err then
		DEFAULT_CHAT_FRAME:AddMessage("Simly: " .. err .. " — using fallback profile.")
	end

	-- Carry user-controlled fields forward across snapshots.
	local prevUpdateRequestedAt = (SimlyDB and SimlyDB.update_requested_at) or 0
	local prevScenario = (SimlyDB and SimlyDB.active_scenario) or DEFAULT_SCENARIO
	local prevLastSeen = (SimlyDB and SimlyDB.last_seen_generated_at) or 0
	local prevUpdateAllAt = (SimlyDB and SimlyDB.update_all_requested_at) or 0
	local prevUpdateFullSimAt = (SimlyDB and SimlyDB.update_full_sim_requested_at) or 0

	SimlyDB = {
		schema_version = SCHEMA_VERSION,
		exported_at = time(),
		character = {
			name = UnitName("player"),
			realm = GetRealmName(),
			region = (GetCurrentRegion and ({ "us", "kr", "eu", "tw", "cn" })[GetCurrentRegion()]) or "us",
			class = class or "UNKNOWN",
			spec = spec,
			level = UnitLevel("player"),
		},
		simc_export = profile,
		update_requested_at = prevUpdateRequestedAt,
		active_scenario = prevScenario,
		last_seen_generated_at = prevLastSeen,
		update_all_requested_at = prevUpdateAllAt,
		update_full_sim_requested_at = prevUpdateFullSimAt,
	}
end

-- Record that the user has now seen results with the given timestamp.
-- Called by Init.lua after surfacing the "new results" popup so we
-- don't pop it again on subsequent /reloads with the same results.
function SavedVars.MarkSeen(generatedAt)
	if not SimlyDB then SavedVars.WriteSnapshot() end
	SimlyDB.last_seen_generated_at = generatedAt or time()
end

-- Called by the in-game panel's "Update sims" button. Re-snapshots
-- the player's profile (so the SimulationCraft export reflects current
-- bag + equipped state, not the stale snapshot from PLAYER_LOGIN), then
-- stamps update_requested_at so the desktop watcher kicks off the scan
-- queue at the next /reload (when SavedVars get flushed to disk).
--
-- Why we re-snapshot here: the SimulationCraft addon's GetSimcProfile()
-- captures live game state at call time. The user's typical flow is
-- "open bank → put gear in bag → click Update sims". Without a fresh
-- snapshot at click time, the disk write at /reload's PLAYER_LOGOUT
-- step would persist the previous PLAYER_LOGIN's snapshot — which
-- predates the bag changes — and the desktop's quick-sim would see
-- "pool unchanged" and short-circuit.
function SavedVars.RequestUpdate()
	SavedVars.RequestSim("all")
end

-- Generic sim-type request. Stamps update_requested_at + the sim type
-- so the desktop can gate stage execution. Used by every per-sim
-- button in Panel.lua. `simType` matches the SimGroup union in
-- shared/schema/savedvars.ts: "all" / "gear" / "consumables" / "bis"
-- / "dungeons" / "raids" / "crests" (gems/enchants/voidcore reserved
-- for net-new scans in later slices; buttons render disabled today).
function SavedVars.RequestSim(simType)
	SavedVars.WriteSnapshot()
	SimlyDB.update_requested_at = time()
	SimlyDB.requested_sim_type = simType or "all"
	-- Record which scenario this request targets so the addon can scope
	-- the "Scan running" indicator to the right tab. Without this the
	-- request stamp is global and every tab shows yellow until ANY
	-- scenario completes — even though only one is actually queued.
	SimlyDB.update_requested_scenario = SimlyDB.active_scenario
end

-- Returns the currently selected scenario key, defaulting to
-- single_target_patchwerk if SimlyDB hasn't been initialised yet.
function SavedVars.GetScenario()
	return (SimlyDB and SimlyDB.active_scenario) or DEFAULT_SCENARIO
end

-- Switch the active scenario. Takes effect on the next "Update sims" +
-- /reload cycle — does NOT trigger a scan by itself. Calling this only
-- updates the in-memory SimlyDB; WoW writes it to disk at /reload.
function SavedVars.SetScenario(scenarioKey)
	if not SimlyDB then SavedVars.WriteSnapshot() end
	SimlyDB.active_scenario = scenarioKey
end

-- Called by the "Update all sims" button. Queues scans for all 4
-- scenarios on the next /reload cycle.
function SavedVars.RequestUpdateAll()
	SavedVars.WriteSnapshot()
	SimlyDB.update_requested_at = time()
	SimlyDB.update_all_requested_at = time()
	-- Update All targets every scenario; clear the single-scenario hint
	-- so the addon shows "running" on every tab (not just one).
	SimlyDB.update_requested_scenario = nil
end

-- Called by the dev-only "Run Full Sim" button. Triggers the normal
-- quick pipeline followed by a Raidbots-Top-Gear-style full cartesian
-- sim against the same actor — used for accuracy comparison against
-- the greedy heuristic. Re-snapshots so the export reflects current
-- bag state (same rationale as RequestUpdate).
function SavedVars.RequestFullSim()
	SavedVars.WriteSnapshot()
	SimlyDB.update_full_sim_requested_at = time()
end

-- Sentinel value meaning "use the currently-equipped talent string".
-- Mirrors TALENT_LOADOUT_EQUIPPED in shared/schema/savedvars.ts.
local TALENT_EQUIPPED = "equipped"
SavedVars.TALENT_EQUIPPED = TALENT_EQUIPPED

-- Parse the saved loadout names out of a SimC profile string. The
-- SimulationCraft addon emits each saved loadout as a `# Saved Loadout: <name>`
-- comment followed by a `# talents=<string>` line. We only need the
-- names for the picker UI — the desktop side resolves the talent string
-- itself from the same export.
--
-- Returns a Lua array of strings. Empty when the player has no saved
-- loadouts (or simc_export is missing).
function SavedVars.GetSavedLoadoutNames()
	local out = {}
	local export = (SimlyDB and SimlyDB.simc_export) or ""
	if export == "" then return out end
	for name in export:gmatch("#%s+Saved Loadout:%s+([^\n\r]+)") do
		-- Trim trailing whitespace defensively.
		local trimmed = name:gsub("%s+$", "")
		if trimmed ~= "" then
			table.insert(out, trimmed)
		end
	end
	return out
end

-- Get the per-scenario talent loadout selection for the given scenario
-- key. Returns the loadout name (matching one of GetSavedLoadoutNames())
-- or the TALENT_EQUIPPED sentinel when no selection has been made.
function SavedVars.GetTalentLoadoutForScenario(scenarioKey)
	if not SimlyDB or not SimlyDB.talent_loadout_per_scenario then
		return TALENT_EQUIPPED
	end
	return SimlyDB.talent_loadout_per_scenario[scenarioKey] or TALENT_EQUIPPED
end

-- Set the talent loadout for a given scenario. `loadoutName` is either
-- TALENT_EQUIPPED (use the equipped talents) or a name returned by
-- GetSavedLoadoutNames(). Persists in SimlyDB; the desktop picks it up
-- at the next "Update sims" + /reload cycle.
function SavedVars.SetTalentLoadoutForScenario(scenarioKey, loadoutName)
	if not SimlyDB then SavedVars.WriteSnapshot() end
	SimlyDB.talent_loadout_per_scenario = SimlyDB.talent_loadout_per_scenario or {}
	SimlyDB.talent_loadout_per_scenario[scenarioKey] = loadoutName or TALENT_EQUIPPED
end

-- Back-compat alias. Removed in a later phase.
SavedVars.WritePlaceholder = SavedVars.WriteSnapshot
