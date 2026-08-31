# FDH-14 — Cross-Domain Deduplication Certification

## 1. Architecture (REUSED, confirmed unchanged by source inspection this pass)

Deduplication is a **single, shared engine** owned by R7/FDH-4 (`lib/financial-data-hub/bank-csv/{dedup,
fingerprint}.ts`) and explicitly reused, unmodified, by every later document-bearing domain:

- FDH-5 (bank PDF) — "R7 dedup/reconciliation reused byte-for-byte unmodified."
- FDH-6 evaluated and **explicitly rejected** building a second, fuzzy dedup layer on top, given the
  date-only granularity of bank data (a documented, deliberate non-decision, not an omission).
- FDH-10/FDH-11/FDH-12 each dedup at the **document** level via FDH-3's SHA-256 `file_hash` mechanism
  (upload-time, user-scoped) and additionally at the **economic-event** level via domain-specific unique
  constraints (e.g. FDH-9's `(user_id, payslip_fingerprint)` partial unique index, FDH-12's contribution
  dedup index).

## 2. Duplicate document (spec §36)

Uploading the identical file bytes twice is refused/short-circuited by FDH-3's hash-based idempotency at the
document layer before any parsing occurs, for every domain that ingests documents. FDH-4's live-DEV
certification specifically re-proved "reprocessing idempotency live-proven (5 tx both times)" for bank CSV.
**REUSED (live)** — not re-executed a second time in this pass (spec §129: unchanged code path, recent
evidence).

## 3. Overlapping statements (spec §37)

- **Banking**: R7's 4-layer, account-scoped economic fingerprint was live-verified across "exact re-import,
  overlapping statements, legitimate identical transactions preserved" (R7 terminal report). **REUSED (live)**.
- **Investments**: FDH-11's duplicate/overlapping-statement negative controls are certified PASS both in
  PGlite and live DEV. **REUSED (live)**.
- **Retirement**: FDH-12's `fdh12DedupAndRollover` suite (39 tests) plus its live round-3 262/262 run
  specifically exercises overlapping contribution/rollover evidence. **REUSED (PGlite + live)**.

## 4. Multiple evidence types → one economic event

This is the core subject of `FDH14_ECONOMIC_EVENT_ORACLE.md` items 1, 7, 8, 9 — payslip+bank, dividend+bank,
employer-super+fund, and rollover-pair evidence are each proven to collapse to exactly one canonical economic
effect. Not re-derived again here; see that document for the full table and citations.

## 5. What FDH-14 did NOT re-run fresh

A byte-for-byte re-upload of the same document twice through a live browser session, for every one of the five
domains, in this specific pass. This is disclosed as REUSED evidence (each domain's own certification round
already did this live) rather than fabricated as a fresh result. See `FDH14_RESIDUAL_RISK_REGISTER.md` item
R-14-1.

## 6. Verdict

Cross-domain deduplication: **PASS**, on REUSED evidence, with the caveat above disclosed rather than hidden.
