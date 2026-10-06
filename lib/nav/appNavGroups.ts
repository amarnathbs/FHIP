// The user sidebar's navigation data (extracted from components/ui/AppShell.tsx so the ORDER and CONTENT of the sidebar are a
// directly testable pure module; there is no DOM test environment in this repository). AppShell renders it; it holds no logic.
// Capability filtering (lib/nav/appNavCapability.ts) is applied by AppShell at render time, never here.

export type NavLink = { type: 'link'; label: string; href: string };
export type NavDropdown = { type: 'dropdown'; id: string; label: string; items: { label: string; href: string }[] };
export type NavEntry = NavLink | NavDropdown;
export type NavGroup = { label: string; items: NavEntry[] };

// "Goal Forecasts" (not "Goals") to avoid colliding with the pre-existing
// top-level Goals link (Module 7's Goal Planning page) — two nav links both
// named exactly "Goals" would make `getByRole('link', {name: /^Goals$/i})`
// ambiguous for tests and for screen readers alike.
export const FORECASTING_ITEMS = [
  { label: 'Overview', href: '/forecast' },
  { label: 'Net Worth', href: '/forecast/net-worth' },
  { label: 'Retirement', href: '/forecast/retirement' },
  { label: 'Goal Forecasts', href: '/forecast/goals' },
  { label: 'Debt Reduction', href: '/forecast/debt' },
  { label: 'Investment Growth', href: '/forecast/investments' },
  { label: 'Cross-Border', href: '/forecast/cross-border' },
  { label: 'Financial Resilience', href: '/forecast/resilience' },
  { label: 'Scenarios', href: '/forecast/scenarios' },
  { label: 'Assumptions', href: '/forecast/assumptions' },
  { label: 'Forecast History', href: '/forecast/history' },
];

// Reports IA correction (2026-09-14, PO instruction — supersedes the LR-8
// WP-02/03/04/06 "link-out card" interpretation in app/(app)/reports/page.tsx,
// which is being retired in the same change). "Reports" becomes an
// expandable group, matching Forecasting's own pattern, with four real
// sidebar sub-links rather than page-body cards duplicating the same
// destinations:
//   - Monthly Report: the pre-existing /reports page itself (Latest Report /
//     Report History / Export Centre) — this WAS "Reports"' own single link.
//   - Financial Activity: MOVED here from "Your finances" below. It is
//     confirmed (by direct inspection, not assumption) to be a pure
//     read-only analysis/insights view — approved-transaction dashboards
//     only, with zero upload/accept/categorise controls of its own — so it
//     never belonged in the input-register group alongside Income/Expenses/
//     Assets in the first place. The actual upload → review → approve
//     workflow lives entirely under Expenses ("Import bank statement" →
//     /financial-data-hub/review) and is UNCHANGED by this move.
//   - Consolidated Report / Forecast Variance: MOVED here from
//     FORECASTING_ITEMS above — both are Forecasting's own GENERATED
//     OUTPUTS (a report and a report-shaped comparison), not the
//     interactive forecasting tool itself, so they belong with the other
//     generated outputs rather than the 11 interactive forecast pages.
export const REPORTS_ITEMS = [
  { label: 'Monthly Report', href: '/reports' },
  { label: 'Financial Activity', href: '/financial-data-hub/activity' },
  { label: 'Consolidated Report', href: '/forecast/report' },
  { label: 'Forecast Variance', href: '/forecast/variance' },
];

// Grouped per the approved design-system nav pattern (Overview / Your
// finances / Plan & improve / Forecasting / Review & share / Account).
// "Forecasting" gets its own group rather than nesting under "Plan &
// improve" — with 13 sub-pages it doesn't fit gracefully two levels deep,
// and the design doc's own module table already treats Forecasting as a
// distinct top-level area.
export const NAV_GROUPS: NavGroup[] = [
  // App Review tier-2 Fix 1: Profile page (app/(app)/profile/page.tsx) had
  // no discoverable nav entry — this is the "Account" group referenced in
  // the design-system nav comment above.
  //
  // PO review 06-10-2026, F9 ("It has been told to bring this on top first item,
  // still reflecting on bottom"): Account / Profile is the FIRST group of the
  // sidebar, above Overview. tests/unit/appSidebarOrder.test.ts pins it.
  {
    label: 'Account',
    items: [{ type: 'link', label: 'Profile', href: '/profile' }],
  },
  {
    label: 'Overview',
    items: [{ type: 'link', label: 'Dashboard', href: '/dashboard' }],
  },
  {
    label: 'Your finances',
    items: [
      { type: 'link', label: 'Income', href: '/income' },
      { type: 'link', label: 'Expenses', href: '/expenses' },
      // FDH-8's "Financial Activity" entry MOVED to the Reports group
      // (2026-09-14, PO instruction) — see REPORTS_ITEMS above. It is a
      // pure read-only analysis view over already-approved statement
      // activity, not a data-entry register, so it never belonged in this
      // input group alongside Income/Expenses/Assets. The actual bank-
      // statement upload/review/approve workflow lives under Expenses
      // ("Import bank statement") and is unaffected by this move.
      { type: 'link', label: 'Assets', href: '/assets' },
      { type: 'link', label: 'Liabilities', href: '/liabilities' },
      // Retirement isn't its own sidebar entry — it's reached via the
      // in-page tab on this grid (InvestmentsSubNav) — so the label makes
      // that explicit rather than implying only Investments lives here.
      { type: 'link', label: 'Investment & Retirement', href: '/investments' },
      { type: 'link', label: 'Insurance', href: '/insurance' },
      // LR-11 — Company entity workspace. LR-13 — Family Trust fast-follow,
      // same route/page, label updated to cover both. Its own destination,
      // not folded into Assets, since an entity's value only reaches
      // personal Net Worth via the ownership-% consolidation model, not as a
      // personally-held asset.
      //
      // M4B — HUF lives on this same route too, but the LABEL DELIBERATELY
      // DOES NOT MENTION IT. This nav array is global and rendered before any
      // country is known: `lib/nav/appNavCapability.ts` filters by CAPABILITY
      // decision, never by country, and no India-only capability key exists in
      // `country_capabilities` today. Naming HUF here would therefore
      // advertise an India-only concept to every Australian user — the exact
      // opposite of SMSF's established rule ("prefer removing irrelevant
      // options entirely", spec s.34). The page itself is country-aware and
      // retitles to "Companies, Trusts & HUF" for an India user; see
      // `app/(app)/companies/page.tsx`.
      { type: 'link', label: 'Companies & Trusts', href: '/companies' },
    ],
  },
  {
    label: 'Plan & improve',
    items: [
      { type: 'link', label: 'Goals', href: '/goals' },
      { type: 'link', label: 'Scores', href: '/score' },
      { type: 'link', label: 'DNA', href: '/dna' },
      { type: 'link', label: 'Resilience', href: '/resilience' },
      { type: 'link', label: 'Twin / Benchmark', href: '/financial-twin' },
      // Investment Intelligence (India) — statement upload / Portfolio
      // Truth review. CORRECTION (FDH-11, 2026-08-29): the comment
      // previously here claiming "does NOT feed Investments/Assets/
      // Dashboard yet" was stale — R3's publishing bridge
      // (investmentPublicationService.ts) has published positions into
      // `investments`/net worth since R3, well before this pass. Kept as
      // its own nav entry (unchanged India behaviour, spec section 83) —
      // it is ALSO now reachable from the Investments tab itself via the
      // "India Investments" button (FDH-11 spec section 76), so a user
      // can reach it either way.
      { type: 'link', label: 'Investment Intelligence (India)', href: '/investment-intelligence' },
    ],
  },
  {
    label: 'Forecasting',
    items: [{ type: 'dropdown', id: 'forecasting', label: 'Forecasting', items: FORECASTING_ITEMS }],
  },
  {
    label: 'Review & share',
    items: [
      { type: 'link', label: 'Recommendations', href: '/recommendations' },
      // Expanded into a dropdown (2026-09-14, PO instruction) — see
      // REPORTS_ITEMS above for what moved here and why.
      { type: 'dropdown', id: 'reports', label: 'Reports', items: REPORTS_ITEMS },
      // Module 11.4 — the standard question library / Insight experience.
      // Deliberately labelled "Insights", not "AI Coach" (that would imply
      // open chat, which does not exist until a later phase).
      { type: 'link', label: 'Insights', href: '/ai-insights' },
    ],
  },
];

