local addonName, ns = ...

-- PLAYER_LOGIN fires before WoW has populated spec / talent / equipment
-- data, so a snapshot taken at that exact moment writes spec=unknown
-- with no gear. We retry every 0.5s until GetSpecialization() returns a
-- valid index (1-4), then take the snapshot. If 6 seconds go by and the
-- spec is still missing (no spec selected on this character — the
-- SimulationCraft addon will report spec=unknown anyway), we give up
-- and write whatever the export produces so the desktop at least has
-- something to fall back on.
local SNAPSHOT_RETRY_LIMIT = 12
local SNAPSHOT_RETRY_INTERVAL = 0.5

local function tryWriteSnapshot(retriesLeft)
	retriesLeft = retriesLeft or SNAPSHOT_RETRY_LIMIT
	local specIndex = GetSpecialization and GetSpecialization()
	if specIndex and specIndex > 0 then
		ns.SavedVars.WriteSnapshot()
		return
	end
	if retriesLeft > 0 then
		C_Timer.After(SNAPSHOT_RETRY_INTERVAL, function()
			tryWriteSnapshot(retriesLeft - 1)
		end)
	else
		-- Give up and snapshot what we have. Desktop runner falls back
		-- to its static profile when simc_export looks broken.
		ns.SavedVars.WriteSnapshot()
	end
end

local frame = CreateFrame("Frame")
frame:RegisterEvent("PLAYER_LOGIN")

frame:SetScript("OnEvent", function(self, event)
	if event == "PLAYER_LOGIN" then
		DEFAULT_CHAT_FRAME:AddMessage("Simly loaded")

		-- Defer the snapshot until spec data is ready (see comment
		-- above). /reload re-fires this handler, so users can refresh
		-- the snapshot after a gear or talent change without quitting
		-- the game. The in-memory SimlyDB is flushed to disk
		-- automatically on the next /reload or logout.
		tryWriteSnapshot()

		-- "Fresh results" popup. If SimlyResults.generated_at is newer
		-- than the last value we recorded as "seen" (via MarkSeen),
		-- announce it loudly so the user knows their /reload revealed
		-- new data. Otherwise stay quiet — the user is probably just
		-- /reloading for an unrelated reason and doesn't want spam.
		local genAt = (SimlyResults and SimlyResults.generated_at) or 0
		local lastSeen = (SimlyDB and SimlyDB.last_seen_generated_at) or 0
		local hasNewResults = genAt > lastSeen and genAt > 0

		-- Read the composed loadout from the sister addon's global and
		-- announce the best flask + food to chat. Sister addon is
		-- OptionalDeps so absence is fine on first launch (the desktop
		-- hasn't run yet). Schema v2: read `composed`, not `questions`.
		if SimlyResults and SimlyResults.composed then
			if hasNewResults then
				DEFAULT_CHAT_FRAME:AddMessage(
					"|cff00ffff*** Simly: fresh sim results ***|r |cffaaaaaa(/simly to view)|r"
				)
				if PlaySound then
					-- 67275 = "ReadyCheck"; loud-ish but not annoying.
					-- Falls through silently if id changes per patch.
					pcall(PlaySound, 67275, "Master")
				end
			end
			if SimlyResults.composed.flask then
				DEFAULT_CHAT_FRAME:AddMessage(
					"Simly: best flask = " .. SimlyResults.composed.flask.name
				)
			end
			if SimlyResults.composed.food then
				DEFAULT_CHAT_FRAME:AddMessage(
					"Simly: best food = " .. SimlyResults.composed.food.name
				)
			end
		end

		if hasNewResults then
			-- Record that we've shown the popup for this generated_at,
			-- so a future /reload with the same results stays quiet.
			ns.SavedVars.MarkSeen(genAt)
		end
	end
end)
