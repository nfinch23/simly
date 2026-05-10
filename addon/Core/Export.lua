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

	return Export.AnnotateItemStats(Export.AnnotateEquipLoc(Export.StripJunkBagItems(profile)))
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

--- INVSLOT_ constant for each SimC slot name. Used to fetch
-- `GetInventoryItemLink("player", N)` so we can call GetItemStats with
-- the FULL bonus-id-aware itemLink (item IDs alone return wrong stats
-- for upgraded gear).
local SIMC_SLOT_TO_INVSLOT = {
	head      = 1,
	neck      = 2,
	shoulder  = 3,
	shirt     = 4,
	chest     = 5,
	waist     = 6,
	legs      = 7,
	feet      = 8,
	wrist     = 9,
	hands     = 10,
	finger1   = 11,
	finger2   = 12,
	trinket1  = 13,
	trinket2  = 14,
	back      = 15,
	main_hand = 16,
	off_hand  = 17,
	tabard    = 19,
}

--- Map of GetItemStats key → short stat name we emit in simly_stats=.
-- Versatility's rating key changed across WoW versions; we accept both
-- ITEM_MOD_VERSATILITY and ITEM_MOD_VERSATILITY_RATING_SHORT.
local STAT_KEY_MAP = {
	ITEM_MOD_INTELLECT_SHORT          = "int",
	ITEM_MOD_STRENGTH_SHORT           = "str",
	ITEM_MOD_AGILITY_SHORT            = "agi",
	ITEM_MOD_HASTE_RATING_SHORT       = "haste",
	ITEM_MOD_CRIT_RATING_SHORT        = "crit",
	ITEM_MOD_MASTERY_RATING_SHORT     = "mast",
	ITEM_MOD_VERSATILITY              = "vers",
	ITEM_MOD_VERSATILITY_RATING_SHORT = "vers",
}

local STAT_ORDER = { "int", "str", "agi", "haste", "crit", "mast", "vers" }

--- Build a "simly_stats=int=N,str=N,..." string from a GetItemStats result.
-- Missing keys are coerced to 0 so the format is fixed-width per item.
-- Returns nil when stats is nil/empty (so the caller can decide to skip).
local function formatItemStats(stats)
	if type(stats) ~= "table" then return nil end

	local out = {}
	for _, short in ipairs(STAT_ORDER) do
		out[short] = 0
	end

	local sawAnything = false
	for k, v in pairs(stats) do
		local short = STAT_KEY_MAP[k]
		if short and type(v) == "number" then
			-- Multiple keys may map to the same short (e.g. versatility);
			-- prefer non-zero values.
			if v ~= 0 or out[short] == 0 then
				out[short] = v
			end
			sawAnything = true
		end
	end

	if not sawAnything then return nil end

	-- Inner delimiter is '/' so SimC's comma-as-field-separator doesn't
	-- chop our value at the first internal comma. SimC treats the whole
	-- "int=N/str=N/..." string as one opaque value (which it then ignores
	-- as an unknown option, intentionally — the desktop parser reads it).
	local parts = {}
	for _, short in ipairs(STAT_ORDER) do
		table.insert(parts, short .. "=" .. tostring(out[short]))
	end
	return table.concat(parts, "/")
end

--- Try to fetch item stats for a SimC slot via GetInventoryItemLink.
-- Returns the formatted simly_stats string, or nil if the item link
-- isn't available (slot empty, cache miss).
--- Resolve the WoW client's GetItemStats function. The global form was
-- removed in WoW 12.0 (Midnight); current code lives at `C_Item.GetItemStats`.
-- Defensive fall-throughs let the addon work on older clients too.
local function resolveGetItemStats()
	if C_Item and type(C_Item.GetItemStats) == "function" then
		return C_Item.GetItemStats
	end
	if type(GetItemStats) == "function" then
		return GetItemStats
	end
	return nil
end

local function getEquippedStatsString(simcSlot)
	local invslot = SIMC_SLOT_TO_INVSLOT[simcSlot]
	if not invslot then return nil end
	local link = GetInventoryItemLink("player", invslot)
	if not link then return nil end
	local fn = resolveGetItemStats()
	if not fn then return nil end
	local ok, stats = pcall(fn, link)
	if not ok or not stats then return nil end
	return formatItemStats(stats)
end

--- Walk every bag, indexing items by item ID → first found itemLink.
-- Used to look up bag-item stats during AnnotateItemStats. Returns a
-- map { [itemID] = link, ... }.
local function buildBagItemLinkMap()
	local out = {}
	-- Modern API: C_Container.GetContainerItemLink (10.0+).
	local C = C_Container
	if not C or type(C.GetContainerItemLink) ~= "function" then
		-- Pre-Dragonflight fallback (kept for safety; modern WoW always has C_Container).
		for bag = 0, 4 do
			local slots = GetContainerNumSlots and GetContainerNumSlots(bag) or 0
			for slot = 1, slots do
				local link = GetContainerItemLink and GetContainerItemLink(bag, slot)
				if link then
					local id = tonumber(link:match("item:(%d+)"))
					if id and not out[id] then out[id] = link end
				end
			end
		end
		return out
	end

	for bag = 0, NUM_BAG_SLOTS or 4 do
		local slots = C.GetContainerNumSlots(bag) or 0
		for slot = 1, slots do
			local link = C.GetContainerItemLink(bag, slot)
			if link then
				local id = tonumber(link:match("item:(%d+)"))
				if id and not out[id] then out[id] = link end
			end
		end
	end
	return out
end

--- Append `simly_stats=int=N,str=N,agi=N,haste=N,crit=N,mast=N,vers=N`
-- to every equipped + bag item line in the profile.
--
-- Same trailing-key pattern as AnnotateEquipLoc — SimC ignores fields
-- it doesn't know, so the export remains valid. Our desktop parser
-- reads `simly_stats` to compute exact stat-vector × stat-weight
-- predictions for greedy candidates without needing a SimC item-DB.
--
-- Equipped lines: looked up via GetInventoryItemLink(player, INVSLOT_*).
-- Bag lines: looked up via a one-pass bag scan (built once for all bag
-- annotations).
function Export.AnnotateItemStats(profile)
	if not profile or profile == "" then return profile end

	local lines = {}
	for line in (profile .. "\n"):gmatch("([^\n]*)\n") do
		table.insert(lines, line)
	end

	local bagLinks
	local annotated = 0
	for i, line in ipairs(lines) do
		-- Capture: leading prefix (equipped: empty; bag: "# "), slot name, id.
		local prefix, slot, id, body = line:match("^(#?%s*)(%a[%a_0-9]*)=,id=(%d+)(.*)$")
		if slot and id and not (body or ""):find("simly_stats=", 1, true) then
			local statsStr
			if prefix == "" then
				-- Equipped line — look up via inventory.
				statsStr = getEquippedStatsString(slot)
			else
				-- Bag line — look up via bag scan.
				if not bagLinks then bagLinks = buildBagItemLinkMap() end
				local link = bagLinks[tonumber(id)]
				if link then
					local fn = resolveGetItemStats()
					if fn then
						local ok, stats = pcall(fn, link)
						if ok and stats then statsStr = formatItemStats(stats) end
					end
				end
			end
			if statsStr then
				lines[i] = (prefix or "") .. slot .. "=,id=" .. id .. (body or "") .. ",simly_stats=" .. statsStr
				annotated = annotated + 1
			end
		end
	end

	return table.concat(lines, "\n")
end

Export.NO_PROFILE = NO_PROFILE
