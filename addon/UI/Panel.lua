local addonName, ns = ...

local Panel = {}
ns.Panel = Panel

-- Lazily created on first show; prevents the frame existing during
-- ADDON_LOADED for addons that load before us (cleaner addon list).
local frame

local function formatAge(unixTime)
	if not unixTime or unixTime == 0 then return "never" end
	local age = time() - unixTime
	if age < 0 then return "just now" end
	if age < 60 then return string.format("%ds ago", age) end
	if age < 3600 then return string.format("%dm ago", math.floor(age / 60)) end
	if age < 86400 then return string.format("%dh ago", math.floor(age / 3600)) end
	return string.format("%dd ago", math.floor(age / 86400))
end

local function statusColor(status)
	if status == "done"    then return "|cff00ff00" end
	if status == "running" then return "|cffffff00" end
	if status == "failed"  then return "|cffff0000" end
	if status == "pending" then return "|cffaaaaaa" end
	return "|cffaaaaaa"
end

-- Order matches WoW's character screen scan: left column top-to-
-- bottom (head → wrist), then right column (hands → finger2), then
-- the bottom row (trinkets + weapons). `inv` is the WoW inventory
-- slot constant for GetInventoryItemID lookups; `id` matches the
-- desktop's SimC slot strings used in composed.gear.
local SLOT_DISPLAY_ORDER = {
	{ id = "head",      label = "Head",      inv = INVSLOT_HEAD },
	{ id = "neck",      label = "Neck",      inv = INVSLOT_NECK },
	{ id = "shoulder",  label = "Shoulder",  inv = INVSLOT_SHOULDER },
	{ id = "back",      label = "Back",      inv = INVSLOT_BACK },
	{ id = "chest",     label = "Chest",     inv = INVSLOT_CHEST },
	{ id = "wrist",     label = "Wrist",     inv = INVSLOT_WRIST },
	{ id = "hands",     label = "Hands",     inv = INVSLOT_HAND },
	{ id = "waist",     label = "Waist",     inv = INVSLOT_WAIST },
	{ id = "legs",      label = "Legs",      inv = INVSLOT_LEGS },
	{ id = "feet",      label = "Feet",      inv = INVSLOT_FEET },
	{ id = "finger1",   label = "Finger 1",  inv = INVSLOT_FINGER1 },
	{ id = "finger2",   label = "Finger 2",  inv = INVSLOT_FINGER2 },
	{ id = "trinket1",  label = "Trinket 1", inv = INVSLOT_TRINKET1 },
	{ id = "trinket2",  label = "Trinket 2", inv = INVSLOT_TRINKET2 },
	{ id = "main_hand", label = "Main hand", inv = INVSLOT_MAINHAND },
	{ id = "off_hand",  label = "Off hand",  inv = INVSLOT_OFFHAND },
}

local function createFrame()
	local f = CreateFrame("Frame", "SimlyPanelFrame", UIParent, "BackdropTemplate")
	f:SetSize(440, 560)
	f:SetPoint("CENTER")
	f:SetMovable(true)
	f:EnableMouse(true)
	f:RegisterForDrag("LeftButton")
	f:SetScript("OnDragStart", f.StartMoving)
	f:SetScript("OnDragStop", f.StopMovingOrSizing)
	f:SetClampedToScreen(true)
	f:SetFrameStrata("DIALOG")
	f:SetBackdrop({
		bgFile   = "Interface\\DialogFrame\\UI-DialogBox-Background",
		edgeFile = "Interface\\DialogFrame\\UI-DialogBox-Border",
		edgeSize = 16,
		insets   = { left = 4, right = 4, top = 4, bottom = 4 },
	})

	local title = f:CreateFontString(nil, "OVERLAY", "GameFontNormalLarge")
	title:SetPoint("TOP", 0, -12)
	title:SetText("Simly")

	local close = CreateFrame("Button", nil, f, "UIPanelCloseButton")
	close:SetPoint("TOPRIGHT", -2, -2)

	-- Body content lives inside a scroll frame so the catalog (which
	-- grows as more items are simmed) doesn't get clipped at the
	-- bottom of the panel. Right-edge offset of -32 leaves room for
	-- the scrollbar widget. Mouse wheel is enabled on the scroll
	-- frame so users don't have to drag the bar.
	local scroll = CreateFrame("ScrollFrame", "SimlyPanelScroll", f, "UIPanelScrollFrameTemplate")
	scroll:SetPoint("TOPLEFT", 18, -40)
	scroll:SetPoint("BOTTOMRIGHT", -32, 80)

	local content = CreateFrame("Frame", nil, scroll)
	content:SetSize(scroll:GetWidth(), 1) -- height set per-Refresh from text height
	scroll:SetScrollChild(content)

	local body = content:CreateFontString(nil, "OVERLAY", "GameFontNormal")
	body:SetPoint("TOPLEFT")
	body:SetPoint("TOPRIGHT")
	body:SetJustifyH("LEFT")
	body:SetJustifyV("TOP")
	body:SetSpacing(2)
	f.body = body
	f.scrollContent = content
	f.scroll = scroll

	-- "Update sims" needs to call ReloadUI(), which is protected in
	-- modern WoW — calling it from a plain OnClick handler trips
	-- ADDON_ACTION_BLOCKED. The supported pattern is a
	-- SecureActionButton with `type=macro` + macrotext "/reload";
	-- the secure macro action invokes the slash command without
	-- tainting our addon. PreClick (unsecure) runs first to bump the
	-- request stamp before the reload flushes SimlyDB to disk.
	-- "Update sims" and "/reload" moved up one row (y=44) to make room
	-- for the scenario toggle row below them (y=14).
	local updateBtn = CreateFrame("Button", nil, f, "SecureActionButtonTemplate,UIPanelButtonTemplate")
	updateBtn:SetSize(120, 26)
	updateBtn:SetPoint("BOTTOMLEFT", 18, 44)
	updateBtn:SetText("Update sims")
	updateBtn:RegisterForClicks("AnyUp", "AnyDown")
	updateBtn:SetAttribute("type1", "macro")
	updateBtn:SetAttribute("macrotext1", "/reload")
	updateBtn:SetScript("PreClick", function()
		ns.SavedVars.RequestUpdate()
		DEFAULT_CHAT_FRAME:AddMessage(
			"|cff00ffffSimly:|r reloading to start scan. Wait for the desktop notification, then /reload again to see results."
		)
	end)

	-- "Update all sims" — queues scans for all 4 scenarios back-to-back.
	local updateAllBtn = CreateFrame("Button", nil, f, "SecureActionButtonTemplate,UIPanelButtonTemplate")
	updateAllBtn:SetSize(140, 26)
	updateAllBtn:SetPoint("BOTTOMLEFT", 146, 44)
	updateAllBtn:SetText("Update all sims")
	updateAllBtn:RegisterForClicks("AnyUp", "AnyDown")
	updateAllBtn:SetAttribute("type1", "macro")
	updateAllBtn:SetAttribute("macrotext1", "/reload")
	updateAllBtn:SetScript("PreClick", function()
		ns.SavedVars.RequestUpdateAll()
		DEFAULT_CHAT_FRAME:AddMessage(
			"|cff00ffffSimly:|r reloading to start all-scenario scan. Wait for the desktop notification, then /reload again to see results."
		)
	end)

	-- The plain "/reload" button has the same protected-function
	-- problem, so it also needs the SecureActionButton path. No
	-- PreClick on this one — it's purely a manual reload after the
	-- desktop notification fires.
	local reloadBtn = CreateFrame("Button", nil, f, "SecureActionButtonTemplate,UIPanelButtonTemplate")
	reloadBtn:SetSize(80, 26)
	reloadBtn:SetPoint("BOTTOMRIGHT", -18, 44)
	reloadBtn:SetText("/reload")
	reloadBtn:RegisterForClicks("AnyUp", "AnyDown")
	reloadBtn:SetAttribute("type1", "macro")
	reloadBtn:SetAttribute("macrotext1", "/reload")

	-- Scenario toggle row: four equal-width buttons at the very bottom.
	-- Clicking one calls SavedVars.SetScenario() and refreshes the panel
	-- to update the active highlight. The change persists to disk only on
	-- the next /reload (WoW flushes SavedVars at PLAYER_LOGOUT / reload).
	-- Panel.Refresh() re-applies the Disable/Enable state so the active
	-- button always stays visually distinct — even if the user switches
	-- and then switches back without reloading.
	local scenarios = ns.SavedVars.SCENARIOS
	local numScenarios = #scenarios
	-- Total usable width between insets: 440 - 18 - 18 = 404 px.
	-- Distribute evenly: btnW * n + gap * (n-1) = 404 → gap=4 → btnW=97.
	local btnW = math.floor((404 - 4 * (numScenarios - 1)) / numScenarios)
	local scenarioBtns = {}
	for i, sc in ipairs(scenarios) do
		local btn = CreateFrame("Button", nil, f, "UIPanelButtonTemplate")
		btn:SetSize(btnW, 22)
		btn:SetPoint("BOTTOMLEFT", 18 + (i - 1) * (btnW + 4), 14)
		btn:SetText(sc.label)
		local key = sc.key  -- upvalue per-button
		btn:SetScript("OnClick", function()
			ns.SavedVars.SetScenario(key)
			Panel.Refresh()  -- re-highlights the new active button
		end)
		scenarioBtns[i] = btn
	end
	f.scenarioBtns   = scenarioBtns
	f.scenarioKeys   = scenarios  -- parallel array — index matches button index

	-- Live refresh: re-render whenever the player equips/unequips gear
	-- so the green-equipped / yellow-swap-in coloring tracks reality
	-- without the user having to close and reopen /simly. Only runs
	-- while the panel is visible to avoid useless work on every gear
	-- change. UNIT_INVENTORY_CHANGED("player") covers a few cases
	-- PLAYER_EQUIPMENT_CHANGED misses (e.g. enchant/gem changes that
	-- don't change item_id but might affect a future panel feature);
	-- both are cheap.
	f:RegisterEvent("PLAYER_EQUIPMENT_CHANGED")
	f:RegisterUnitEvent("UNIT_INVENTORY_CHANGED", "player")
	f:SetScript("OnEvent", function(self)
		if self:IsShown() then Panel.Refresh() end
	end)

	-- WoW frames are shown by default at creation; hide so the very
	-- first /simly call doesn't toggle a just-created visible frame off.
	f:Hide()

	return f
end

-- Format the live "is a scan running?" indicator. Compares the
-- panel-button request stamp (SimlyDB.update_requested_at) to the
-- desktop's last completed scan timestamp (SimlyResults.generated_at).
--
-- We can't distinguish "user hasn't /reloaded since clicking" from
-- "user did /reload and desktop is now scanning" — from the addon's
-- perspective both look the same (request newer than results). The
-- "Update sims" button auto-reloads, so in practice the panel only
-- shows the second state. Wording reflects: "scan running on the
-- desktop right now, wait for the notification."
local function statusBlock()
	local req = (SimlyDB and SimlyDB.update_requested_at) or 0
	local activeScenario = (SimlyDB and SimlyDB.active_scenario) or "single_target_patchwerk"

	-- "Is the desktop running a scan right now?" is global state — there's
	-- only one update_requested_at, and the desktop processes one scan at
	-- a time regardless of which scenario the user was on when they clicked.
	-- A request is satisfied when ANY scenario completes after it. So we
	-- compare the request stamp to the max generated_at across all
	-- scenarios — not the active scenario's own (otherwise switching to
	-- a scenario that wasn't recently scanned would falsely show "running").
	local globalMaxGen = 0
	-- The active scenario's own last-scanned time (shown when desktop is idle).
	local activeGen = 0
	if SimlyResults then
		if SimlyResults.scenarios then
			for _, bucket in pairs(SimlyResults.scenarios) do
				if bucket.generated_at and bucket.generated_at > globalMaxGen then
					globalMaxGen = bucket.generated_at
				end
			end
			if SimlyResults.scenarios[activeScenario] then
				activeGen = SimlyResults.scenarios[activeScenario].generated_at or 0
			end
		elseif SimlyResults.generated_at then
			-- v2 fallback for legacy results files (pre-Phase-6b).
			globalMaxGen = SimlyResults.generated_at
			activeGen = SimlyResults.generated_at
		end
	end

	if req == 0 and globalMaxGen == 0 then
		return "|cffaaaaaaStatus:|r |cffaaaaaaIdle (no sims have run yet — click Update sims to start one)|r"
	end
	if req > globalMaxGen then
		local age = formatAge(req)
		return "|cffaaaaaaStatus:|r |cffffff00\226\151\143 Scan running on desktop|r |cffaaaaaa(started " .. age .. " — wait for desktop notification, then /reload)|r"
	end
	-- Desktop is idle. Surface this scenario's own freshness.
	if activeGen == 0 then
		return "|cffaaaaaaStatus:|r |cffff8c00\226\151\143 No results for this scenario yet|r |cffaaaaaa(click Update sims while on this scenario)|r"
	end
	return "|cffaaaaaaStatus:|r |cff00ff00\226\151\143 Up to date|r |cffaaaaaa(results " .. formatAge(activeGen) .. ")|r"
end

-- Human-readable labels for the scenario key (shown in the status block).
local SCENARIO_LABELS = {
	single_target_patchwerk = "Single-target (Patchwerk)",
	m_plus                  = "Mythic+ (DungeonSlice)",
	aoe_cleave              = "AoE Cleave (3-target)",
	aoe_funnel              = "AoE Funnel (5-target)",
}

function Panel.Refresh()
	if not frame then return end

	-- Re-apply scenario button highlight: disable the active one so it
	-- looks "pressed"; enable all others so they're clickable.
	if frame.scenarioBtns then
		local active = ns.SavedVars.GetScenario()
		for i, btn in ipairs(frame.scenarioBtns) do
			if frame.scenarioKeys[i].key == active then
				btn:Disable()
			else
				btn:Enable()
			end
		end
	end

	local lines = {}

	-- Show the currently-selected scenario above the status line so the
	-- user always knows which scenario the next "Update sims" will run.
	local activeScenario = ns.SavedVars.GetScenario()
	local scenarioLabel  = SCENARIO_LABELS[activeScenario] or activeScenario
	table.insert(lines, "|cffaaaaaaScenario:|r |cffffff00" .. scenarioLabel .. "|r")
	table.insert(lines, statusBlock())
	table.insert(lines, "")

	-- Get the result bucket for the currently-viewed scenario.
	-- Falls back to top-level fields for v2 files (migration compat).
	local scenarioData = (SimlyResults and SimlyResults.scenarios and SimlyResults.scenarios[activeScenario]) or nil
	-- v2 fallback: if no scenarios table but top-level scans exist, treat top-level as the scenario data
	if not scenarioData and SimlyResults and SimlyResults.scans then
		scenarioData = SimlyResults
	end

	if scenarioData and scenarioData.composed then
		local c = scenarioData.composed
		table.insert(lines, "|cffffd700Best loadout|r" ..
			(c.label and (" |cffaaaaaa(" .. c.label .. ")|r") or "") ..
			(c.expected_dps and (" |cff00ff00" .. math.floor(c.expected_dps) .. " dps|r") or ""))

		-- Gear block: per-slot recommended item, in WoW character-
		-- screen order. Lines colored:
		--   green  = the recommended item is currently equipped
		--   yellow = recommendation differs from what's equipped (the
		--            user has the item somewhere — bag or bank — and
		--            should swap to it)
		--   gray   = no live equip data (e.g., GetInventoryItemID
		--            returned nil — slot empty or transient)
		if c.gear then
			-- Detect a 2H recommended main hand. WoW locks out the
			-- off-hand slot when a 2H weapon is equipped, so showing
			-- an off-hand recommendation would be misleading — the
			-- player can't act on it. GetItemInfo's itemEquipLoc
			-- returns "INVTYPE_2HWEAPON" for staves / 2H swords / etc.
			-- If GetItemInfo returns nil (item not cached yet), fall
			-- through to default render — better to show a stale row
			-- than to silently hide a legitimate off-hand suggestion.
			local mhIs2H = false
			local mhRec = c.gear.main_hand
			if mhRec and GetItemInfo then
				local _, _, _, _, _, _, _, _, equipLoc = GetItemInfo(mhRec.item_id)
				mhIs2H = (equipLoc == "INVTYPE_2HWEAPON")
			end

			local equippedCount, totalCount = 0, 0
			for _, slot in ipairs(SLOT_DISPLAY_ORDER) do
				local rec = c.gear[slot.id]
				-- Skip off_hand entirely when main_hand is 2H — the
				-- slot is locked, so any recommendation is noise.
				if slot.id == "off_hand" and mhIs2H then
					rec = nil
				end
				if rec then
					totalCount = totalCount + 1
					local equippedId = GetInventoryItemID and GetInventoryItemID("player", slot.inv) or nil
					local color, suffix
					if equippedId == rec.item_id then
						color = "|cff00ff00"
						suffix = " |cffaaaaaa[equipped]|r"
						equippedCount = equippedCount + 1
					elseif equippedId == nil then
						-- Slot is empty but we have a recommendation —
						-- treat as a swap-in (the user is missing a DPS-
						-- relevant item, not "no data to display").
						color = "|cffffff00"
						suffix = " |cffaaaaaa[empty — equip!]|r"
					else
						color = "|cffffff00"
						suffix = " |cffaaaaaa[swap in]|r"
					end
					table.insert(lines, string.format(
						"  %s%s|r: %s%s|r |cffaaaaaa(%d)|r%s",
						color, slot.label, color, rec.name, rec.ilvl or 0, suffix
					))
				end
			end
			if totalCount > 0 then
				table.insert(lines, string.format(
					"  |cffaaaaaaWearing %d/%d recommended slots|r",
					equippedCount, totalCount
				))
			end
		end

		-- Consumables block, unchanged behavior — populated by the
		-- consumables scan; nil until that stage runs.
		if c.flask then
			table.insert(lines, "  |cff66ccffFlask:|r " .. c.flask.name)
		end
		if c.food then
			table.insert(lines, "  |cff66ccffFood:|r " .. c.food.name)
		end
		if c.potion then
			table.insert(lines, "  |cff66ccffPotion:|r " .. c.potion.name)
		end
		if c.augment_rune then
			table.insert(lines, "  |cff66ccffAugment Rune:|r " .. c.augment_rune.name)
		end
	else
		table.insert(lines, "|cffaaaaaa(No sim results yet — click \"Update sims\" then /reload.)|r")
	end
	table.insert(lines, "")

	table.insert(lines, "|cffffd700Scans|r")
	if scenarioData and scenarioData.scans and next(scenarioData.scans) then
		for id, record in pairs(scenarioData.scans) do
			local color = statusColor(record.status)
			local stamp = record.finished_at or record.started_at or 0
			local age = stamp > 0 and (" (" .. formatAge(stamp) .. ")") or ""
			table.insert(lines, "  " .. color .. id .. "|r " .. (record.status or "?") .. age)
		end
	else
		table.insert(lines, "  |cffaaaaaa(no scans recorded)|r")
	end
	table.insert(lines, "")

	-- Trinket winner block (Phase 4c). Renders the best trinket pair
	-- the pre-scan picked, with delta to alternatives so the user knows
	-- whether their current setup is close.
	if scenarioData and scenarioData.scans
		and scenarioData.scans.trinket_pre_scan
		and scenarioData.scans.trinket_pre_scan.status == "done"
		and scenarioData.scans.trinket_pre_scan.data
	then
		local data = scenarioData.scans.trinket_pre_scan.data
		table.insert(lines, "|cffffd700Best trinkets|r |cffaaaaaa(" .. (data.label or "") .. ")|r")
		if data.winner then
			table.insert(lines, string.format(
				"  %s + %s |cff00ff00%d dps|r",
				data.winner.trinket1.name, data.winner.trinket2.name, math.floor(data.winner.mean_dps)
			))
			-- Show up to 3 next-best alternatives with their delta.
			local altCount = 0
			for i = 2, #data.pairs do
				local p = data.pairs[i]
				if altCount >= 3 then break end
				table.insert(lines, string.format(
					"  %s + %s |cffff8888%.2f%%|r",
					p.trinket1.name, p.trinket2.name, p.delta_pct
				))
				altCount = altCount + 1
			end
		end
		table.insert(lines, "")
	end

	-- Stat weights block (Phase 4b). Renders the per-stat scale factors
	-- if the stat_weights scan ran successfully. Reminder to the user
	-- that these are pruning hints, not gear recommendations.
	if scenarioData and scenarioData.scans
		and scenarioData.scans.stat_weights
		and scenarioData.scans.stat_weights.status == "done"
		and scenarioData.scans.stat_weights.data
	then
		table.insert(lines, "|cffffd700Stat weights|r |cffaaaaaa(used to prune obviously-bad gear)|r")
		local weights = scenarioData.scans.stat_weights.data
		-- Sort by value descending so the most important stat is first.
		local pairs_arr = {}
		for stat, value in pairs(weights) do
			table.insert(pairs_arr, { stat = stat, value = value })
		end
		table.sort(pairs_arr, function(a, b) return a.value > b.value end)
		for _, p in ipairs(pairs_arr) do
			table.insert(lines, string.format("  %s: %.2f", p.stat, p.value))
		end
		table.insert(lines, "")
	end

	-- Catalog summary block: items the desktop has simmed and decided
	-- aren't current best. Trash (lost by >3%) listed first since
	-- those are the most actionable for "should I delete this from my
	-- bags?". Sidegrade and good follow. Items with status='best'
	-- aren't shown here — they're already in the loadout block above.
	-- Gray-quality items don't appear at all because the addon's
	-- StripJunkBagItems filter drops them at the source before any
	-- sim sees them.
	if scenarioData and scenarioData.catalog_summary
		and scenarioData.catalog_summary.items
		and #scenarioData.catalog_summary.items > 0
	then
		local summary = scenarioData.catalog_summary
		table.insert(lines, "|cffffd700Catalog|r |cffaaaaaa(" ..
			(summary.total_seen or 0) .. " item" ..
			((summary.total_seen == 1) and "" or "s") .. " simmed; gray junk filtered before sim)|r")

		-- Group by status with the desktop's sort order preserved.
		-- Status colors: trash=red, sidegrade=blue-white, good=yellow.
		local statusColors = {
			trash = "|cffff5555",
			sidegrade = "|cffaaaaff",
			good = "|cffffff66",
			best = "|cff00ff00",
		}
		local statusLabels = {
			trash = "trash",
			sidegrade = "sidegrade",
			good = "good",
			best = "best",
		}

		local lastStatus = nil
		for _, item in ipairs(summary.items) do
			if item.status ~= lastStatus then
				local label = statusLabels[item.status] or item.status
				local count = 0
				for _, it in ipairs(summary.items) do
					if it.status == item.status then count = count + 1 end
				end
				table.insert(lines, "  |cffaaaaaa" .. label .. " (" .. count .. "):|r")
				lastStatus = item.status
			end
			local color = statusColors[item.status] or "|cffffffff"
			table.insert(lines, string.format(
				"    %s%s|r |cffaaaaaa(%s)|r %.2f%%",
				color, item.name, item.slot, item.best_delta_pct
			))
		end
		table.insert(lines, "")
	end

	if SimlyResults then
		local simc_version = (scenarioData and scenarioData.simc_version) or SimlyResults.simc_version
		table.insert(lines, "|cffaaaaaaSimC|r " .. (simc_version or "?"))
		-- "Scenario" is now shown at the top of the panel (selected scenario
		-- from SimlyDB). Show the results-file scenario here only when it
		-- differs from the selected one, so the user knows the cached results
		-- are from a different run.
		local resultsScenario = SimlyResults.active_scenario
		if resultsScenario and resultsScenario ~= ns.SavedVars.GetScenario() then
			table.insert(lines, "|cffaaaaaaResults scenario|r " ..
				(SCENARIO_LABELS[resultsScenario] or resultsScenario))
		end
		local generated_at = (scenarioData and scenarioData.generated_at) or SimlyResults.generated_at
		table.insert(lines, "|cffaaaaaaResults file written|r " .. formatAge(generated_at))
	end

	if SimlyDB and SimlyDB.update_requested_at and SimlyDB.update_requested_at > 0 then
		table.insert(lines, "|cffaaaaaaLast update requested|r " .. formatAge(SimlyDB.update_requested_at))
	end

	frame.body:SetText(table.concat(lines, "\n"))
	-- Resize the scroll content to fit the rendered text so the
	-- scrollbar's range matches what's actually drawn. GetStringHeight
	-- returns the wrapped text's pixel height; the +12 padding gives
	-- a little breathing room at the bottom.
	if frame.scrollContent and frame.body:GetStringHeight() then
		frame.scrollContent:SetHeight(frame.body:GetStringHeight() + 12)
	end
end

function Panel.Toggle()
	if not frame then frame = createFrame() end
	if frame:IsShown() then
		frame:Hide()
	else
		Panel.Refresh()
		frame:Show()
	end
end

function Panel.Show()
	if not frame then frame = createFrame() end
	Panel.Refresh()
	frame:Show()
end

function Panel.Hide()
	if frame then frame:Hide() end
end
