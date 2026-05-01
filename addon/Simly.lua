-- Simly entry point.
-- Module loading order is controlled by the .toc file; this file just creates
-- the shared namespace table that every Core/UI module attaches to via
-- `local addonName, ns = ...`.

local addonName, ns = ...
ns.addonName = addonName
