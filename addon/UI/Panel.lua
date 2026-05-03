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

local function createFrame()
	local f = CreateFrame("Frame", "SimlyPanelFrame", UIParent, "BackdropTemplate")
	f:SetSize(420, 480)
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

	-- Body text (multi-line, left-justified). Phase 5 swaps this for a
	-- scroll frame with structured rows; the skeleton is plain text so
	-- we can verify the data flow before investing in widgets.
	local body = f:CreateFontString(nil, "OVERLAY", "GameFontNormal")
	body:SetPoint("TOPLEFT", 18, -40)
	body:SetPoint("BOTTOMRIGHT", -18, 50)
	body:SetJustifyH("LEFT")
	body:SetJustifyV("TOP")
	body:SetSpacing(2)
	f.body = body

	local updateBtn = CreateFrame("Button", nil, f, "UIPanelButtonTemplate")
	updateBtn:SetSize(140, 26)
	updateBtn:SetPoint("BOTTOMLEFT", 18, 14)
	updateBtn:SetText("Update sims")
	updateBtn:SetScript("OnClick", function()
		ns.SavedVars.RequestUpdate()
		DEFAULT_CHAT_FRAME:AddMessage(
			"|cff00ffffSimly:|r reloading to start scan. Wait for the desktop notification, then /reload again to see results."
		)
		-- Auto-reload so the user doesn't have to click /reload as a
		-- second step. /reload flushes SimlyDB to disk so the desktop
		-- watcher sees the new update_requested_at and kicks the queue.
		C_Timer.After(0.1, function() ReloadUI() end)
	end)

	local reloadBtn = CreateFrame("Button", nil, f, "UIPanelButtonTemplate")
	reloadBtn:SetSize(80, 26)
	reloadBtn:SetPoint("BOTTOMRIGHT", -18, 14)
	reloadBtn:SetText("/reload")
	reloadBtn:SetScript("OnClick", function() ReloadUI() end)

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
	local gen = (SimlyResults and SimlyResults.generated_at) or 0
	if req == 0 and gen == 0 then
		return "|cffaaaaaaStatus:|r |cffaaaaaaIdle (no sims have run yet — click Update sims to start one)|r"
	end
	if req > gen then
		local age = formatAge(req)
		return "|cffaaaaaaStatus:|r |cffffff00\226\151\143 Scan running on desktop|r |cffaaaaaa(started " .. age .. " — wait for desktop notification, then /reload)|r"
	end
	return "|cffaaaaaaStatus:|r |cff00ff00\226\151\143 Up to date|r |cffaaaaaa(results " .. formatAge(gen) .. ")|r"
end

function Panel.Refresh()
	if not frame then return end

	local lines = {}

	table.insert(lines, statusBlock())
	table.insert(lines, "")

	if SimlyResults and SimlyResults.composed then
		local c = SimlyResults.composed
		table.insert(lines, "|cffffd700Best loadout|r" ..
			(c.label and (" |cffaaaaaa(" .. c.label .. ")|r") or ""))
		if c.flask then
			table.insert(lines, "  Flask: " .. c.flask.name)
		end
		if c.food then
			table.insert(lines, "  Food: " .. c.food.name)
		end
		if c.potion then
			table.insert(lines, "  Potion: " .. c.potion.name)
		end
		if c.augment_rune then
			table.insert(lines, "  Augment Rune: " .. c.augment_rune.name)
		end
	else
		table.insert(lines, "|cffaaaaaa(No sim results yet — click \"Update sims\" then /reload.)|r")
	end
	table.insert(lines, "")

	table.insert(lines, "|cffffd700Scans|r")
	if SimlyResults and SimlyResults.scans and next(SimlyResults.scans) then
		for id, record in pairs(SimlyResults.scans) do
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
	if SimlyResults and SimlyResults.scans
		and SimlyResults.scans.trinket_pre_scan
		and SimlyResults.scans.trinket_pre_scan.status == "done"
		and SimlyResults.scans.trinket_pre_scan.data
	then
		local data = SimlyResults.scans.trinket_pre_scan.data
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
	if SimlyResults and SimlyResults.scans
		and SimlyResults.scans.stat_weights
		and SimlyResults.scans.stat_weights.status == "done"
		and SimlyResults.scans.stat_weights.data
	then
		table.insert(lines, "|cffffd700Stat weights|r |cffaaaaaa(used to prune obviously-bad gear)|r")
		local weights = SimlyResults.scans.stat_weights.data
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

	if SimlyResults then
		table.insert(lines, "|cffaaaaaaSimC|r " .. (SimlyResults.simc_version or "?"))
		table.insert(lines, "|cffaaaaaaScenario|r " .. (SimlyResults.active_scenario or "?"))
		table.insert(lines, "|cffaaaaaaResults file written|r " .. formatAge(SimlyResults.generated_at))
	end

	if SimlyDB and SimlyDB.update_requested_at and SimlyDB.update_requested_at > 0 then
		table.insert(lines, "|cffaaaaaaLast update requested|r " .. formatAge(SimlyDB.update_requested_at))
	end

	frame.body:SetText(table.concat(lines, "\n"))
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
