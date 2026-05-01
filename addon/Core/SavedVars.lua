local addonName, ns = ...

local SCHEMA_VERSION = 1

local SavedVars = {}
ns.SavedVars = SavedVars

-- Build the full SavedVariables payload for the active character.
-- Called on PLAYER_LOGOUT (see Core/Init.lua). Asks the SimulationCraft
-- addon for the real profile string; if that fails, writes the
-- NO_PROFILE_AVAILABLE sentinel and the desktop runner falls back to
-- its built-in static profile.
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
		requests = {},
	}
end

-- Back-compat alias. Old call sites still using WritePlaceholder() get
-- the new behavior; can be removed once Init.lua updates and ships.
SavedVars.WritePlaceholder = SavedVars.WriteSnapshot
