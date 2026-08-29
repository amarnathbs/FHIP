# FDH-11 — India Integration (spec sections 4, 18, 76-83, 91, 125-129, 142)

## What "the India Investment module" actually is

Discovery finding (see `FDH11_REUSE_AND_GAP_AUDIT.md`): there is no separate India-specific database schema. "The India Investment module" is the `/investment-intelligence` area — the same jurisdiction-agnostic `ii_*` canonical schema (R0-R1), fed today only by two India-specific parsers (CAMS/KFintech, R2) and governed by an India-specific tax engine (R6). Its own page copy and nav label ("Investment Intelligence (India)") reflect that today it is *only* used for India, not that its underlying engine is India-only.

## Integration performed

1. **Navigation**: `app/(app)/investments/page.tsx` gained an "India Investments" button linking to the existing `/investment-intelligence` route — no new page, no new component, no new India processing of any kind.
2. **Stale-claim correction (not a behaviour change)**: both `components/ui/AppShell.tsx`'s nav comment and `/investment-intelligence`'s own page copy claimed "does NOT feed Investments/Assets/Dashboard yet" — false since R3 shipped the publish bridge. Both corrected to state the true, pre-existing behaviour. This is a documentation/copy fix surfaced by this audit, not a functional change to India's own code.
3. **Nothing else.** No India parser, holdings logic, transaction logic, cost-basis logic, valuation logic, security-master logic, or corporate-action logic was created, modified, or duplicated anywhere in this pass. `git diff` against `origin/main` touches zero files under `lib/services/investment-intelligence/parsers/`, `lib/engines/investment-intelligence/tax/`, or any CAMS/KFintech-specific code path.

## Cross-border access (spec sections 7, 77, 126)

Confirmed by code inspection (not modified): `/investment-intelligence` carries no residence/country gate anywhere in its route or page component — any authenticated user, regardless of `user_profiles.country_of_residence`, can reach it. An Australian resident with India investments therefore already had — and continues to have, unaffected by FDH-11 — full access to the India module; FDH-11's own "India Investments" button in the Investments hub simply gives that access a second entry point.

## Certification scope (spec section 91) — what FDH-11 certifies vs. what it does not

FDH-11 certifies only the *integration surface*:
- India module reachable from the Investments hub: verified by code inspection (the `<Link>` is present and points at the correct, existing route) — **not independently verified via a live click-through**, because the Browser-pane preview available in this sandbox could not be pointed at this worktree's dev server (a disclosed environment limitation — see `FDH11_LIVE_DEV_CERTIFICATION.md`).
- India module reused, not rebuilt: verified by `git diff` (zero India-side files touched) and by `tests/unit/fdh11Isolation.test.ts` (the Hub never imports Investment Intelligence code at all, so it structurally cannot have reimplemented any India logic).
- Canonical India output consumption: FDH-11 does not read any India-specific data at all this pass (no unified-summary view was built — see `FDH11_ARCHITECTURE.md`'s scope) — so there is nothing to certify as "consumed correctly" versus "recomputed independently"; the honest answer is N/A, not PASS.

FDH-11 does **not** certify India's own parser correctness, tax correctness, or holdings correctness — those remain the India module's own certified surface (R0-R12), unchanged and unaffected by this pass.

## India gaps discovered

See `FDH11_INDIA_INVESTMENT_GAP_REGISTER.md`. Two entries, both classified as **India Investment module gaps** per the rule matrix (spec section 6) — neither is an FDH-11 integration defect, and neither was fixed here.
