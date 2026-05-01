local addonName, ns = ...

local frame = CreateFrame("Frame")
frame:RegisterEvent("PLAYER_LOGIN")
frame:RegisterEvent("PLAYER_LOGOUT")

frame:SetScript("OnEvent", function(self, event)
	if event == "PLAYER_LOGIN" then
		DEFAULT_CHAT_FRAME:AddMessage("Craft Compass loaded")

		-- Phase 1 spike: read results from the sister addon's global and
		-- announce the best flask to chat. Sister addon is OptionalDeps so
		-- absence is fine on first launch.
		if CraftCompassResults
			and CraftCompassResults.questions
			and CraftCompassResults.questions.best_flask
			and CraftCompassResults.questions.best_flask.best
		then
			DEFAULT_CHAT_FRAME:AddMessage(
				"Craft Compass: best flask = " .. CraftCompassResults.questions.best_flask.best.name
			)
		end
	elseif event == "PLAYER_LOGOUT" then
		ns.SavedVars.WritePlaceholder()
	end
end)
