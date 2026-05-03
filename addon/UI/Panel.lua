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
	scroll:SetPoint("BOTTOMRIGHT", -32, 50)

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
	local updateBtn = CreateFrame("Button", nil, f, "SecureActionButtonTemplate,UIPanelButtonTemplate")
	updateBtn:SetSize(140, 26)
	updateBtn:SetPoint("BOTTOMLEFT", 18, 14)
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

	-- The plain "/reload" button has the same protected-function
	-- problem, so it also needs the SecureActionButton path. No
	-- PreClick on this one — it's purely a manual reload after the
	-- desktop notification fires.
	local reloadBtn = CreateFrame("Button", nil, f, "SecureActionButtonTemplate,UIPanelButtonTemplate")
	reloadBtn:SetSize(80, 26)
	reloadBtn:SetPoint("BOTTOMRIGHT", -18, 14)
	reloadBtn:SetText("/reload")
	reloadBtn:RegisterForClicks("AnyUp", "AnyDown")
	reloadBtn:SetAttribute("type1", "macro")
	reloadBtn:SetAttribute("macrotext1", "/reload")

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

	-- Catalog summary block: items the desktop has simmed and decided
	-- aren't current best. Trash (lost by >3%) listed first since
	-- those are the most actionable for "should I delete this from my
	-- bags?". Sidegrade and good follow. Items with status='best'
	-- aren't shown here — they're already in the loadout block above.
	-- Gray-quality items don't appear at all because the addon's
	-- StripJunkBagItems filter drops them at the source before any
	-- sim sees them.
	if SimlyResults and SimlyResults.catalog_summary
		and SimlyResults.catalog_summary.items
		and #SimlyResults.catalog_summary.items > 0
	then
		local summary = SimlyResults.catalog_summary
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
		table.insert(lines, "|cffaaaaaaSimC|r " .. (SimlyResults.simc_version or "?"))
		table.insert(lines, "|cffaaaaaaScenario|r " .. (SimlyResults.active_scenario or "?"))
		table.insert(lines, "|cffaaaaaaResults file written|r " .. formatAge(SimlyResults.generated_at))
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
