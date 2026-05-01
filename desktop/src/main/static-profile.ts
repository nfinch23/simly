/**
 * Hand-written minimal SimC profile used by Phase 2a until the addon's
 * vendored export module ships in Phase 2b. Replace this entire module
 * once `SimlyDB.simc_export` carries a real character profile.
 */
export const STATIC_DESTRO_WARLOCK_PROFILE = `
warlock="SimlyDevWarlock"
level=80
race=human
class=warlock
spec=destruction
fight_style=Patchwerk
max_time=120
`.trim();
