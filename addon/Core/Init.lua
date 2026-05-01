local addonName, ns = ...

local frame = CreateFrame("Frame")
frame:RegisterEvent("PLAYER_LOGIN")
frame:RegisterEvent("PLAYER_LOGOUT")

frame:SetScript("OnEvent", function(self, event)
	if event == "PLAYER_LOGIN" then
		DEFAULT_CHAT_FRAME:AddMessage("Simly loaded")

		-- Phase 1 spike: read results from the sister addon's global and
		-- announce the best flask to chat. Sister addon is OptionalDeps so
		-- absence is fine on first launch.
		if SimlyResults
			and SimlyResults.questions
			and SimlyResults.questions.best_flask
			and SimlyResults.questions.best_flask.best
		then
			DEFAULT_CHAT_FRAME:AddMessage(
				"Simly: best flask = " .. SimlyResults.questions.best_flask.best.name
			)
		end
	elseif event == "PLAYER_LOGOUT" then
		ns.SavedVars.WriteSnapshot()
	end
end)
