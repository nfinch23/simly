local addonName, ns = ...

local Panel = {}
ns.Panel = Panel

-- Lazily created on first show; prevents the frame existing during
-- ADDON_LOADED for addons that load before us (cleaner addon list).
local frame

-- Build the character_key the desktop stamps into SimlyResults. Must
-- match scan-queue.ts's construction: `${name}-${realm}-${region}`.
-- Region comes from GetCurrentRegion() (1=us, 2=kr, 3=eu, 4=tw, 5=cn).
local function activeCharacterKey()
	local name  = UnitName("player") or ""
	local realm = GetRealmName() or ""
	local regionIdx = (GetCurrentRegion and GetCurrentRegion()) or 1
	local region = ({ "us", "kr", "eu", "tw", "cn" })[regionIdx] or "us"
	return name .. "-" .. realm .. "-" .. region
end

-- True when SimlyResults exists AND its character_key matches the
-- currently-logged-in character. False on first login for any
-- character that hasn't been simmed yet, OR when the file holds
-- another character's data (one global per WoW account → bleed-through
-- across alts before each one's first scan).
local function resultsAreForActiveCharacter()
	if not SimlyResults then return false end
	local stamped = SimlyResults.character_key
	if not stamped or stamped == "" then return false end
	return stamped == activeCharacterKey()
end

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

-- Paper-doll geometry. Layout mirrors WoW's character pane exactly:
--   Left column  (8 rows): head, neck, shoulder, back, chest,
--                          [shirt], [tabard], wrist
--   Right column (8 rows): hands, waist, legs, feet, finger1,
--                          finger2, trinket1, trinket2
--   Bottom row, centered with extra vertical gap: main_hand, off_hand
-- Shirt + tabard are placeholder slots (no Simly recommendation ever
-- — they're cosmetic in WoW) drawn dimmed and inert so the layout
-- reads as a real character screen.
local SLOT_SIZE         = 37
local SLOT_GAP          = 6
local DOLL_PAD          = 8
local DOLL_TITLE_H      = 24
local DOLL_ROWS         = 8
local DOLL_COL_GAP      = 30                                    -- space between the two columns (visual "character" area)
local DOLL_WEAPON_GAP   = 16                                    -- extra space above the weapons row
local DOLL_WIDTH        = DOLL_PAD * 2 + SLOT_SIZE * 2 + DOLL_COL_GAP    -- 8 + 37 + 30 + 37 + 8 = 120
local DOLL_LEFT_X       = DOLL_PAD                              -- 8
local DOLL_RIGHT_X      = DOLL_WIDTH - DOLL_PAD - SLOT_SIZE     -- 75
local DOLL_ROWS_H       = DOLL_ROWS * SLOT_SIZE + (DOLL_ROWS - 1) * SLOT_GAP -- 338
local DOLL_BOTTOM_Y     = DOLL_ROWS_H + DOLL_WEAPON_GAP         -- 354
-- Weapons row is 2 buttons + 1 gap = 80 px wide, centered in the frame.
local DOLL_WEAPONS_X0   = math.floor((DOLL_WIDTH - (2 * SLOT_SIZE + SLOT_GAP)) / 2) -- (120-80)/2 = 20
local DOLL_EQUIP_BTN_H  = 22
local DOLL_HEIGHT       = DOLL_TITLE_H + DOLL_BOTTOM_Y + SLOT_SIZE + DOLL_PAD + DOLL_EQUIP_BTN_H + DOLL_PAD -- 24 + 354 + 37 + 8 + 22 + 8 = 453

local function rowY(row) return row * (SLOT_SIZE + SLOT_GAP) end

-- Real recommended-gear slots and their grid positions. The 2 weapon
-- slots live in the bottom row, separated from the column slots by
-- DOLL_WEAPON_GAP so they visually break apart.
local PAPER_DOLL_POS = {
	-- Left column, top to bottom (matches the in-game character pane):
	head      = { x = DOLL_LEFT_X,  y = rowY(0) },
	neck      = { x = DOLL_LEFT_X,  y = rowY(1) },
	shoulder  = { x = DOLL_LEFT_X,  y = rowY(2) },
	back      = { x = DOLL_LEFT_X,  y = rowY(3) },
	chest     = { x = DOLL_LEFT_X,  y = rowY(4) },
	-- row 5 left: shirt  (decorative; see PAPER_DOLL_DECOR below)
	-- row 6 left: tabard (decorative; see PAPER_DOLL_DECOR below)
	wrist     = { x = DOLL_LEFT_X,  y = rowY(7) },
	-- Right column, top to bottom:
	hands     = { x = DOLL_RIGHT_X, y = rowY(0) },
	waist     = { x = DOLL_RIGHT_X, y = rowY(1) },
	legs      = { x = DOLL_RIGHT_X, y = rowY(2) },
	feet      = { x = DOLL_RIGHT_X, y = rowY(3) },
	finger1   = { x = DOLL_RIGHT_X, y = rowY(4) },
	finger2   = { x = DOLL_RIGHT_X, y = rowY(5) },
	trinket1  = { x = DOLL_RIGHT_X, y = rowY(6) },
	trinket2  = { x = DOLL_RIGHT_X, y = rowY(7) },
	-- Weapons row, centered below the gear grid:
	main_hand = { x = DOLL_WEAPONS_X0,                       y = DOLL_BOTTOM_Y },
	off_hand  = { x = DOLL_WEAPONS_X0 + SLOT_SIZE + SLOT_GAP, y = DOLL_BOTTOM_Y },
}

-- Consumable buttons: rows 5 and 6 of the left column. Shirt and
-- tabard would live here on a real character pane; Simly fills them
-- with the recommended flask and food instead since those slots have
-- meaningful data and the cosmetic slots don't.
-- `field` is the composed.* key to read at refresh time; `fallback`
-- is a generic Blizzard icon used when GetItemInfoInstant(name) can't
-- resolve a real icon (the consumables scans currently store item_id=0).
local PAPER_DOLL_CONSUMABLES = {
	{ id = "flask", field = "flask", label = "Best flask", x = DOLL_LEFT_X, y = rowY(5), fallback = "Interface\\Icons\\inv_alchemy_70_flask01" },
	{ id = "food",  field = "food",  label = "Best food",  x = DOLL_LEFT_X, y = rowY(6), fallback = "Interface\\Icons\\inv_misc_food_15" },
}

-- Human-readable labels for the scenario key. Defined twice in this
-- file historically; this copy is used by the paper-doll tooltip and
-- the one below by the text body. Keep them in sync.
local SCENARIO_LABELS_FOR_DOLL = {
	single_target_patchwerk = "Single-target",
	m_plus                  = "Mythic+",
	aoe_cleave              = "AoE Cleave",
	aoe_funnel              = "AoE Funnel",
}

-- Build a slot button from primitives — a Button with a backdrop'd
-- border + an icon Texture child. Avoids the ItemButton/Template
-- pairing entirely, which produced empty frames in current retail
-- (Midnight 12.0): the children that ItemButtonTemplate creates didn't
-- render in this build, so the buttons appeared invisible.
-- The returned button exposes:
--   btn.icon  — the icon Texture
--   btn.SetBorderColor(r,g,b) — tints the backdrop border
local function createSlotButton(name, parent, w, h)
	local btn = CreateFrame("Button", name, parent, "BackdropTemplate")
	btn:SetSize(w, h)
	btn:SetBackdrop({
		bgFile   = "Interface\\Buttons\\WHITE8x8",
		edgeFile = "Interface\\Buttons\\WHITE8x8",
		edgeSize = 1,
		insets   = { left = 1, right = 1, top = 1, bottom = 1 },
	})
	btn:SetBackdropColor(0, 0, 0, 0.6)
	btn:SetBackdropBorderColor(0.5, 0.5, 0.5, 1)
	local icon = btn:CreateTexture(nil, "ARTWORK")
	icon:SetPoint("TOPLEFT", 1, -1)
	icon:SetPoint("BOTTOMRIGHT", -1, 1)
	-- Standard WoW item-icon crop trims the gradient border baked into
	-- icon textures so they fit flush inside our frame.
	icon:SetTexCoord(0.08, 0.92, 0.08, 0.92)
	btn.icon = icon
	btn.SetBorderColor = function(self, r, g, b, a)
		self:SetBackdropBorderColor(r, g, b, a or 1)
	end
	return btn
end

local function setSlotBorderColor(btn, r, g, b)
	if btn.SetBorderColor then btn:SetBorderColor(r, g, b, 1) end
end

-- Construct a full WoW item hyperlink from a composed-gear record.
-- Composer stores identity as "itemId:bonus1/bonus2/...:crafted/...";
-- the full link format includes a wrapper |H...|h[name]|h|r which is
-- what GameTooltip:SetHyperlink robustly accepts across retail builds.
-- Layout: |cffffffff|Hitem:ID:enchant:gem1:gem2:gem3:gem4:suffix:unique:
-- linkLevel:specID:upgradeID:instanceDifficulty:numBonus:b1:b2:...|h[Name]|h|r
-- Returns nil if rec is missing fields needed to build the link;
-- callers should fall back to SetItemByID in that case.
local function buildItemHyperlink(rec)
	if not rec or not rec.item_id or not rec.name then return nil end
	local bonuses = {}
	if rec.identity then
		local _, _, bonusStr = string.find(rec.identity, "^[^:]*:([^:]*)")
		if bonusStr and bonusStr ~= "" then
			for b in string.gmatch(bonusStr, "[^/]+") do
				table.insert(bonuses, b)
			end
		end
	end
	-- WoW item link field positions:
	--   1=itemID, 2=enchant, 3..6=gem1..gem4, 7=suffix, 8=unique,
	--   9=linkLevel, 10=specID, 11=upgrade, 12=instanceDifficulty, 13=numBonus
	-- That's 12 separators between itemID and numBonus.
	local s = "|cffffffff|Hitem:" .. rec.item_id .. "::::::::::::" .. #bonuses
	for _, b in ipairs(bonuses) do s = s .. ":" .. b end
	s = s .. "|h[" .. rec.name .. "]|h|r"
	return s
end

local function showPaperDollTooltip(btn)
	local rec = btn.currentRec
	local equippedId = btn.currentEquippedId
	local lockedOH = btn.isLocked2H
	if not rec and not equippedId and not lockedOH then return end

	GameTooltip:SetOwner(btn, "ANCHOR_RIGHT")
	if rec then
		-- Prefer a full hyperlink with bonus IDs — WoW renders the
		-- correct ilvl (e.g. 272) from the bonus chain. SetHyperlink
		-- fails silently if the link format is malformed (no error,
		-- empty tooltip). Use NumLines after the call to detect that
		-- and fall back to SetItemByID so the player always sees
		-- *something* on hover, even if it's the base ilvl.
		local link = buildItemHyperlink(rec)
		local rendered = false
		if link then
			GameTooltip:SetHyperlink(link)
			rendered = (GameTooltip:NumLines() or 0) > 0
		end
		if not rendered then
			GameTooltip:SetItemByID(rec.item_id)
			-- Surface the simmed ilvl explicitly since SetItemByID
			-- renders the base/template ilvl, often dramatically lower.
			if rec.ilvl and rec.ilvl > 0 then
				GameTooltip:AddDoubleLine("|cffffd700Simly Item Level|r", tostring(rec.ilvl), 1, 0.82, 0, 1, 1, 1)
			end
		end
		GameTooltip:AddLine(" ")
		local key = ns.SavedVars and ns.SavedVars.GetScenario and ns.SavedVars.GetScenario() or "single_target_patchwerk"
		local label = SCENARIO_LABELS_FOR_DOLL[key] or key
		GameTooltip:AddLine("|cffffd700Simly:|r |cffaaaaaaRecommended for " .. label .. "|r")
		if equippedId == rec.item_id then
			GameTooltip:AddLine("|cff00ff00Currently equipped|r")
		elseif equippedId == nil then
			GameTooltip:AddLine("|cffffff00You don't have this equipped — empty slot!|r")
			GameTooltip:AddLine("|cffffd700Right-click to equip from bags|r")
		else
			GameTooltip:AddLine("|cffffff00Swap in from bag/bank|r")
			GameTooltip:AddLine("|cffffd700Right-click to equip|r")
		end
	elseif lockedOH then
		GameTooltip:AddLine("|cff" .. "aaaaaa" .. btn.slotLabel .. "|r")
		GameTooltip:AddLine("|cffff8888Locked — 2H weapon equipped|r")
	elseif equippedId then
		GameTooltip:SetInventoryItem("player", btn.slotInv)
		GameTooltip:AddLine(" ")
		GameTooltip:AddLine("|cffaaaaaa(No Simly recommendation for this slot yet)|r")
	end
	GameTooltip:Show()
end

local function createPaperDoll(parentFrame)
	local doll = CreateFrame("Frame", "SimlyPaperDollFrame", parentFrame, "BackdropTemplate")
	doll:SetSize(DOLL_WIDTH, DOLL_HEIGHT)
	-- Dock to the LEFT of the main panel. -2 nudge keeps the right
	-- edge flush against the main frame's left border without overlap.
	doll:SetPoint("TOPRIGHT", parentFrame, "TOPLEFT", -2, 0)
	doll:SetFrameStrata("DIALOG")
	doll:SetBackdrop({
		bgFile   = "Interface\\DialogFrame\\UI-DialogBox-Background",
		edgeFile = "Interface\\DialogFrame\\UI-DialogBox-Border",
		edgeSize = 16,
		insets   = { left = 4, right = 4, top = 4, bottom = 4 },
	})

	local title = doll:CreateFontString(nil, "OVERLAY", "GameFontNormal")
	title:SetPoint("TOP", 0, -10)
	title:SetText("Recommended gear")

	-- Content lives below the title bar. Slot positions are computed
	-- relative to this frame's TOPLEFT.
	local content = CreateFrame("Frame", nil, doll)
	content:SetPoint("TOPLEFT", 4, -DOLL_TITLE_H)
	content:SetPoint("BOTTOMRIGHT", -4, 4)

	local buttons = {}
	for _, slot in ipairs(SLOT_DISPLAY_ORDER) do
		local pos = PAPER_DOLL_POS[slot.id]
		local btn = createSlotButton("SimlyPaperDoll_" .. slot.id, content, SLOT_SIZE, SLOT_SIZE)
		btn:SetPoint("TOPLEFT", pos.x, -pos.y)
		btn.slotId    = slot.id
		btn.slotInv   = slot.inv
		btn.slotLabel = slot.label
		-- Right-click to equip the recommendation. Mirrors WoW's
		-- natural convention of right-clicking an item in your bags
		-- to equip it. EquipItemByName works from non-secure Lua out
		-- of combat; the second arg picks the specific inventory slot
		-- so finger1/finger2 and trinket1/trinket2 don't get swapped
		-- by the auto-finder.
		btn:RegisterForClicks("RightButtonUp")
		btn:SetScript("OnClick", function(self, button)
			if button ~= "RightButton" then return end
			local rec = self.currentRec
			if not rec or not rec.name then return end
			if self.currentEquippedId == rec.item_id then
				DEFAULT_CHAT_FRAME:AddMessage("|cff00ffffSimly:|r " .. rec.name .. " is already equipped.")
				return
			end
			if InCombatLockdown and InCombatLockdown() then
				DEFAULT_CHAT_FRAME:AddMessage("|cffff5555Simly:|r can't equip in combat — try again when out of combat.")
				return
			end
			DEFAULT_CHAT_FRAME:AddMessage("|cff00ffffSimly:|r equipping " .. rec.name .. " to " .. self.slotLabel .. "...")
			-- Play the same item-pickup sound WoW fires when an item
			-- leaves the bag on a right-click equip. WoW will then
			-- play the kit-specific armor put-down sound automatically
			-- when the equip event resolves, matching the normal flow.
			if PlaySound and SOUNDKIT and SOUNDKIT.PUT_DOWN_SMALL_CHAIN then
				PlaySound(SOUNDKIT.PUT_DOWN_SMALL_CHAIN)
			end
			EquipItemByName(rec.name, self.slotInv)
		end)
		btn:SetScript("OnEnter", showPaperDollTooltip)
		btn:SetScript("OnLeave", function() GameTooltip:Hide() end)
		buttons[slot.id] = btn
	end

	-- Consumable buttons (flask + food) fill the cosmetic shirt/tabard
	-- rows. Refresh logic in Panel.RefreshPaperDoll reads composed.*
	-- and paints icon/tooltip; here we just construct the buttons.
	local consumables = {}
	for _, c in ipairs(PAPER_DOLL_CONSUMABLES) do
		local btn = createSlotButton("SimlyPaperDoll_" .. c.id, content, SLOT_SIZE, SLOT_SIZE)
		btn:SetPoint("TOPLEFT", c.x, -c.y)
		btn.consumableField = c.field
		btn.consumableLabel = c.label
		btn.consumableFallback = c.fallback
		btn:SetScript("OnEnter", function(self)
			local rec = self.currentRec
			if not rec then return end
			GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
			-- item_id is 0 from the consumables scans (they sim by
			-- name, not item id). When/if a real id ever appears,
			-- prefer the WoW tooltip path so stats + icons show.
			if rec.item_id and rec.item_id > 0 then
				GameTooltip:SetItemByID(rec.item_id)
			else
				GameTooltip:AddLine(rec.name, 1, 1, 1)
			end
			GameTooltip:AddLine(" ")
			local key = ns.SavedVars and ns.SavedVars.GetScenario and ns.SavedVars.GetScenario() or "single_target_patchwerk"
			local label = SCENARIO_LABELS_FOR_DOLL[key] or key
			GameTooltip:AddLine("|cffffd700Simly:|r |cffaaaaaa" .. self.consumableLabel .. " for " .. label .. "|r")
			GameTooltip:Show()
		end)
		btn:SetScript("OnLeave", function() GameTooltip:Hide() end)
		consumables[c.id] = btn
	end

	-- "Equip all" button at the bottom of the doll: walks every gear
	-- slot and equips each recommendation that isn't already equipped.
	-- WoW handles rapid sequential EquipItemByName calls fine — they
	-- get queued. Items not present in the player's bags (e.g. in the
	-- bank) are silently skipped by WoW; we surface a hint about that
	-- in the chat message.
	local equipAllBtn = CreateFrame("Button", "SimlyPaperDollEquipAll", doll, "UIPanelButtonTemplate")
	equipAllBtn:SetSize(DOLL_WIDTH - DOLL_PAD * 2, DOLL_EQUIP_BTN_H)
	equipAllBtn:SetPoint("BOTTOM", 0, DOLL_PAD)
	equipAllBtn:SetText("Equip all")
	equipAllBtn:SetScript("OnClick", function()
		if InCombatLockdown and InCombatLockdown() then
			DEFAULT_CHAT_FRAME:AddMessage("|cffff5555Simly:|r can't equip in combat — try again when out of combat.")
			return
		end
		if not doll.buttons then return end
		local toEquip, alreadyOn = 0, 0
		for _, slot in ipairs(SLOT_DISPLAY_ORDER) do
			local btn = doll.buttons[slot.id]
			if btn and btn.currentRec and btn.currentRec.name and not btn.isLocked2H then
				if btn.currentEquippedId == btn.currentRec.item_id then
					alreadyOn = alreadyOn + 1
				else
					EquipItemByName(btn.currentRec.name, slot.inv)
					toEquip = toEquip + 1
				end
			end
		end
		if PlaySound and SOUNDKIT and SOUNDKIT.PUT_DOWN_SMALL_CHAIN then
			PlaySound(SOUNDKIT.PUT_DOWN_SMALL_CHAIN)
		end
		if toEquip == 0 then
			DEFAULT_CHAT_FRAME:AddMessage("|cff00ffffSimly:|r already wearing every recommended item.")
		else
			DEFAULT_CHAT_FRAME:AddMessage(string.format(
				"|cff00ffffSimly:|r equipping %d item%s (%d already on). Items in the bank or missing from bags will be skipped.",
				toEquip, toEquip == 1 and "" or "s", alreadyOn
			))
		end
	end)
	doll.equipAllBtn = equipAllBtn

	doll.buttons = buttons
	doll.consumables = consumables
	-- Parenting alone propagates show/hide, but hook explicitly so the
	-- behavior is easy to find when someone reads this file later.
	parentFrame:HookScript("OnShow", function() doll:Show() end)
	parentFrame:HookScript("OnHide", function() doll:Hide() end)
	return doll
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
	scroll:SetPoint("BOTTOMRIGHT", -32, 210)

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

	-- Sim-type button grid (Slice F). 9 buttons in a 3-col grid,
	-- replacing the old single "Update sims" / "Update all sims"
	-- buttons. Each button targets a specific scan family:
	--   Sim Gear         — gear ladder
	--   Sim Consumables  — flask + food (+ potion/augrune in Slice I)
	--   Sim Gems         — gem combinations (Slice G; disabled today)
	--   Sim Enchants     — enchant variants (Slice H; disabled today)
	--   Sim BiS          — best achievable loadout from all content
	--   Sim Dungeons     — per-dungeon upgrade list
	--   Sim Raids        — per-raid-encounter upgrade list
	--   Sim Crests       — upgrade-priority (where to spend crests)
	--   Sim Voidcore     — Nebulous Voidcore variants (Slice K; disabled)
	--
	-- All buttons are SecureActionButtons with macrotext=/reload so the
	-- protected reload call doesn't taint our addon. PreClick stamps
	-- the request via SavedVars.RequestSim(simType) which the desktop
	-- scan-queue gates on.
	--
	-- Net-new buttons (gems / enchants / voidcore) render disabled with
	-- a tooltip indicating which slice unlocks them.
	local SIM_BUTTONS = {
		{ label = "Sim Gear",        sim = "gear",        enabled = true,  msg = "gear ladder" },
		{ label = "Sim Consumables", sim = "consumables", enabled = true,  msg = "flask + food" },
		{ label = "Sim Gems",        sim = "gems",        enabled = false, tooltip = "Coming in Slice G" },
		{ label = "Sim Enchants",    sim = "enchants",    enabled = false, tooltip = "Coming in Slice H" },
		{ label = "Sim BiS",         sim = "bis",         enabled = true,  msg = "best content" },
		{ label = "Sim Dungeons",    sim = "dungeons",    enabled = true,  msg = "per-dungeon upgrades" },
		{ label = "Sim Raids",       sim = "raids",       enabled = true,  msg = "per-raid upgrades" },
		{ label = "Sim Crests",      sim = "crests",      enabled = true,  msg = "upgrade priority" },
		{ label = "Sim Voidcore",    sim = "voidcore",    enabled = false, tooltip = "Coming in Slice K" },
	}

	-- 3-column grid. Total usable width = 440 - 18 - 18 = 404 px;
	-- gap=4 → btnW=132. Button height 22; row gap 4 → row stride 26.
	-- Grid base y matches the old update-button row (y=174) so the
	-- talent dropdowns below at y=44-134 stay where they are.
	local simBtnW = math.floor((404 - 4 * 2) / 3)
	local simBtnH = 22
	local simRowStride = 26
	local simGridBaseY = 174

	for i, def in ipairs(SIM_BUTTONS) do
		local col = (i - 1) % 3       -- 0, 1, 2
		local row = math.floor((i - 1) / 3)  -- 0, 1, 2 (top row first)
		-- Rows count up from bottom-anchored grid: row 0 is the BOTTOM row
		-- of the 3, so its y matches simGridBaseY. Row 2 (top) gets
		-- +2*stride. This keeps the visual order top-to-bottom = list order.
		local y = simGridBaseY + (2 - row) * simRowStride
		local x = 18 + col * (simBtnW + 4)

		local btn = CreateFrame("Button", nil, f, "SecureActionButtonTemplate,UIPanelButtonTemplate")
		btn:SetSize(simBtnW, simBtnH)
		btn:SetPoint("BOTTOMLEFT", x, y)
		btn:SetText(def.label)
		if def.enabled then
			btn:RegisterForClicks("AnyUp", "AnyDown")
			btn:SetAttribute("type1", "macro")
			btn:SetAttribute("macrotext1", "/reload")
			local capturedSim = def.sim
			local capturedMsg = def.msg
			btn:SetScript("PreClick", function()
				ns.SavedVars.RequestSim(capturedSim)
				DEFAULT_CHAT_FRAME:AddMessage(
					"|cff00ffffSimly:|r reloading to start " .. capturedMsg ..
					" sim. Wait for the desktop notification, then /reload again to see results."
				)
			end)
		else
			-- Disabled state. Tooltip says when it's coming.
			btn:Disable()
			local capturedTip = def.tooltip
			btn:SetScript("OnEnter", function(self)
				GameTooltip:SetOwner(self, "ANCHOR_TOP")
				GameTooltip:SetText(def.label)
				GameTooltip:AddLine(capturedTip, 1, 0.82, 0, true)
				GameTooltip:Show()
			end)
			btn:SetScript("OnLeave", function() GameTooltip:Hide() end)
			-- Tooltips don't fire on disabled secure buttons by default;
			-- enabling mouse without re-enabling clicks gets us the hover.
			btn:EnableMouse(true)
		end
	end

	-- Row above the sim grid: /reload (narrow, left) + Sim All (wide,
	-- right). Sim All replaces "Update all sims" — runs every sim type
	-- across every scenario in dependency order.
	local controlRowY = simGridBaseY + 3 * simRowStride + 4  -- y=174 + 78 + 4 = 256
	local reloadBtn = CreateFrame("Button", nil, f, "SecureActionButtonTemplate,UIPanelButtonTemplate")
	reloadBtn:SetSize(simBtnW, simBtnH)
	reloadBtn:SetPoint("BOTTOMLEFT", 18, controlRowY)
	reloadBtn:SetText("/reload")
	reloadBtn:RegisterForClicks("AnyUp", "AnyDown")
	reloadBtn:SetAttribute("type1", "macro")
	reloadBtn:SetAttribute("macrotext1", "/reload")

	local simAllBtn = CreateFrame("Button", nil, f, "SecureActionButtonTemplate,UIPanelButtonTemplate")
	-- Width: panel inner (404) minus reload width minus 2× gap.
	local simAllW = 404 - simBtnW - 8
	simAllBtn:SetSize(simAllW, simBtnH)
	simAllBtn:SetPoint("BOTTOMRIGHT", -18, controlRowY)
	simAllBtn:SetText("Sim All (every sim, every scenario)")
	simAllBtn:RegisterForClicks("AnyUp", "AnyDown")
	simAllBtn:SetAttribute("type1", "macro")
	simAllBtn:SetAttribute("macrotext1", "/reload")
	simAllBtn:SetScript("PreClick", function()
		ns.SavedVars.RequestUpdateAll()
		DEFAULT_CHAT_FRAME:AddMessage(
			"|cff00ffffSimly:|r reloading to start ALL sims across every scenario. This will take several minutes."
		)
	end)

	-- Per-scenario talent loadout pickers, one per scenario. Stacked
	-- vertically above the Update buttons so the user can stage all 4
	-- picks before clicking "Update all sims" — no need to flip the
	-- active scenario back and forth (the old single-dropdown design's
	-- failure mode).
	--
	-- Each dropdown is independent: its OnInit captures the scenario
	-- key in a closure so clicks land in the right SavedVars slot.
	-- Long-form loadout names ("Raid Paladins") fit because we give
	-- each dropdown the full panel width.
	--
	-- Layout: 4 rows of 30px each starting at y=70. Update buttons get
	-- pushed up to y=180, Run Full Sim to y=210, scroll bottom to 240/
	-- 280 (dev). Re-applied in Panel.Refresh's dev_mode toggle below.
	local talentRowH = 30
	-- Bottom of the lowest talent row sits just above the scenario
	-- button row at y=14, with a 30px gap.
	local talentRowBaseY = 44
	local talentDropdowns = {}
	for i, sc in ipairs(ns.SavedVars.SCENARIOS) do
		local scenarioKey = sc.key
		local y = talentRowBaseY + (4 - i) * talentRowH
		local dd = CreateFrame("Frame", "SimlyTalentDropdown_" .. scenarioKey, f, "UIDropDownMenuTemplate")
		dd:SetPoint("BOTTOMLEFT", 2, y)
		UIDropDownMenu_SetWidth(dd, 220)
		local function init(self)
			local current = ns.SavedVars.GetTalentLoadoutForScenario(scenarioKey)
			local info = UIDropDownMenu_CreateInfo()
			info.text = "Equipped"
			info.value = ns.SavedVars.TALENT_EQUIPPED
			info.checked = (current == ns.SavedVars.TALENT_EQUIPPED)
			info.func = function()
				ns.SavedVars.SetTalentLoadoutForScenario(scenarioKey, ns.SavedVars.TALENT_EQUIPPED)
				UIDropDownMenu_SetSelectedValue(dd, ns.SavedVars.TALENT_EQUIPPED)
				UIDropDownMenu_SetText(dd, "Equipped")
			end
			UIDropDownMenu_AddButton(info)
			for _, name in ipairs(ns.SavedVars.GetSavedLoadoutNames()) do
				local info2 = UIDropDownMenu_CreateInfo()
				info2.text = name
				info2.value = name
				info2.checked = (current == name)
				local captured = name
				info2.func = function()
					ns.SavedVars.SetTalentLoadoutForScenario(scenarioKey, captured)
					UIDropDownMenu_SetSelectedValue(dd, captured)
					UIDropDownMenu_SetText(dd, captured)
				end
				UIDropDownMenu_AddButton(info2)
			end
		end
		UIDropDownMenu_Initialize(dd, init)
		-- Label to the right of the dropdown widget. Each dropdown
		-- already occupies x=2..~265 (SetWidth(220) + ~45 chrome); the
		-- panel's inner width is 404, so the label fits at ~275 with
		-- room to spare. Label says "for: <scenario>" so the user can
		-- match dropdowns to scenarios at a glance.
		local label = f:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
		label:SetPoint("LEFT", dd, "RIGHT", 8, 2)
		label:SetText("|cffaaaaaafor:|r " .. sc.label)
		talentDropdowns[scenarioKey] = dd
	end
	f.talentDropdowns = talentDropdowns

	-- Dev-only "Run Full Sim (dev)" button. Triggers the normal quick
	-- pipeline followed by a Raidbots-Top-Gear-style full cartesian sim
	-- so we can measure how much DPS the greedy heuristic leaves on the
	-- table vs an exhaustive search. Hidden by default — Panel.Refresh
	-- toggles visibility based on SimlyResults.dev_mode, which the
	-- desktop sets only when running under electron-vite dev.
	local fullSimBtn = CreateFrame("Button", nil, f, "SecureActionButtonTemplate,UIPanelButtonTemplate")
	fullSimBtn:SetSize(180, 22)
	fullSimBtn:SetPoint("BOTTOMLEFT", 18, 286)
	fullSimBtn:SetText("Run Full Sim (dev)")
	fullSimBtn:RegisterForClicks("AnyUp", "AnyDown")
	fullSimBtn:SetAttribute("type1", "macro")
	fullSimBtn:SetAttribute("macrotext1", "/reload")
	fullSimBtn:SetScript("PreClick", function()
		ns.SavedVars.RequestFullSim()
		DEFAULT_CHAT_FRAME:AddMessage(
			"|cffff6600Simly:|r reloading to start FULL SIM (dev). This will take ~10-30 min. Quick pipeline runs first, then the cartesian sim."
		)
	end)
	fullSimBtn:Hide()
	f.fullSimBtn = fullSimBtn

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

	-- Paper-doll side panel: docks to the left of the main frame and
	-- shows the per-slot recommended gear as character-pane-style icon
	-- buttons. Shares show/hide with the parent via HookScript inside
	-- createPaperDoll. pcall'd so an unexpected retail UI quirk in the
	-- doll never blanks the main panel — the text body keeps rendering.
	local ok, dollOrErr = pcall(createPaperDoll, f)
	if ok then
		f.paperDoll = dollOrErr
	else
		DEFAULT_CHAT_FRAME:AddMessage(
			"|cffff5555Simly:|r paper-doll init failed: " .. tostring(dollOrErr)
		)
	end

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
		-- A scan is in-flight, but it may not be for the scenario the
		-- user is currently viewing. update_requested_scenario tells us
		-- which scenario the request targeted (set by RequestUpdate at
		-- click time; nil for Update All which targets every tab).
		local reqScenario = SimlyDB and SimlyDB.update_requested_scenario
		local scanIsForThisTab = (reqScenario == nil) or (reqScenario == activeScenario)
		if scanIsForThisTab then
			local age = formatAge(req)
			-- Scan in flight. If the active character has no results yet,
			-- clarify that this will be its first sim.
			if not resultsAreForActiveCharacter() then
				return "|cffaaaaaaStatus:|r |cffffff00\226\151\143 Scan running on desktop|r |cffaaaaaa(first sim for " ..
					activeCharacterKey() .. ", started " .. age .. " — wait for desktop notification, then /reload)|r"
			end
			return "|cffaaaaaaStatus:|r |cffffff00\226\151\143 Scan running on desktop|r |cffaaaaaa(started " .. age .. " — wait for desktop notification, then /reload)|r"
		end
		-- Scan running for a different scenario. Fall through to this
		-- scenario's own freshness display below. (Append a small hint
		-- so the user knows another tab is mid-sim.)
		-- SCENARIO_LABELS_FOR_DOLL is declared above statusBlock so it's
		-- in scope here; the longer SCENARIO_LABELS lives below and would
		-- be out-of-scope (Lua local-scope is lexical).
		local otherLabel = SCENARIO_LABELS_FOR_DOLL[reqScenario] or reqScenario
		local hint = " |cffaaaaaa(other scan running: " .. otherLabel .. ")|r"
		if activeGen == 0 then
			return "|cffaaaaaaStatus:|r |cffff8c00\226\151\143 No results for this scenario yet|r |cffaaaaaa(click Update sims while on this scenario)|r" .. hint
		end
		return "|cffaaaaaaStatus:|r |cff00ff00\226\151\143 Up to date|r |cffaaaaaa(results " .. formatAge(activeGen) .. ")|r" .. hint
	end
	-- Desktop is idle.
	-- Cross-character bleed-through guard. SimlyResults.lua is a single
	-- global per WoW account; logging into a fresh alt shows the prior
	-- toon's results unless we gate here. Distinguish "no results at
	-- all" from "results exist but for another character" so the user
	-- can tell why the panel is empty.
	if not resultsAreForActiveCharacter() then
		if SimlyResults and SimlyResults.character_key and SimlyResults.character_key ~= "" then
			return "|cffaaaaaaStatus:|r |cffff8c00\226\151\143 No sims for " .. activeCharacterKey() ..
				" yet|r |cffaaaaaa(last sim was for " .. SimlyResults.character_key ..
				" — click Update sims to run for this character)|r"
		end
		return "|cffaaaaaaStatus:|r |cffaaaaaaIdle (no sims have run yet — click Update sims to start one)|r"
	end
	-- Surface this scenario's own freshness.
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

-- Paint the paper-doll side panel from the active scenario's
-- composed.gear. Border tint by status: green=equipped what's
-- recommended, yellow=swap-in/empty-with-rec, gray=no rec but
-- something equipped, dim-gray=empty + no rec / 2H-locked off-hand.
-- Stores rec + equippedId + lock state on each button so OnEnter
-- can build a context-aware tooltip without re-reading state.
function Panel.RefreshPaperDoll()
	if not frame or not frame.paperDoll then return end
	local doll = frame.paperDoll

	local activeScenario = ns.SavedVars.GetScenario()
	-- Cross-character bleed-through guard (Slice A). Force scenarioData
	-- to nil when results aren't for the active character so every slot
	-- renders as dim "no rec" instead of yellow-suggesting another
	-- character's items.
	local scenarioData
	if resultsAreForActiveCharacter() then
		scenarioData = (SimlyResults and SimlyResults.scenarios and SimlyResults.scenarios[activeScenario]) or nil
		if not scenarioData and SimlyResults and SimlyResults.scans then
			scenarioData = SimlyResults
		end
	end
	local gear = (scenarioData and scenarioData.composed and scenarioData.composed.gear) or {}

	-- 2H main-hand locks the off-hand slot. Same heuristic as the
	-- text renderer used to use.
	local mhIs2H = false
	local mhRec = gear.main_hand
	if mhRec and GetItemInfo then
		local _, _, _, _, _, _, _, _, equipLoc = GetItemInfo(mhRec.item_id)
		mhIs2H = (equipLoc == "INVTYPE_2HWEAPON")
	end

	for _, slot in ipairs(SLOT_DISPLAY_ORDER) do
		local btn = doll.buttons[slot.id]
		if btn then
			local rec = gear[slot.id]
			local lockedOH = (slot.id == "off_hand" and mhIs2H)
			if lockedOH then rec = nil end
			local equippedId = GetInventoryItemID and GetInventoryItemID("player", slot.inv) or nil

			btn.currentRec        = rec
			btn.currentEquippedId = equippedId
			btn.isLocked2H        = lockedOH

			-- Icon: prefer the recommended item; fall back to whatever
			-- the player is wearing (so an unsimmed slot still feels
			-- like a real character pane). nil clears the icon.
			local icon = nil
			if rec then
				icon = GetItemIcon and GetItemIcon(rec.item_id) or nil
			elseif equippedId then
				icon = GetItemIcon and GetItemIcon(equippedId) or nil
			end
			btn.icon:SetTexture(icon)
			btn.icon:SetVertexColor(1, 1, 1)

			-- Border color encodes status.
			local r, g, b = 0.35, 0.35, 0.35
			if lockedOH then
				r, g, b = 0.25, 0.25, 0.25
			elseif rec then
				if equippedId == rec.item_id then
					r, g, b = 0, 1, 0
				else
					r, g, b = 1, 0.85, 0
				end
			elseif equippedId then
				r, g, b = 0.65, 0.65, 0.65
			end
			setSlotBorderColor(btn, r, g, b)
		end
	end

	-- Consumable buttons (flask, food). Same composed.* source as the
	-- text body would have read; we just present it as icons in the
	-- shirt/tabard rows of the doll grid.
	local composed = scenarioData and scenarioData.composed or nil
	if doll.consumables then
		for _, c in ipairs(PAPER_DOLL_CONSUMABLES) do
			local btn = doll.consumables[c.id]
			if btn then
				local rec = composed and composed[c.field] or nil
				btn.currentRec = rec
				if rec then
					-- Try to upgrade from a real item icon if WoW's
					-- client has it cached; else use the generic fallback.
					local icon
					if rec.item_id and rec.item_id > 0 then
						icon = GetItemIcon and GetItemIcon(rec.item_id) or nil
					end
					if not icon and rec.name and GetItemInfoInstant then
						local _, _, _, _, foundIcon = GetItemInfoInstant(rec.name)
						icon = foundIcon
					end
					btn.icon:SetTexture(icon or c.fallback)
					btn.icon:SetVertexColor(1, 1, 1)
					setSlotBorderColor(btn, 0.65, 0.65, 0.85)
					btn:Show()
				else
					-- No scan data yet: dim placeholder, no tooltip.
					btn.icon:SetTexture(c.fallback)
					btn.icon:SetVertexColor(0.45, 0.45, 0.45)
					setSlotBorderColor(btn, 0.3, 0.3, 0.3)
				end
			end
		end
	end
end

function Panel.Refresh()
	if not frame then return end

	-- Dev-only Full Sim button: show + reflow scroll only when the
	-- desktop has stamped SimlyResults.dev_mode = true. Reflow is
	-- needed because the dev button lives at y=74 (above the regular
	-- update buttons at y=44); without resizing the scroll, the button
	-- overlays the scroll content's bottom edge.
	if frame.fullSimBtn and frame.scroll then
		local devMode = SimlyResults and SimlyResults.dev_mode
		if devMode then
			frame.fullSimBtn:Show()
			-- Full-sim button at y=286 + 22 tall + 8 gap = y=316.
			frame.scroll:SetPoint("BOTTOMRIGHT", -32, 316)
		else
			frame.fullSimBtn:Hide()
			-- /reload + Sim All row at y=256 + 22 tall + 8 gap = y=286.
			frame.scroll:SetPoint("BOTTOMRIGHT", -32, 286)
		end
	end

	-- Sync each per-scenario talent dropdown with its persisted choice.
	-- Runs on every Refresh (panel open, scenario change, etc.) so the
	-- visible text matches the SavedVars value the next sim will
	-- actually use.
	if frame.talentDropdowns then
		for _, sc in ipairs(ns.SavedVars.SCENARIOS) do
			local dd = frame.talentDropdowns[sc.key]
			if dd then
				local current = ns.SavedVars.GetTalentLoadoutForScenario(sc.key)
				local label = (current == ns.SavedVars.TALENT_EQUIPPED) and "Equipped" or current
				UIDropDownMenu_SetSelectedValue(dd, current)
				UIDropDownMenu_SetText(dd, label)
			end
		end
	end

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

	-- Desktop-liveness banner. When the heartbeat is missing or stale
	-- we surface it at the very top so the user notices even if they
	-- missed the chat line printed on PLAYER_LOGIN. Without this, the
	-- panel would just look idle and the user would wait indefinitely
	-- for a sim that's never going to run.
	if ns.IsDesktopAlive then
		local alive, age = ns.IsDesktopAlive()
		if not alive then
			if age then
				table.insert(lines,
					"|cffffcc00\226\154\160 Simly desktop not running|r |cffaaaaaa(last seen " ..
					math.floor(age / 60) .. "m ago — launch the app and /reload)|r")
			else
				table.insert(lines,
					"|cffffcc00\226\154\160 Simly desktop not running|r |cffaaaaaa(launch the app and /reload)|r")
			end
			table.insert(lines, "")
		end
	end

	-- Show the currently-selected scenario above the status line so the
	-- user always knows which scenario the next "Update sims" will run.
	local activeScenario = ns.SavedVars.GetScenario()
	local scenarioLabel  = SCENARIO_LABELS[activeScenario] or activeScenario
	table.insert(lines, "|cffaaaaaaScenario:|r |cffffff00" .. scenarioLabel .. "|r")
	table.insert(lines, statusBlock())
	table.insert(lines, "")

	-- Cross-character bleed-through guard (Slice A). Without this,
	-- logging into an alt that's never been simmed shows the previously-
	-- simmed character's recommendations as if they were the alt's.
	local resultsValid = resultsAreForActiveCharacter()
	local scenarioData
	if resultsValid then
		-- Get the result bucket for the currently-viewed scenario.
		-- Falls back to top-level fields for v2 files (migration compat).
		scenarioData = (SimlyResults and SimlyResults.scenarios and SimlyResults.scenarios[activeScenario]) or nil
		-- v2 fallback: if no scenarios table but top-level scans exist, treat top-level as the scenario data
		if not scenarioData and SimlyResults and SimlyResults.scans then
			scenarioData = SimlyResults
		end
	end

	if scenarioData and scenarioData.composed then
		local c = scenarioData.composed
		table.insert(lines, "|cffffd700Best loadout|r" ..
			(c.label and (" |cffaaaaaa(" .. c.label .. ")|r") or "") ..
			(c.expected_dps and (" |cff00ff00" .. math.floor(c.expected_dps) .. " dps|r") or ""))

		-- Gear visualization now lives in the paper-doll side panel
		-- (see createPaperDoll / Panel.RefreshPaperDoll). All we keep
		-- in the text body is the one-line "Wearing X/Y" summary so the
		-- user has a glanceable progress number without hovering 16 slots.
		if c.gear then
			local mhIs2H = false
			local mhRec = c.gear.main_hand
			if mhRec and GetItemInfo then
				local _, _, _, _, _, _, _, _, equipLoc = GetItemInfo(mhRec.item_id)
				mhIs2H = (equipLoc == "INVTYPE_2HWEAPON")
			end
			local equippedCount, totalCount = 0, 0
			for _, slot in ipairs(SLOT_DISPLAY_ORDER) do
				local rec = c.gear[slot.id]
				if slot.id == "off_hand" and mhIs2H then rec = nil end
				if rec then
					totalCount = totalCount + 1
					local equippedId = GetInventoryItemID and GetInventoryItemID("player", slot.inv) or nil
					if equippedId == rec.item_id then
						equippedCount = equippedCount + 1
					end
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
		if c.gems then
			table.insert(lines, "  |cff66ccffGems:|r " .. c.gems.name)
		end
		if c.enchants then
			-- Build a stable display order; iterate every covered slot.
			local enchantSlots = {}
			for slot in pairs(c.enchants) do table.insert(enchantSlots, slot) end
			table.sort(enchantSlots)
			for _, slot in ipairs(enchantSlots) do
				local e = c.enchants[slot]
				table.insert(lines, string.format(
					"  |cff66ccff%s enchant:|r %s",
					slot, e.name
				))
			end
		end
	else
		table.insert(lines, "|cffaaaaaa(No sim results yet — click \"Update sims\" then /reload.)|r")
	end
	table.insert(lines, "")

	-- Upgrade priority (Phase 7) — for each equipped piece that isn't
	-- at the track ceiling, the projected DPS gain from a +1 rank
	-- upgrade. Sorted desc by delta_dps. Renders the top 6 to keep
	-- the panel from getting busy; the desktop window shows all.
	if scenarioData and scenarioData.scans
		and scenarioData.scans.upgrade_priority
		and scenarioData.scans.upgrade_priority.status == "done"
		and scenarioData.scans.upgrade_priority.data
	then
		local data = scenarioData.scans.upgrade_priority.data
		local ops = data.opportunities or {}
		table.insert(lines, "|cffffd700Upgrade priority|r |cffaaaaaa(your next-rank wins)|r")
		if #ops == 0 then
			table.insert(lines, "  |cffaaaaaa(every slot is at the track ceiling)|r")
		else
			for i = 1, math.min(6, #ops) do
				local o = ops[i]
				local slot = o.slot or "?"
				local name = o.name or ("Item #" .. tostring(o.item_id))
				local gainColor = (o.delta_dps and o.delta_dps > 0) and "|cff66bb6a" or "|cffaaaaaa"
				table.insert(lines, string.format(
					"  |cffaaaaaa%s|r %s |cffaaaaaa(%d->%d)|r %s+%d|r |cffaaaaaa(%+.2f%%)|r",
					slot,
					name,
					o.current_ilvl or 0,
					o.next_ilvl or 0,
					gainColor,
					o.delta_dps or 0,
					o.delta_pct or 0
				))
			end
			if #ops > 6 then
				table.insert(lines, string.format("  |cffaaaaaa(+%d more in the desktop window)|r", #ops - 6))
			end
		end
		table.insert(lines, "")
	end

	-- Best content to chase (Phase 7 / Slice J) — group opportunities by
	-- source (dungeon / raid encounter) and surface per-source totals
	-- alongside the top items. Answers the user's "which dungeon should
	-- I farm?" by showing total potential DPS gain per source.
	--
	-- v1 EV proxy: sum of delta_dps for upgrades in that source. True
	-- per-item drop probability isn't in our data tables yet — total
	-- potential is the best "value per clear" estimate available.
	if scenarioData and scenarioData.scans
		and scenarioData.scans.best_content
		and scenarioData.scans.best_content.status == "done"
		and scenarioData.scans.best_content.data
	then
		local data = scenarioData.scans.best_content.data
		local ops = data.opportunities or {}

		-- Group opportunities by source_label (Lua mirror of the
		-- desktop's groupContentBySource helper; same logic, same
		-- contract). Drop non-upgrades (delta_dps <= 0).
		local groupMap = {}
		local groupOrder = {}
		for _, op in ipairs(ops) do
			local dps = op.delta_dps or 0
			if dps > 0 then
				local label = op.source_label or "?"
				local g = groupMap[label]
				if not g then
					g = {
						source_label = label,
						source_category = op.source_category,
						upgrade_count = 0,
						total_potential_dps = 0,
						items = {},
					}
					groupMap[label] = g
					table.insert(groupOrder, g)
				end
				g.upgrade_count = g.upgrade_count + 1
				g.total_potential_dps = g.total_potential_dps + dps
				table.insert(g.items, op)
			end
		end
		-- Sort groups desc by total_potential_dps.
		table.sort(groupOrder, function(a, b)
			return a.total_potential_dps > b.total_potential_dps
		end)
		-- Within each group, sort items desc by delta_dps.
		for _, g in ipairs(groupOrder) do
			table.sort(g.items, function(a, b)
				return (a.delta_dps or 0) > (b.delta_dps or 0)
			end)
		end

		table.insert(lines, string.format(
			"|cffffd700Best content to chase|r |cffaaaaaa(%d candidates evaluated, %d sources with upgrades)|r",
			data.candidates_evaluated or 0,
			#groupOrder
		))
		if #groupOrder == 0 then
			table.insert(lines, "  |cffaaaaaa(nothing in enabled content beats your current gear)|r")
		else
			-- Show top 4 sources × top 2 items each.
			local SOURCES_SHOWN = 4
			local ITEMS_PER_SOURCE = 2
			for gi = 1, math.min(SOURCES_SHOWN, #groupOrder) do
				local g = groupOrder[gi]
				local sourceColor = (g.source_category == "raid") and "|cffce93d8" or "|cffffd966"
				table.insert(lines, string.format(
					"  %s%s|r |cffaaaaaa\226\148\128 %d upgrade%s available, +%d total DPS|r",
					sourceColor,
					g.source_label,
					g.upgrade_count,
					g.upgrade_count == 1 and "" or "s",
					math.floor(g.total_potential_dps + 0.5)
				))
				for ii = 1, math.min(ITEMS_PER_SOURCE, #g.items) do
					local o = g.items[ii]
					local slot = o.slot or "?"
					local name = o.name or ("Item #" .. tostring(o.item_id))
					table.insert(lines, string.format(
						"      |cffaaaaaa%s|r %s |cffaaaaaa(ilvl %d)|r |cff66bb6a+%d|r |cffaaaaaa(%+.2f%%)|r",
						slot, name, o.target_ilvl or 0,
						o.delta_dps or 0, o.delta_pct or 0
					))
				end
				if #g.items > ITEMS_PER_SOURCE then
					table.insert(lines, string.format(
						"      |cffaaaaaa(+%d more in the desktop window)|r",
						#g.items - ITEMS_PER_SOURCE
					))
				end
			end
			if #groupOrder > SOURCES_SHOWN then
				table.insert(lines, string.format(
					"  |cffaaaaaa(+%d more sources in the desktop window)|r",
					#groupOrder - SOURCES_SHOWN
				))
			end
		end
		table.insert(lines, "")
	end

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
	-- Refresh the paper-doll side panel from the same scenario data.
	-- Sits at the end of Refresh so any layout work above this point
	-- has settled. pcall'd: a transient WoW API hiccup in the doll
	-- (e.g. an item not yet cached) shouldn't blank the text body.
	local dollOk, dollErr = pcall(Panel.RefreshPaperDoll)
	if not dollOk then
		DEFAULT_CHAT_FRAME:AddMessage(
			"|cffff5555Simly:|r paper-doll refresh failed: " .. tostring(dollErr)
		)
	end
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
