# A3 — Compatibility Route Register (Update to `A2_06`)

`A2_06_COMPATIBILITY_ROUTE_REGISTER.md` (the original A2 pass) is re-confirmed accurate and unchanged for everything it already covered. This document adds only what changed in this dispatch, using the source spec's own Control Template 2 field names (Canonical / Deep link / Compatibility / Unavailable / Withdrawn / Retirement).

## 1. New destinations added this dispatch

| Field | Reference Data Quality | Fund Look-Through Quality |
|---|---|---|
| **Canonical** | `/admin/investment-intelligence/reference-data-quality` (primary supported destination, under Data Governance) | `/admin/investment-intelligence/lookthrough-data-quality` (same area) |
| **Deep link** | None — single page, no dynamic children | None |
| **Compatibility** | N/A — this is a *new nav entry point* for an *existing, already-shipped* route (PC6); the route itself never moved, so there is no old URL to preserve | Same |
| **Unavailable** | N/A — fully operational | N/A |
| **Withdrawn** | N/A | N/A |
| **Retirement** | N/A — nothing is being retired | N/A |

Both routes' own page-level and API-level authorization (`requireReferenceDataAdminPage()`/equivalent, pre-existing PC6/PC7 code) are completely unchanged by this dispatch — only their canonical-shell nav visibility changed (previously: correctly gated but with zero nav entry point at all; now: correctly gated and discoverable).

## 2. Routes whose internal capability function was renamed (not moved)

The 34 routes affected by the A3.3 capability split (`A2A5_02A`) are **not** compatibility-route changes at all — no URL changed for any of them. Recorded here only to confirm explicitly that this class of change (an internal auth-function rename) does not interact with the compatibility-route register in any way: the `Canonical` field for all 34 is unchanged from `A1_08`'s original entries.

## 3. Unchanged from `A2_06`

- `admin/resources/content/scheduled/page.tsx` remains **Unavailable** (hide-until-ready, ADM-10) — unchanged.
- `api/admin/recommendations/gaps` remains **Withdrawn** (permanent 503 stub, ADM-06, PO-9 privacy-unsafe carve-out) — unchanged, and confirmed (`A2A5_13` §"Recommendations Gap route remains withdrawn") not reintroduced anywhere by this dispatch.
- `/admin/resources/analytics` remains **Unavailable** (ADM-19) — unchanged.
- No route in this register is a **Retirement** candidate — `A1_08` §10/§11 identifies none, and this dispatch introduces none.

## 4. Mission's monitoring requirement (Control Template 9)

The mission's "Compatibility monitoring" control template requires, for any compatibility route: caller inventory, replacement certification, preserved authorization, ≥1 release cycle of monitored usage, documented rollback, and explicit retirement authorization. **None of this dispatch's changes created a compatibility route** (§1/§2 above), so this template has no applicable rows to populate — recorded as N/A rather than left blank/ambiguous, per the mission's own instruction that "blank fields are unresolved, not implicitly not applicable."
