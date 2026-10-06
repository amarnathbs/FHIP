// DEV job-control switches the journeys touch. node flags.mjs show | off   ('off' puts the ones the journeys may have armed back to DISABLED)
import { db, flag, setFlag } from './_lib.mjs';
const KEYS = ['nav2_trigger_planner', 'nav2_correction_worker', 'nav2_risk_free_weekly_refresh', 'pc6_selective_historical_hydration', 'nav2_fund_analytics'];
const REASON = {
  nav2_trigger_planner: 'Ships DISABLED: when off the existing user-scoped NAV fetch runs exactly as before, when on the required-window planner sizes the fetch.',
  nav2_correction_worker: 'Ships DISABLED: processes ii_reference_corrections events for fund analytics cache invalidation. Enabling is a deliberate human step.',
  nav2_risk_free_weekly_refresh: 'DEV test finished',
  pc6_selective_historical_hydration: "Ships DISABLED. Per this programme's binding override, no production schedule may be activated by an autonomous agent; enabling is a deferred human-present step once NAV 1.26 (initial historical hydration) is built, DEV-verified, and the dependency-resolution query (accepted statements + benchmark mappings) is live-proven.",
};
if (process.argv[2] === 'off') for (const k of KEYS.filter((k) => k !== 'nav2_fund_analytics')) await setFlag(k, false, REASON[k]);
for (const k of KEYS) console.log(k, JSON.stringify(await flag(k)).slice(0, 90));
