# II-R10 — Entitlement & Packaging

Status: REUSED, unmodified entitlement system (spec sections 41-42, 56-58).

## Canonical entitlement source

`user_entitlements.plan_tier` (`'free' | 'premium'`, effective-dated) —
migration `0010`, RLS SELECT-own only for the authenticated role (writes
are governed elsewhere; not part of R10's changes). `lib/services/entitlements.ts`
exposes `getPlanTier(userId, supabase)` and the stricter, export-specific
`canExportReports(userId, supabase)`.

## Where entitlement is enforced

- **Section inclusion**: `resolveReportSourceData` checks `planTier ===
  'premium'` once, server-side, before running ANY premium-only query
  (including this session's five new II loaders) — a free user's report
  generation never even calls `loadInvestmentPerformanceForReport` etc.,
  let alone renders their output. There is no premium flag anywhere in the
  client request the server trusts.
- **PDF export**: `app/api/reports/[id]/exports/route.ts` calls
  `canExportReports()` before doing anything else; `print`/non-premium
  formats are allowed through, `pdf`/`csv` require premium.
- **No duplicate billing/pricing logic**: report generation code contains
  no price, currency amount, or plan-comparison logic anywhere — it only
  ever reads the boolean-equivalent `plan_tier` value.

## This session's live verification

`scripts/r10_live_dev_certification.mjs`:
- LIVE-R10-B1 (real DEV, real running app): a free user's real generated
  report contained zero premium-only section codes — not just the five new
  II chapters, but none of the 13 pre-existing premium sections either
  (`twelve_month_trends`, `investment_analysis`, `appendices`, etc.) —
  confirming entitlement gating happens once, upstream of every premium
  section, not per-chapter.
- LIVE-R10-B2: a free user's direct `POST /api/reports/{id}/exports`
  `{format: 'pdf'}` attack returned `403` with
  `"Exporting reports requires a premium plan."` — confirmed live, not
  assumed from a code read.

## Not verified this session

- Expired-entitlement behaviour (a user who WAS premium and lost it) —
  spec section 60's question of whether historical premium reports remain
  accessible was not tested; the existing `reports` RLS (SELECT-own,
  unaffected by plan tier) means a report a user already generated remains
  readable by them regardless of current plan tier, but this was not
  live-attack-tested this session.
- Report-id/report-type payload tampering as a premium-bypass vector (spec
  section 42) beyond what LIVE-R10-B1/B2 already covers — a free user
  requesting `reportType: 'monthly_financial_health'` vs `'net_worth'` was
  not separately tested for a tier-bypass angle (there is none in the code:
  `reportType` only selects which template/eligibility rule applies, never
  which tier).
