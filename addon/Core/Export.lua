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

	return Export.AnnotateEquipLoc(Export.StripJunkBagItems(profile))
end

-- Quality 0 = Poor (gray) per Enum.ItemQuality. These are vendor trash
-- and never worth simming — the desktop's swap-test would just decide
-- they're TRASH, costing 5–15s of SimC for a foregone conclusion.
-- Filter at the source (export string) so they never reach the
-- desktop's pool.
local POOR_QUALITY = 0

--- Strip Poor-quality items from the bags section of a SimC profile.
--
-- Walks line-by-line. Whenever we see a commented item line
-- (`# slot=,id=N,...`), looks up the item's quality via GetItemInfo.
-- If quality is 0, drops that line, the preceding `# Name (ilvl)`
-- header line, and the trailing `#` separator. Equipped items
-- (uncommented `slot=,id=...` lines) are untouched — the filter
-- pattern only matches commented bag entries.
--
-- GetItemInfo returns nil when the client hasn't cached the item yet.
-- For items in the player's bags this is always cached (the bag scan
-- triggered the cache), but as a safety we INCLUDE the item when
-- quality is nil — better to sim once than silently lose a real
-- upgrade.
--
-- Returns the modified profile (or the original if no junk was found).
function Export.StripJunkBagItems(profile)
	if not profile or profile == "" then return profile end

	local lines = {}
	for line in (profile .. "\n"):gmatch("([^\n]*)\n") do
		table.insert(lines, line)
	end

	local out = {}
	local dropped = 0
	local i = 1
	while i <= #lines do
		local line = lines[i]
		-- Match a commented bag item: "# slot=,id=NNNN,..."
		local itemIdStr = line:match("^#%s+[a-z_]+=,id=(%d+)")
		if itemIdStr then
			local _, _, quality = GetItemInfo(tonumber(itemIdStr))
			if quality == POOR_QUALITY then
				-- Drop the preceding "# Name (ilvl)" header we already pushed.
				if #out > 0 and out[#out]:match("^#%s+.+%s%(%d+%)%s*$") then
					table.remove(out)
				end
				-- Skip the trailing "#" separator if present.
				if i + 1 <= #lines and lines[i + 1]:match("^#%s*$") then
					i = i + 1
				end
				dropped = dropped + 1
				i = i + 1
			else
				table.insert(out, line)
				i = i + 1
			end
		else
			table.insert(out, line)
			i = i + 1
		end
	end

	if dropped > 0 then
		DEFAULT_CHAT_FRAME:AddMessage(
			"|cff888888Simly:|r filtered " .. dropped .. " junk-quality bag item" ..
			(dropped == 1 and "" or "s") .. " from the export."
		)
	end

	return table.concat(out, "\n")
end

--- Append `simly_equip_loc=INVTYPE_*` to every item line in the profile.
--
-- The desktop's gear-pruner needs to know whether the recommended
-- main_hand is 2H so it can drop the off_hand from those combos
-- (WoW locks out OH while a 2H is equipped, and SimC sims the OH
-- contribution as zero — wasting iterations on a meaningless slot).
--
-- We attach equipLoc as a trailing key=value on the existing item
-- line. SimC tolerates unknown trailing fields on `slot=,id=...`
-- entries (it parses what it knows and silently drops the rest), so
-- the export is still valid as a SimC profile. Our parser collects
-- unknown fields into ParsedItem.extras, where the pruner reads it
-- as `extras.simly_equip_loc`.
--
-- Walks both equipped lines (`slot=,id=...`) and bag lines
-- (`# slot=,id=...`). GetItemInfo cache miss → skip annotation for
-- that item; the pruner conservatively treats unannotated items as
-- 1H, which means an off-hand might still be paired with a 2H mh
-- in the rare cache-cold case (worst case: SimC wastes a few
-- iterations, no correctness loss).
function Export.AnnotateEquipLoc(profile)
	if not profile or profile == "" then return profile end

	local lines = {}
	for line in (profile .. "\n"):gmatch("([^\n]*)\n") do
		table.insert(lines, line)
	end

	local annotated = 0
	for i, line in ipairs(lines) do
		-- Match equipped or bag-commented item lines. Capture so we
		-- can reconstruct: leading prefix (empty or "# "), slot, id, rest.
		local prefix, body = line:match("^(#?%s*)(%a[%a_]*=,id=%d+.*)$")
		if body and not body:find("simly_equip_loc=", 1, true) then
			local itemIdStr = body:match("id=(%d+)")
			if itemIdStr then
				local _, _, _, _, _, _, _, _, equipLoc = GetItemInfo(tonumber(itemIdStr))
				if equipLoc and equipLoc ~= "" then
					lines[i] = (prefix or "") .. body .. ",simly_equip_loc=" .. equipLoc
					annotated = annotated + 1
				end
			end
		end
	end

	if annotated > 0 then
		-- Quiet log — not noisy enough to merit a chat message every
		-- /reload, but useful for verifying the annotation pipeline
		-- when the user is debugging.
		-- Uncomment if needed:
		-- DEFAULT_CHAT_FRAME:AddMessage("|cff888888Simly:|r annotated " .. annotated .. " items with equip_loc.")
	end

	return table.concat(lines, "\n")
end

Export.NO_PROFILE = NO_PROFILE
