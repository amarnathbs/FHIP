# FHIP Contextual Import Architecture

**Status:** product-level standard, established by FDH-9 (spec sections 1-4, 54-56).
**Scope of implementation in FDH-9:** Income → Payslip engine, database
bridge, **and UI entry point** — all three now implemented.

**UPDATE (2026-08-29, FDH-11):** the Investments row (§2 below) moves from
"DESIGN RECORDED — FUTURE IMPLEMENTATION" to implemented, for its Australia
half. FDH-11 built the AU statement engine, a new dedicated bridge
(`lib/investment-import-bridge/` — NOT the generic `lib/import-bridge/`
used by Income/Liabilities, because canonical Investment Intelligence is
ledger-shaped rather than single-row-shaped; see
`FDH11_INVESTMENT_INTELLIGENCE_BRIDGE.md` for the full ADR), and the
Investments-tab UI entry point. The India half of the row was never FDH-11's
to build — it reuses the existing, already-implemented `/investment-
intelligence` module unchanged, now also reachable from the Investments tab
via a second "India Investments" entry point. Same honest caveat pattern as
every prior row in this table: PGlite-certified, **not yet applied to a live
Supabase project** (`FDH11_LIVE_DEV_CERTIFICATION.md`), and only one
generic (not per-broker) AU CSV layout is certified
(`FDH11_AU_BROKER_ADAPTERS.md`).

**UPDATE (2026-08-26, live-DEV-cert + Income-tab pass):** the gap the
2026-08-26 hardening pass correctly and honestly disclosed below (no route,
no UI, engine unreachable from the running app) is now closed. `app/(app)/
income/page.tsx` renders an "Import from Payslip" CTA above the unchanged
manual Income grid; `components/income/PayslipImportPanel.tsx` implements
the full Upload → Process → Review → Approve → Propose → Compare → Apply
journey; 6 new routes under `app/api/financial-data-hub/{payslip,income-
proposals}/` connect it to the engine. See `FDH9_INCOME_TAB_UX.md` for the
complete state-by-state account and `FDH9_COMPLETION_REPORT.md` for the
consolidated status. **What remains true from the prior correction**: this
journey has been exercised against PGlite and against the route/service
logic directly (`tests/unit/fdh9IncomeTabUx.test.ts`), but **not** against a
live Supabase project or the actual running browser — migration `0091` has
never been applied to any live database (`FDH9_LIVE_DEV_CERTIFICATION.md`).
The original hardening-pass correction text is preserved below for the
historical record of what was and wasn't true as of that pass.

**Original correction (2026-08-26 hardening pass), preserved for the record:**
an earlier version of this document stated the Income row was "IMPLEMENTED
(FDH-9)" without qualification. That overstated it. Verified directly against
the source tree during the hardening pass (`app/(app)/income/page.tsx` was
unchanged — eight lines, rendered only `<FinancialDataGrid config=
{incomeGridConfig} />` — and a repo-wide search of `app/` for `payslip`/
`import-bridge`/`proposal` found zero routes): no "Import from Payslip"
button, upload screen, extraction preview, compare view, or Apply action
existed anywhere in the UI, and no `app/api/**` route called `lib/import-
bridge/` or `lib/financial-data-hub/payslip/` at all. What FDH-9 had shipped
at that point was the full engine (parser → payroll evidence → proposal →
atomic apply RPC) and its database schema, certified in isolation (PGlite) —
the contextual entry point this document specifies was written up as a
design target but had not yet been built. That gap is what this pass closed
for the Income row specifically; every OTHER row in the table below remains,
as originally stated, a recorded *design decision for a future phase*, not
shipped UI.

---

## 1. The Product Owner decision

FDH capabilities are surfaced **contextually inside the Input Data area**, not as
prominent technical destinations in the main navigation.

A user does not think "I will open the Financial Data Hub and run the payslip
engine." A user thinks "I need to tell FHIP what I earn." The entry point must
therefore live where that thought already takes them: the **Income** tab.

The engines stay exactly where they are. Only the *entry point* moves into the
financial domain.

## 2. The standard

| Input Data domain | Contextual import entry point | Underlying engine | Status |
|---|---|---|---|
| **Income** | "Import from Payslip" | FDH-3 lifecycle → FDH-9 payslip extraction → payroll evidence → import proposal | **ENGINE + DATABASE BRIDGE + UI ENTRY POINT ALL IMPLEMENTED.** `app/(app)/income/page.tsx` + `components/income/PayslipImportPanel.tsx` + 6 routes under `app/api/financial-data-hub/{payslip,income-proposals}/`. PGlite-certified (76/76) and route/auth-tested; **not yet exercised against a live Supabase project** (`FDH9_LIVE_DEV_CERTIFICATION.md`). |
| **Expenses** | "Import Bank Statement" | FDH-3 → R7/FDH-4 (CSV) / FDH-5 (PDF) → R8 → FDH-6 → FDH-7 → FDH-8 | **DESIGN RECORDED — FUTURE IMPLEMENTATION.** Engine already exists and is certified; only the contextual entry point is future work. FDH-9 does **not** rebuild, relocate or rewrite it (spec section 3). |
| **Investments** | "Import Australian Investment Statement" (FDH-11) / "India Investments" (existing Investment Intelligence, reused) | FDH-11: FDH-3 lifecycle → AU CSV detection/extraction → account/security/bank matching → `lib/investment-import-bridge/` → canonical `ii_accounts`/`ii_instruments`/`ii_transactions`/`ii_holding_snapshots` (unchanged tables, R1-R12) → existing R3 publish bridge into `investments`. India: unchanged, existing `/investment-intelligence` module, reused as-is. | **ENGINE + DATABASE EVIDENCE MODEL + BRIDGE + UI ENTRY POINT ALL IMPLEMENTED (FDH-11).** `app/(app)/investments/page.tsx` + `components/investments/AuInvestmentStatementImportPanel.tsx` + 8 routes under `app/api/financial-data-hub/investment-statement/`. Migration `0106` PGlite-certified (20/20 real-Postgres checks, incl. cross-tenant + same-tenant-authority + a harness self-check); **not applied to live DEV from this sandbox** — no DDL execution mechanism was available (`FDH11_LIVE_DEV_CERTIFICATION.md`), the same structural limitation independently documented for an earlier phase's own live-DEV script. Only ONE certified generic AU CSV layout pair exists (no named-broker adapters — `FDH11_AU_BROKER_ADAPTERS.md`). India's own module is unchanged and reused, not rebuilt (`FDH11_INDIA_INTEGRATION.md`). |
| **Liabilities** | "Import Credit Card / Loan Statement" | FDH-3 → generic CSV extraction → economic classification/decomposition/matching (FDH-10) → FDH-9 bridge extension | **ENGINE + DATABASE BRIDGE IMPLEMENTED AND CERTIFIED; UI ENTRY POINT NOT YET BUILT.** `lib/financial-data-hub/liability/*`, `lib/import-bridge/adapters/liabilityAdapter.ts`, migration `0096`'s `fdh10_apply_liability_proposal()` RPC — 52 unit tests + 18 real-Postgres (PGlite) security checks pass; FDH-9's own 330-test suite re-confirmed unchanged. No `app/(app)/liabilities` UI or `app/api` route surface exists yet (see `FDH10_LIABILITIES_TAB_UX.md`), and no per-institution PDF/CSV adapters were built (only one generic column-mapped CSV extractor) — do not treat this row as user-facing-complete. Not yet exercised against a live Supabase project (`FDH10_LIVE_DEV_CERTIFICATION.md`).
| **Retirement** | "Import Super / PF / NPS Statement" | future | DESIGN RECORDED — FUTURE IMPLEMENTATION |

The consistent user-facing sentence across all five is:

> **"Enter it manually, or let FHIP help you import it."**

Manual entry is never removed, never de-emphasised into a secondary action, and
never made conditional on an import (spec section 49).

## 3. The invariant contract — Preview → Compare → Approve → Apply

Every automated import in every domain, present and future, obeys the same four
steps. This is the part of the standard that is **not** negotiable per domain:

1. **Preview** — the engine shows what it read from the document.
2. **Compare** — the proposal is shown *beside* the user's existing data.
3. **User approval** — an explicit, per-field or per-entry choice.
4. **Apply** — and only then does a canonical Input Data register change.

Corollaries, all enforced in code by FDH-9's bridge:

- Upload ≠ Input Data update.
- Successful parse ≠ Input Data update.
- Evidence approval ≠ Input Data update.
- There is **no** background write, **no** upload-triggered overwrite, and **no**
  automatic replacement of manually entered data.

## 4. India investment access (spec section 4)

Recorded as a binding requirement for the future Investments implementation:

- An **India-resident** user is offered "India Investments — Import Indian
  Investment Statement" **prominently by default** from within Investments.
- A **non-India-resident** user who holds Indian investments retains the **same
  capability**. Country of residence influences **default visibility only**; it
  must never **prohibit** legitimate cross-border Indian-investment use.
- The entry point **redirects into the existing Investment Intelligence module**.
  It must **not** re-implement it. There is exactly one Indian-investment engine.

FDH-9 ships **no** Investments UI. Both bullets above are `FUTURE IMPLEMENTATION`
in the FDH-9 certification report, and are stated as such rather than claimed.

## 5. Audit of existing specialist routes — nothing removed

Spec section 55: *"Do not automatically remove existing specialist routes in
FDH-9 — audit them instead."* The audit, from `components/ui/AppShell.tsx`:

| Route | Nav location | Finding | FDH-9 action |
|---|---|---|---|
| `/financial-data-hub/activity` | "Your finances" → **"Financial Activity"** | Already surfaced under a *financial-domain* label, not a technical one. It is a legitimate cross-cutting **review/activity** destination, not an import entry point. | **KEPT UNCHANGED** |
| `/financial-data-hub/review` | not in main nav | Reached contextually from the activity view. Consistent with the standard already. | **KEPT UNCHANGED** |
| `/investment-intelligence` (+ `/performance`, `/sip`, `/tax`, `/xray`, `/review`) | "Plan & improve" → "Investment Intelligence (India)" | A genuine analytical *destination*, not merely an importer. Removing it would delete real user-facing capability. | **KEPT UNCHANGED** |

**Recommended long-term direction** (a recommendation, not an action taken here):
main navigation focuses on user financial domains; specialist *import* engines are
increasingly reached contextually from the relevant domain, while specialist
*analysis* destinations may legitimately keep top-level placement.

Any removal of a top-level route is an explicit UX/navigation change requiring its
own regression testing. **FDH-9 removes none**, and the FDH-9 regression run
confirms the navigation is byte-for-byte unchanged.

## 6. The reusable mechanism

The contract in §3 is implemented **once**, generically, so that each future
domain is an *adapter* rather than a rewrite:

```
lib/import-bridge/
  types.ts              generic proposal / field / apply-mode vocabulary
  proposalEngine.ts     domain-agnostic compare, diff, selected-field, duplicate logic
  applyService.ts       domain-agnostic guarded apply: authz, staleness, idempotency, audit
  adapters/
    incomeAdapter.ts    <- the ONLY domain adapter FDH-9 ships
```

with `fhip_import_proposals.target_domain` a **column**, not a table name.

Adding Expenses later = one adapter file + one enum value. It is explicitly
**not** a schema redesign, and explicitly **not** a second bridge.

Why this lives outside `lib/financial-data-hub/`: the bridge is a platform
service serving five domains, not an FDH internal — and `fdh1Isolation.test.ts`
correctly forbids any file under `lib/financial-data-hub/` from naming
`income_sources`. See `FDH9_REUSE_AND_GAP_AUDIT.md` §4.1.

## 7. Target user experience

**This section is now IMPLEMENTED for the Income row** (see the 2026-08-26
update in the header) — reachable in the running app via Income → Import
from Payslip, PGlite- and route-level certified, not yet live-DEV-certified.

What the user should experience:

> **Income → [Add manually | Import from Payslip] → FHIP reads it → shows what it
> found → matches your bank salary → you review → compare with your current Income
> → YOU choose apply → Income is updated.**

What the user should **never** experience:

> ~~Main Menu → Financial Data Hub → Payslip Engine → Payroll Processor → go find
> some separate financial record~~

The machinery stays invisible. The user stays in Income the entire time.
