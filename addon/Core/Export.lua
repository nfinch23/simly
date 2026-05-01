local addonName, ns = ...

local Export = {}
ns.Export = Export

-- Sentinel returned when we couldn't get a real profile string. The
-- desktop runner falls back to its built-in static profile when it sees
-- this value, so a missing SimulationCraft addon is non-fatal.
local NO_PROFILE = "NO_PROFILE_AVAILABLE"

--- Build a SimC profile string for the active character.
--
-- Delegates to the SimulationCraft addon's public-ish API
-- (`Simulationcraft:GetSimcProfile(...)` defined in core.lua). We treat
-- it as "public-ish" because there's no formal contract — if upstream
-- renames it we'll see runtime errors in BugSack and need to update.
--
-- Wrapped in pcall so an upstream regression or a missing dependency
-- never breaks Simly's logout path. The desktop runner handles the
-- NO_PROFILE_AVAILABLE sentinel by falling back to its static profile.
function Export.BuildProfile()
	local libStub = _G.LibStub
	if not libStub then
		return NO_PROFILE, "LibStub not found (is SimulationCraft addon loaded?)"
	end

	local AceAddon = libStub("AceAddon-3.0", true)
	if not AceAddon then
		return NO_PROFILE, "AceAddon-3.0 not found (SimulationCraft addon missing?)"
	end

	local simc = AceAddon:GetAddon("Simulationcraft", true)
	if not simc or type(simc.GetSimcProfile) ~= "function" then
		return NO_PROFILE, "Simulationcraft:GetSimcProfile is not available"
	end

	local ok, profile, simcError = pcall(simc.GetSimcProfile, simc, false, false, false)
	if not ok then
		return NO_PROFILE, "GetSimcProfile threw: " .. tostring(profile)
	end
	if simcError then
		return NO_PROFILE, "GetSimcProfile error: " .. tostring(simcError)
	end
	if type(profile) ~= "string" or #profile == 0 then
		return NO_PROFILE, "GetSimcProfile returned empty"
	end

	return profile
end

Export.NO_PROFILE = NO_PROFILE
