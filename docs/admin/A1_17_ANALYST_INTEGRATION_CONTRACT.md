# A1 — Analyst Analytics Integration Contract

**Analyst Analytics is its own, separately-named, separately-executed workstream.** A1 integrates its requirements and bounds where it appears; A1 does not rename its phases, does not build its dashboards, and does not implement any of its metrics.

## 1. Current state of the Analyst Analytics track (as of Wave 1)

- **Branch:** `feature/analyst-analytics-wave1-access`, from `origin/main` `1b40b0be0bbb6b7d67b611e08ca255e68562abf1`. **Implemented, certified locally, awaiting Product Owner review and separate push/merge authorisation.** Not merged into the tree this stage's baseline (`21839a8`) reads.
- **Scope of Wave 1, stated in its own document, verbatim:** *"THERE ARE NO ANALYTICS IN WAVE 1. No metric, aggregate, RPC, count, percentage, chart, export or telemetry exists."* Wave 1 built only: the 5-capability model (CAP-01–05 in `A1_02`), the nav reflecting it, a protected empty route (ADM-19), and the 8-route API-gate fix (Analyst previously cleared a coarse check and received a misleading partial/empty `200` on 8 Resources list routes — fixed to a clean 403).
- **Known limitations, disclosed by that track itself:** no live-DEV verification (credential-restricted by its own brief), no DOM-level navigation test (no test environment for it exists), role-revocation propagates only on next page load (route/API layers re-derive every request regardless, so this affects nav visibility only, not authorization).
- **Two self-certified "FULL PASS" rounds of a larger "Phase A Implementation Plan" were each downgraded by Product Owner review** for real technical gaps (route-scope undercounting; capability-coupling and false cross-request-snapshot claims) — a corrective addendum was in flight as of this stage's baseline. **A1 does not adjudicate this** — it is the Analyst Analytics track's own certification history, out of A1's authority to re-score.

## 2. Where Analytics appears in the canonical nav (`A1_06`/`A1_07`)

One top-level area, **Analytics** — never a second Analyst-specific nav root. Today: `canViewResourceAnalytics` gates a hidden-from-nav, honest-unavailable shell (ADM-19). Future: the same area hosts ADM-37 (FDH aggregate) and ADM-46 (canonical cross-domain aggregate) once each is real, all consumed through the one suppression engine (`A1_15`), never a bespoke Analyst-owned one.

## 3. Which capabilities gate its visibility

CAP-05 (`canViewResourceAnalytics`) today; CAP-26 (`canViewFdhAnalytics`) and CAP-30 (`canViewCanonicalAnalytics`) in future, per `A1_02`/`A1_04`. All three are Analyst-eligible **and** Resource-Admin/Super-Admin-eligible (union semantics, never Analyst-exclusive) — Analyst never displaces the broader roles' access to the same area, consistent with Standard §3.

## 4. Which shared components it must reuse

- **The canonical suppression engine** (`A1_15`) — Analyst Analytics implementation must consume it, never build a competing one, per `REG-15`'s binding ruling applied identically to this track as to FDH.
- **The result-state contract** (`ok`/`suppressed`/`unavailable`, Standard §8) — no bespoke Analyst-only result shape.
- **The canonical audit/security-event sink** (`A1_12`), once built — any Analyst-visible aggregate that itself needs an access-audit trail (e.g. "who viewed this dashboard") uses the shared sink, not a new one.
- **Page Pattern 8 (Monitoring)** from `A1_10` for every Analytics-area page.
- **The existing capability-predicate shape** in `lib/resources/permissions.ts` — a pure function over `CurrentResourceRoles`, not a parallel role-resolution mechanism.

## 5. What A1 does not do

- Does not implement any metric, RPC, chart, or export for Analyst.
- Does not expose the Analytics nav item before a genuinely usable destination exists (Standard/`A1_06` rule 1) — today's hidden state is correct and stays hidden until real data exists.
- Does not adjudicate the Phase A Implementation Plan's certification history or its corrective addendum.
- Does not merge, push, or otherwise change the Wave 1 branch's status.

## 6. Handback

Once the Analyst Analytics track's own corrective addendum resolves and the canonical suppression engine (`A1_15`, owned by A4) exists, the concrete next step is building ADM-46 as the real successor to ADM-19 — a straightforward extension of Wave 1's already-certified capability model, not a redesign.
