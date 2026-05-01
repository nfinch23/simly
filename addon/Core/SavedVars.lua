local addonName, ns = ...

local SCHEMA_VERSION = 1

local SavedVars = {}
ns.SavedVars = SavedVars

-- Phase 1 spike: write a hardcoded SavedVars block so the desktop has
-- something deterministic to parse. Real SimC export wires up in phase 2.
function SavedVars.WritePlaceholder()
	local _, class = UnitClass("player")
	local spec = "Unknown"
	local specIndex = GetSpecialization and GetSpecialization()
	if specIndex then
		local _, specName = GetSpecializationInfo(specIndex)
		if specName then spec = specName end
	end

	CraftCompassDB = {
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
		simc_export = "PLACEHOLDER_PROFILE",
		requests = {},
	}
end
