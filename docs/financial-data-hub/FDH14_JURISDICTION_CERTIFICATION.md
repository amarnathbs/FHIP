# FDH-14 — Jurisdiction Certification

## 1. Australia (REUSED)

Every FDH domain from FDH-4 onward has a certified AU path: bank CSV (CBA/Westpac/NAB + ANZ/Macquarie), bank
PDF, payslip, liability (generic CSV extractor, no named-institution adapters yet — disclosed), AU investment
statements (2 certified generic layouts), AU retirement/super statements (4 fund-neutral layouts, no named
super-fund adapter certified — disclosed). This pass's fresh live-DEV script also used AU-profile synthetic
tenants (`country_of_residence: 'AU'`) throughout.

## 2. India banking (REUSED)

Bank CSV: SBI/HDFC/ICICI (R7) + Axis/Kotak (FDH-4) certified. Payslip: India payslip certification exists
(`FDH9_INDIA_PAYSLIP_CERTIFICATION.md`). Retirement: India ingestion is explicitly **partial** — EPF passbook
CSV only; NPS and PPF layouts are not implemented, with 6 named gaps (IN-R1 through IN-R6) all disclosed as
OPEN and explicitly assigned to the canonical Retirement module, not silently left unattributed.

## 3. India investment boundary (spec §58, §85 — FRESH source-inspection re-confirmation this pass)

Re-read `lib/financial-data-hub/investment/` this pass: it contains no India-specific parser, no India holdings
model, no India cost-basis logic, and no India security-master logic. FDH-11's own India Investment Gap
Register (`FDH11_INDIA_INVESTMENT_GAP_REGISTER.md`) independently reaches the same conclusion ("there is no
separate India-specific database schema... 0 India parser/holdings/transaction/cost-basis/valuation/
security-master logic" in FDH-11). This pass adds **zero** new India investment functionality, per spec §58's
explicit instruction, and confirms by source inspection (not merely by citing FDH-11's own report) that none
was added anywhere else in the FDH tree either.

## 4. Cross-border user (spec §86) — REUSED, boundary-only

FDH-11's own report states plainly: "there is no residence/country gate... AU residents already have full
access to India module." This is a genuine, disclosed architectural characteristic (not a defect introduced by
FDH-14): a cross-border AU-resident-with-India-investments user is **not blocked** from seeing their India
holdings — jurisdiction gating does not erase legitimate foreign financial holdings, satisfying the letter of
spec §86 ("verify jurisdiction gating does not erase legitimate foreign financial holdings") by the simple fact
that no erasing gate exists to begin with. This was not re-tested with a fresh synthetic cross-border user in
this pass (disclosed residual R-14-5) — the claim rests on FDH-11's own prior finding plus this pass's
independent source-inspection of the same code.

## 5. Master-data jurisdiction (spec §87) — REUSED

FDH-2's master-data quality certification includes jurisdiction-consistency checks across categories/MCC/
institutions/merchants (61/61 RLS + quality checks). This pass's fresh live-DEV schema probe confirms the
reference tables are live and populated (25 categories, 121 subcategories, 123 merchants, 198 merchant
aliases) — i.e. genuinely in effect in the current environment, not merely designed.

## 6. Verdict (original CONDITIONAL PASS round)

Australia: **PASS**. India banking: **PASS** (with disclosed coverage limits, not overclaimed as universal).
India investment boundary: **PASS**, freshly re-confirmed by source inspection this pass — 0 duplication.
Cross-border: **PASS on reused evidence**; not re-tested fresh this pass (residual R-14-5). Country gating:
**PASS** — no gate exists that would erase foreign holdings, and the Mandatory Country Confirmation gate
(migration `0108`/`0111`, unmerged branch `feature/mandatory-country-confirmation-beta-cleanup`) is explicitly
a separate, already-tracked workstream, not part of FDH-14.

## 7. GAP 4 closure (2026-08-31) — fresh cross-border user, live-proven

Script: `scripts/fdh14_multi_account_cross_border_certification.ts`. One fresh synthetic AU-resident user with
2 bank accounts, 1 credit card, 1 loan, 1 AU brokerage account, 1 AU super account, PLUS a real India
investment relationship, built live on DEV. This closes residual R-14-5 with genuine execution rather than
reused source-inspection:

- **FDH-11 structurally cannot accept an India statement.** A live attempt to insert
  `fdh_investment_statements` with `investment_jurisdiction='IN'` was rejected by a real DB CHECK constraint
  (`23514`) — FDH-11 is AU-only *by construction*, confirming and strengthening the prior source-inspection
  finding with an actual negative-control proof.
- **The India investment relationship uses the real, pre-existing India Investment module pathway**: an
  `ii_accounts` row with `country_code='IN'`, `account_type='demat'` — the same Investment Intelligence schema
  India investments have always used. Zero `fdh_investment_statements` rows reference the India account (no
  parallel FDH structure was created for it, live-confirmed by count).
- AU and India transactions coexist on their own distinct `ii_accounts` within the one shared II schema,
  never merged (1 AU `ii_transactions` row, 1 India `ii_transactions` row, both independently verified).
- Household net worth ($163,000: retirement $180,000 − liabilities $17,000, with $0 from `assets`/`investments`)
  reflects each domain's balance exactly once despite 2 bank accounts + 1 AU brokerage + 1 India demat account +
  2 liabilities + 1 retirement account all coexisting for the one household.

**Verdict: PASS, fresh live-DEV evidence.** Closes Residual Register item R-14-5.
