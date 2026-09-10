# LR-5/LR-6 closure: consolidated SMSF production journey (2026-09-10)

## Scope

Per the PO's own instruction: rather than reopen LR-5 (SMSF Entity Workspace Foundation) and LR-6 (SMSF P&L/Reconciliation/Forecast/Export) separately, run one real, live-DEV journey through the actual `/retirement` SMSF workspace covering Summary mode, Members, Detailed Holdings, property debt linking, the Summary↔Detailed reconciliation gate, Contributions, P&L/cash flow/Reports/Export, household Net Worth inclusion, personal DTI/DSR exclusion, and household forecast isolation — closing both phases' own disclosed gap ("no live browser walkthrough of the SMSF workspace was performed").

This journey found and fixed **two genuine, previously-uncaught defects** — one a universal editing bug affecting all 7 financial-data-grid registers, one a critical account-deletion failure specific to SMSF Detailed Holdings — and confirmed one real, disclosed UX gap requiring a PO decision rather than a unilateral fix.

## Journey results, step by step, all real and live against a disposable AU-confirmed test account

| Step | Action | Result |
|---|---|---|
| Fund creation | Real UI "+ Add an SMSF" → $150,000, Summary Mode | ✅ Created correctly |
| Members | "+ Add Self", set 100% interest allocation, saved | ✅ Persisted, correctly disclaimed as informational-only |
| Property debt | Created a real Liability ($80,000, "SMSF Property Loan / LRBA"), linked via the SMSF workspace's own "Associated Debt" control | ✅ Linked; reconciliation panel correctly reflected it |
| DTI/DSR — linking alone | Checked household DTI/DSR immediately after linking, liability still `owner='self'` | **Real finding**: zero effect — `debtToIncome`/`debtServiceRatio` completely unchanged by linking alone |
| DTI/DSR — correct exclusion | Tagged the liability `owner='smsf'` via the ordinary Liabilities edit form | ✅ `householdLiabilityBalance`/`debtToIncome`/`debtServiceRatio`/`debtMonthlyRepayments` all correctly dropped to 0; `totalLiabilities`/Net Worth correctly unchanged (wealth stays whole, cash flow excluded — LR-FI-1's own philosophy, now proven for the SMSF-linking case specifically) |
| **Universal editing bug** | Attempting the above edit (any field, on any register, on a row loaded fresh from a page reload) | 🔴 **Found and fixed** — see below |
| Detailed Holdings — negative case | Added one $100,000 holding (gross $100k − $80k linked liability = $20k net, vs. $150k summary), clicked "Use Detailed Holdings" | ✅ Correctly **rejected**: `smsf: cannot switch to detailed mode with an unresolved Net Worth variance of -130000.00 (summary=150000.00, detailed=20000.00)` — the exact DB-level $0-variance gate (migration 0084) working as designed |
| Detailed Holdings — positive case | Added a second $130,000 holding (gross $230k − $80k = $150k, exactly matching summary), retried the switch | ✅ Succeeded — "Detailed Mode — Active valuation"; Net Worth unchanged ($70,000) proving no double-count on a clean reconciliation |
| Switch back to Summary | Entered a new value ($155,000) + valuation date, confirmed via the real dialog | ✅ Succeeded; **both Detailed Holdings rows confirmed still present afterward** — "nothing is deleted" claim live-proven, not just read from a comment |
| Household Net Worth | Checked `/api/dashboard/summary` after every mode change | ✅ `totalRetirement`/`netWorth` correctly tracked the fund's active value at every step (150,000 → 155,000), including through both mode switches |
| Contributions | PATCHed `employer_contribution`/`personal_contribution` directly (no dedicated UI exists — confirmed, matching LR-6's own finding) | ✅ SMSF Reports panel correctly read them back ($2,500 + $1,000 = $3,500/mo) |
| Reports & Export | Opened "Show Reports & Export" with real holdings + real contributions in place | ✅ P&L, Cash Flow, Contributions, and Balance Reconciliation sections all rendered correctly and consistently with the Detailed workspace's own reconciliation panel |
| **Account-deletion cascade failure** | Cleanup: `auth.admin.deleteUser()` on the disposable test user | 🔴 **Found, root-caused, and a fix migration written** — see below |

P&L/cash-flow arithmetic and CSV export byte-parity were not independently re-derived here since LR-6's own live-DEV pass already hand-verified them exactly (real rental income/expense/loan rows, every figure independently calculated and matched) — this journey's incremental value on that front was proving the Reports panel renders correctly against genuinely UI-entered holdings and contributions, which it does.

## CRITICAL FINDING 1: a universal editing bug across all 7 financial-data-grid registers

**Severity: P0/P1 — likely live in production, affecting every register.** Editing *any* field on *any* saved row (Income, Expenses, Assets, Liabilities, Investments, Retirement, Insurance) permanently failed with a raw Zod validation dump —

> ⚠ [ { "code": "invalid_type", "expected": "number", "received": "null", "path": [ "interest_rate" ], ... } ] — try Save again.

— the moment the row was loaded from a genuine page reload (rather than held in memory immediately after creating it in the same session) and had any blank optional field (interest rate, credit limit, lender, notes, country, etc. — extremely common on a real row).

**Root cause**: `components/grid/FinancialDataGrid.tsx`'s `saveRowNow()` builds its save payload as `row[f.name] === '' ? undefined : row[f.name]` for every optional field. A brand-new draft's untouched fields are `''` (from `fieldDefaults()`), correctly hitting this branch and getting omitted. But a row re-hydrated from a real `GET` response has a genuine SQL `NULL` for the same unset column — deserialized to JS `null`, not `''` — and was passed straight through into the JSON body. Every register's Zod schema declares these fields `.optional()`, which accepts the key being *absent* but rejects an explicit `null` outright (`invalid_type`). This was invisible to every prior live-DEV certification pass in this session because every one of them tested Edit immediately after Add, within the same browser session — never after a genuine reload, which is exactly the "reload durability" scenario this whole programme's own checklist names but which had only ever been checked for *reads*, never for *editing after a reload*.

**Fixed**: the omission condition now also treats `null`/`undefined` as "not provided" (`row[f.name] == null`, a deliberate loose-equality check that leaves `0`, `false`, and `''` — already handled — untouched). Verified live: the exact failing save (tagging the SMSF-linked liability `owner='smsf'`) succeeded immediately after the fix, with zero other behavioral change.

## CRITICAL FINDING 2: an SMSF Detailed Holding made account deletion permanently fail

**Severity: P0/P1 — directly relevant to LR-9's own account-deletion certification (this session, same day).** A user who has ever added one real SMSF Detailed Holding could never delete their own account again — `auth.admin.deleteUser()` failed unconditionally with a raw `500 "Database error deleting user"`.

**Root cause, isolated by binary search** (disposable users, incrementally adding fund → member → holding, retrying deletion after each): a bare `smsf_funds` row, and a `smsf_funds` + member row, both deleted cleanly; adding one `smsf_holdings` row reproduced the failure every time. `smsf_holdings` carries an `AFTER ... OR DELETE` trigger (`trg_smsf_holdings_recompute`, migration `0084`) that calls `smsf_recompute_fund()`, which `UPDATE`s `smsf_funds`/`retirement_accounts`. None of these functions were declared `SECURITY DEFINER` — they run with the *invoking role's* privileges, which is fine for an ordinary authenticated user's own RLS-scoped session, but `auth.admin.deleteUser()`'s internal cascade runs under Supabase's own `supabase_auth_admin` role, not the deleted user's session. A direct PostgREST cascade `DELETE` of the same `retirement_accounts` row (same FK graph, invoked as `service_role`) succeeded cleanly, isolating the failure specifically to GoTrue's own execution role — the exact defect *class* already found and fixed once before in this codebase for a different trigger family (MCC-14 / migration `0111`, and its G5B follow-up, migration `0130`: *"a G5B write-permission trigger firing mid-cascade... because by the time [the dependent row] was reached, [a table it read] had already been cascaded away... in the same transaction"* — the same root cause, privilege context rather than row-ordering this time, but the identical never-tested-with-a-real-account-deletion blind spot).

**Fixed**: migration `0137` marks `smsf_recompute_fund()` and its three calling triggers (`trg_smsf_recompute_from_holding`, `trg_smsf_recompute_from_link`, `trg_smsf_recompute_from_liability`) `SECURITY DEFINER SET search_path = public`, matching the exact established MCC-14/G5B precedent. No logic, return type, or RLS policy changed — purely a privilege-context fix. **This migration is written and held locally, not yet applied to DEV** — needs the same DEV-then-production apply-and-independently-verify sequence every other migration in this programme has followed. Once applied, the exact failing reproduction (fund + one holding + `deleteUser()`) needs to be re-run to confirm the fix, which has not yet happened as of this report.

## Disclosed finding requiring a PO decision, not a unilateral fix

**Linking a liability as an SMSF property loan does not automatically exclude it from personal DTI/DSR.** `linkSmsfPropertyLoan()` only inserts a `property_liability_links` row — it never touches the liability's own `owner` column. The correct exclusion signal (LR-FI-1's `owner='smsf'`) is a completely separate, independent step the SMSF workspace's own UI never mentions or guides the user toward — the "Associated Debt" section only discusses the fund's own internal Net Worth reconciliation, never personal cash-flow ratios. Both mechanisms work exactly as individually designed; the gap is discoverability, not correctness. Live-proven both ways: linking alone left `debtToIncome`/`debtServiceRatio` completely unchanged; tagging the same liability `owner='smsf'` correctly zeroed them while leaving `totalLiabilities`/Net Worth untouched. Not fixed here — whether to (a) leave this as-is (two independent, deliberate signals), (b) add a UI hint/prompt when linking, or (c) auto-tag the liability `owner='smsf'` on link (a behavior change with its own implications for a liability that legitimately isn't 100% fund-owned) is a product decision, not an engineering one.

## Reaffirmed, not re-built

- Summary↔Detailed mutual exclusivity's hard $0-variance DB gate (migration `0084`'s `smsf_switch_to_detailed()`) — genuinely live-proven in both directions this session (blocked with the exact variance amount; succeeded once reconciled to the cent).
- "Nothing is deleted" on switch-back — genuinely live-proven (both holdings rows confirmed still present and correctly valued after switching back to Summary).
- LR-6's own P&L/cash-flow/contribution/export arithmetic and CSV/UI parity — not re-derived, since LR-6's own hand-verified live-DEV proof already stands; this journey only added proof that the same pipeline renders correctly against holdings/contributions entered through the real UI/API rather than LR-6's own more minimal setup.
- Household forecast isolation (NEG-06, migration-era `smsfContributionGuard.ts`) — this fund is correctly registered via `smsf_funds.retirement_account_id`, the exact discriminator the guard already keys off; LR-6's own 3 unit tests plus its own live NEG-06 proof already certify the general mechanism, so this was not independently re-derived via the forecast API's own response shape (a lower-value, redundant confirmation of an already-certified guard, correctly triaged against the two genuinely new, higher-severity findings above).

## Cleanup

All disposable users used across the main journey and the bug-isolation binary search were deleted and independently re-verified gone (`getUserById()` returning nothing). One user, created specifically to reproduce the account-deletion defect, could not be deleted through the normal path (that was the defect) — cleaned up via the same workaround the fix will make unnecessary (deleting `retirement_accounts` directly first, which correctly cascades every dependent SMSF row, then `deleteUser()` succeeds). Zero residue.

## What LR-12R needs from here

1. Apply migration `0137` to DEV, confirm, then production, independently re-verify (the established pattern this whole programme uses) — then re-run the exact failing reproduction (fund + one Detailed Holding + `deleteUser()`) to close this finding with positive evidence, not just the fix being merged.
2. A PO decision on the DTI/DSR-exclusion discoverability gap (leave as-is / UI hint / auto-tag).
3. With both closed, LR-5 and LR-6 both move from "no live browser walkthrough performed" to a genuine, real, defect-finding live-DEV certification — a stronger closure than either phase achieved independently.
