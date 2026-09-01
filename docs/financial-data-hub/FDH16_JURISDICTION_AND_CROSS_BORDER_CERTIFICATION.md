# FDH-16 — Jurisdiction and Cross-Border Certification

## REUSED PRIOR CERTIFIED EVIDENCE

- FDH-14's multi-account/cross-border script (`fdh14_multi_account_cross_border_certification.ts`, 16/16 PASS,
  live DEV): FDH-11's AU-only `CHECK` constraint on `investment_jurisdiction` live-confirmed to reject `'IN'`
  outright; India investment correctly uses the pre-existing `ii_accounts` pathway with 0 parallel FDH structure.
- Mandatory Country Confirmation (MCC): DEV-applied, live-verified in its own certification round (migrations
  `0104`/`0105`/`0108`/`0111`).
- G0-JA-1 (jurisdiction architecture, Wave 1/Wave 2): country confirmation is compulsory; label-variant scope
  (Wave 2) is CONDITIONAL PASS with EPF/PPF/NPS kept as separate items — unchanged by any FDH-16 activity.

## FRESH FDH-16 this round

Every synthetic user created by this round's two live scripts (`fdh16_manual_vs_import_equivalence_certification.mjs`,
`fdh16_dashboard_live_proof_setup.mjs`) required the exact MCC-compliant `user_profiles` shape
(`country_of_residence`, `country_confirmed_at`, `country_source='USER_CONFIRMED'`) before any FDH bridge RPC or
manual insert would succeed — confirmed by direct observation: omitting these fields (as FDH-9/10/12's own
older PGlite fixtures still do, per FDH-15's disclosed finding) would trigger `COUNTRY_CONFIRMATION_REQUIRED`.
This round's own fixtures used the correct pattern throughout and every RPC call succeeded (41/41 combined PASS
across both live scripts), which is fresh, positive, live confirmation that **MCC does not obstruct legitimate
FDH bridge or manual-entry flows for a properly onboarded user** — directly answering spec §161 ("verify current
MCC/country confirmation changes did not break FDH") for the Income/Liability/Retirement/Dashboard paths this
round exercised.

## FDH-9/10/12's own PGlite fixtures (carried-forward finding, not re-fixed here)

FDH-15 disclosed that `fdh9_certification.mjs`/`fdh10_security_certification.mjs`/`fdh12_certification.mjs`, as
currently written, fail partway through fixture setup against the current migration chain because their
synthetic-user helper never marks `user_profiles` country-confirmed. This round did not re-run those three
scripts (no source change to them since FDH-15's own pass) and does not re-litigate the finding — it remains a
P3 test-hygiene gap (the real RPCs work correctly for country-confirmed users, as both this round's and FDH-15's
own live scripts prove), not a live product defect.

## Not re-tested fresh this round

- A dedicated fresh India-resident synthetic household exercising India-specific investment/retirement UI paths.
- A dedicated fresh "AU-resident + India investment" cross-border UI walkthrough (REUSED: FDH-14's own fixture
  covers the canonical-row-level version of this; a browser-rendered walkthrough was not performed this round
  for the reason disclosed in `FDH16_SCOPE_AND_CERTIFICATION_PLAN.md`).

## Verdict

**Jurisdiction and cross-border: PASS**, combining fresh confirmation that MCC does not break the FDH bridges
this round exercised, with REUSED evidence for the AU-only investment constraint and the India `ii_accounts`
pathway (both unchanged since FDH-14).
