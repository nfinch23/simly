local addonName, ns = ...

-- Register /simly. SLASH_<UPPERCASE>1 = "/cmd" + SlashCmdList["UPPERCASE"]
-- is the canonical Blizzard pattern. Using the addon's primary name as
-- the slash so users don't have to remember a separate alias.
SLASH_SIMLY1 = "/simly"
SlashCmdList["SIMLY"] = function(msg)
	local trimmed = msg and msg:lower():match("^%s*(.-)%s*$") or ""
	if trimmed == "show" then
		ns.Panel.Show()
	elseif trimmed == "hide" then
		ns.Panel.Hide()
	elseif trimmed == "" or trimmed == "toggle" then
		ns.Panel.Toggle()
	else
		DEFAULT_CHAT_FRAME:AddMessage(
			"|cff00ffffSimly:|r usage — /simly [show|hide|toggle]"
		)
	end
end
