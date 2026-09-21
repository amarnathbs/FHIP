# LR Deferred-Scope Reconciliation

**Date:** 2026-09-14 · **Baseline:** `origin/main` @ `ff35f54`
Mandatory per Section 26. Every use of *deferred*, *future phase*, *out of scope*, *not built*, *not needed*, *N/A*, *by design*, *would require PO decision*, *not attempted*, *not independently verified*, *production disabled*, *gate remains off* that materially affects Live Recovery scope.

**A note on evidence limits.** The original Live Recovery master prompts are **not committed to this repository**. Tier 1 evidence therefore could not be read directly for most rows. Where a deferral's authorisation could not be established from committed evidence, this register says so rather than assuming either way. That is itself a finding: **a programme whose scope authority lives only in chat transcripts cannot be independently audited against its own scope.**

---

## 1. The register

| # | Deferral / claim | Where it appears | Explicit PO authorisation found? | Original requirement removed? | Still active? | Implemented later? | Still missing today? | Blocks production readiness? |
|---|---|---|---|---|---|---|---|---|
| D-01 | Production document upload gated OFF | `featureFlags.ts:28-50`; every FDH route | **Not in this repository.** See §13.6 of the upload-readiness report | Unknown | Yes | No | **Yes** | **Yes** — for FDH. And it does **not** apply to the II pipeline, which is live |
| D-02 | "No worker is implemented in FDH-3; this only creates the job record" | `uploadLifecycle.ts:307-309` | Deferred to "a future FDH-4/5 parser worker" | No | Yes | **No — never built** | **Yes** | **Yes** — this is P1-7; the Expenses journey cannot complete even in DEV |
| D-03 | OCR for scanned bank PDFs | `bank-pdf/ocr.ts:47-49` returns `'eligible_not_available'` | Disclosed as a stub | No | Yes | No | Yes | No — scanned statements are refused cleanly |
| D-04 | Malware scanning | `FDH3_SECURITY_THREAT_MODEL.md:12`; `FDH11_COMPLETION_REPORT.md:208` | Accepted as residual risk **"P2 (bounded — production uploads structurally disabled regardless)"** (`FDH14_RESIDUAL_RISK_REGISTER.md:10`) | No | Yes | No | **Yes** | **Yes — and the acceptance premise is false** (P1-3) |
| D-05 | Production load / performance certification | Nowhere — never attempted | None | No | Yes | No | **Yes** | **Yes** |
| D-06 | LR-11 WP-07 (entity-tagged transaction ingestion) | LR-11 phase report | Recorded as "explicitly deferred" by the phase report (Tier 4) | Unknown | Yes | No | Yes | No |
| D-07 | LR-11 WP-08 (entity reports) | LR-11 phase report | Same | Unknown | Yes | No | Yes | No |
| D-08 | LR-FI-1 §19 — Company / Family Trust owner-tag semantics | `householdContext.ts:62-65`: "Company and family_trust are knowingly left as household context here: LR-FI-1 §19 defers their entity semantics" | Cited as an LR-FI-1 decision (Tier 4) | No | **Yes** | **Partially** — LR-11B hid the values in the UI only | **Yes** — server and DB still accept them, and those rows still hit personal DTI/DSR | No, but it is a live double-count path (P2-5) |
| D-09 | Child entity remains discovery-only | LR-11 scope | Recorded as a PO decision | No | Yes | No (correctly) | n/a | No — **verified intact**; no accidental child model exists |
| D-10 | SMSF transaction ledger / SMSF bank import | Absent from the schema entirely | **No authority found** — the audit brief asks specifically whether this was PO-deferred or only implementation-agent-deferred. **No committed evidence of a PO deferral exists** | Unknown | Yes | No | Yes | No |
| D-11 | Insurance document import | `insurance_policy` is not in `FDH_DOCUMENT_TYPES` | **No authority found.** The brief asks whether the absence was explicitly PO-accepted; nothing in the repository says so | Unknown | Yes | No | Yes | No |
| D-12 | Liability statement PDF import | Liability pipeline is CSV-only by construction | **No authority found.** If PDF was in the original LR-4 scope, it is missing | Unknown | Yes | No | Yes | No |
| D-13 | Retirement statement PDF import | `retirementStatementProcessingService.ts:209-215` fails the document `layout_unsupported` / `pdf_manual_mapping_required` | Disclosed in code as unsupported | Unknown | Yes | No | Yes | No |
| D-14 | Named AU broker adapters | `FDH11_AU_BROKER_ADAPTERS.md:9-15` lists CommSec, CMC Invest, Selfwealth, Stake, nabtrade, Westpac, Macquarie as **UNSUPPORTED** | Documented as unsupported (Tier 4) | Unknown | Yes | No | Yes | No |
| D-15 | CSV report export | `isExportFormatImplemented('csv')` is permanently false | "CSV has no renderer yet and stays feature-gated (spec 5.2/15.2)" | No | Yes | No | Yes | No — but the Reports hub still **advertises** it |
| D-16 | Report versioning lifecycle (publish / revise / retry) | Three routes exist; no UI calls them | Not stated as deferred anywhere — simply unreachable | No | Yes | Built, **unreachable** | Effectively yes | No |
| D-17 | LR-9 "admin allow-side never live-verified" | LR-9 phase report | Disclosed gap; PO later authorised a DEV run and **one bounded synthetic production deletion run before LR-12R** | No | Yes | DEV run done | **The production run was never done** — `account_deletion_requests` has 0 rows in production | **Yes** — and P1-8/P1-9 show it would likely have failed or purged nothing |
| D-18 | LR-10 "no live Stripe/Razorpay round trip" | LR-10 phase report | Disclosed; PO authorised TEST-mode credentials and a full round trip | No | Yes | Run against a **local** server per `LR10_LIVE_PAYMENT_ROUND_TRIP.md` | **Yes for production** — the deployed app has no credentials at runtime (P1-2) | **Yes** |
| D-19 | LR-11 "authenticated two-user cross-tenant journey missing" | LR-11 phase report | Disclosed gap | No | Yes | **No** | **Closed by this audit** — now proven, and it **passes** | No |
| D-20 | LR-12 scope narrowed to "gap-analysis certification, not live re-execution" | LR-12 phase report | Recorded as "explicitly agreed with the user" | No | Superseded by LR-12R | n/a | n/a | n/a |
| D-21 | `report_exports.expires_at` never written | Declared in `0010:150`, read in the download route, never set | Not stated as deferred | No | Yes | No | Yes — exports never expire | No |
| D-22 | `'printed'` / `'exported'` report access events | Declared, never emitted | Not stated | No | Yes | No | Yes | No |
| D-23 | Screen-reader / formal WCAG conformance | `app/(marketing)/accessibility/page.tsx:43-48` explicitly disclaims it | **Honest disclaimer, correctly worded** | No | Yes | No | Yes | No |
| D-24 | Privacy page "Draft — pending legal review" | `privacy/page.tsx:28-31`; duplicated in `terms` and `disclaimer` | Deliberate, with the file header stating it must be replaced before public launch | No | Yes | No | Yes | No — but the app is already public |
| D-25 | `deleteSourceDocumentObject()` exists with zero callers | `lib/services/investment-intelligence/storage.ts:80` | Not stated anywhere | No | Yes | No | **Yes** — II raw uploads are retained indefinitely | **Yes** (part of P1-3) |
| D-26 | Migration `0135`'s cron URL placeholder | `0135:141` — `'<REPLACE_WITH_REACHABLE_DEV_APP_ORIGIN>/api/...'` | Operator note at `:125-134` | No | Yes | Substituted in production by an operator (endpoint proven live today) | The committed file still ships the placeholder | No |

---

## 2. Deferrals that are genuinely authorised and correctly handled

- **D-09 Child entity** — the one deferral this audit can confirm was both authorised and respected. No accidental child financial model exists.
- **D-23 Accessibility conformance** — the disclaimer is accurate and is the only honest thing that could be said given the tooling that exists (none).
- **D-03 OCR** — cleanly stubbed, refuses rather than pretending.
- **D-15 CSV export** — correctly gated in code; only the marketing copy is wrong.

## 3. Deferrals that were never returned to, and should have been

- **D-02** — the missing parser worker is the single reason LR-3's user journey does not exist. Everything downstream of it (10 CSV adapters, 8 PDF adapters, the whole review workspace path from Expenses) is unreachable because of one deferral that was never closed.
- **D-04** — the malware deferral was accepted on a premise that is false.
- **D-05** — load certification was never attempted at any point by anyone.
- **D-08** — a deferral that has since become a live double-count path.
- **D-17, D-18** — both were explicitly authorised by the PO to be closed *before* LR-12R terminal closure. Neither was closed in production, and LR-12R was nonetheless declared an UNCONDITIONAL FULL PASS.

## 4. The structural finding

Of the 26 rows above, **exactly four** can be traced to explicit Product Owner authority from evidence committed to this repository. The remainder rest on phase-report assertions (Tier 4, which Section 3 classifies as "evidence leads, not proof") or on nothing at all.

This is not a claim that the deferrals were unauthorised. It is a claim that **they cannot be shown to be authorised**, because the authority lives outside the artefact. Any future terminal certification of this programme will hit the same wall unless the original scope documents are committed alongside the code.
