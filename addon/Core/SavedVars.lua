local addonName, ns = ...

local SCHEMA_VERSION = 2
local DEFAULT_SCENARIO = "single_target_patchwerk"

local SavedVars = {}
ns.SavedVars = SavedVars

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
	}
end

-- Called by the in-game panel's "Update sims" button. Stamps the current
-- time into update_requested_at so the desktop watcher kicks off the
-- scan queue at the next /reload (when SavedVars get flushed to disk).
function SavedVars.RequestUpdate()
	if not SimlyDB then
		-- Snapshot hasn't been taken yet; build one now then stamp.
		SavedVars.WriteSnapshot()
	end
	SimlyDB.update_requested_at = time()
end

-- Back-compat alias. Removed in a later phase.
SavedVars.WritePlaceholder = SavedVars.WriteSnapshot
