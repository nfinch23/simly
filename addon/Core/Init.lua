local addonName, ns = ...

local frame = CreateFrame("Frame")
frame:RegisterEvent("PLAYER_LOGIN")

frame:SetScript("OnEvent", function(self, event)
	if event == "PLAYER_LOGIN" then
		DEFAULT_CHAT_FRAME:AddMessage("Simly loaded")

		-- Capture the SimC export snapshot at login, when the game
		-- runtime has fully loaded character state. PLAYER_LOGOUT was
		-- our first attempt but APIs (GetSpecialization, talent/equipment
		-- queries) return nil/Unknown during teardown — the resulting
		-- export had spec=unknown and no gear. /reload re-fires this
		-- handler so users can refresh the snapshot after a gear or
		-- talent change. The in-memory SimlyDB is flushed to disk
		-- automatically on the next /reload or logout.
		ns.SavedVars.WriteSnapshot()

		-- Read results from the sister addon's global and announce the
		-- best flask to chat. Sister addon is OptionalDeps so absence is
		-- fine on first launch (the desktop hasn't run yet).
		if SimlyResults
			and SimlyResults.questions
			and SimlyResults.questions.best_flask
			and SimlyResults.questions.best_flask.best
		then
			DEFAULT_CHAT_FRAME:AddMessage(
				"Simly: best flask = " .. SimlyResults.questions.best_flask.best.name
			)
		end
	end
end)
