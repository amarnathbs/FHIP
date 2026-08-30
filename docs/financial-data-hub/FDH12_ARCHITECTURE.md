# FDH-12 — Architecture

## The three layers, and why the split exists

```
  ┌──────────────────────────────────────────────────────────────────────┐
  │  lib/financial-data-hub/retirement/        PURE EVIDENCE             │
  │  Parsing, classification, reconciliation, dedup, payslip/bank/       │
  │  rollover matching, SMSF detection, exact-decimal money.             │
  │  Touches fdh_* tables ONLY. May never name a protected Input Data    │
  │  register (FDH-1 contract, tests/unit/fdh1Isolation.test.ts).        │
  └──────────────────────────────┬───────────────────────────────────────┘
                                 │
  ┌──────────────────────────────▼───────────────────────────────────────┐
  │  lib/retirement-import-bridge/             CANONICAL READ            │
  │  Resolves a statement to a canonical retirement account + member.    │
  │  READS retirement_accounts / retirement_members. Writes only the     │
  │  FDH-12 statement row's match state. No canonical mutation.          │
  └──────────────────────────────┬───────────────────────────────────────┘
                                 │
  ┌──────────────────────────────▼───────────────────────────────────────┐
  │  lib/import-bridge/ (+ adapters/retirementAdapter.ts)                │
  │                                            CANONICAL WRITE           │
  │  The generic proposal/apply bridge. fdh12_apply_retirement_proposal()│
  │  is the ONLY path that can change canonical Retirement.              │
  └──────────────────────────────────────────────────────────────────────┘
```

The split is not stylistic. `retirement_accounts` is one of
`FHIP_PROTECTED_INPUT_TABLES`, and no file under `lib/financial-data-hub/` may
name it. FDH-9 solved the same problem with `lib/import-bridge/` and FDH-11
with `lib/investment-import-bridge/`; FDH-12 follows both.

## Module map

| Path | Role |
| --- | --- |
| `lib/financial-data-hub/retirement/money.ts` | Exact-decimal money. Text → integer minor units (`bigint`), never through a float. |
| `lib/financial-data-hub/retirement/types.ts` | Vocabulary; the activity DIRECTION and INTERNAL/EXTERNAL tables. |
| `lib/financial-data-hub/retirement/adapters/types.ts` | Adapter contract. |
| `lib/financial-data-hub/retirement/adapters/genericCsv.ts` | The four certified fund-neutral layouts. |
| `lib/financial-data-hub/retirement/adapters/registry.ts` | Frozen adapter list + certified count. |
| `lib/financial-data-hub/retirement/detection.ts` | Encoding → delimiter → header → signature → DETECTED/AMBIGUOUS/MANUAL_MAPPING_REQUIRED/INVALID. Never uses a filename. |
| `lib/financial-data-hub/retirement/extraction.ts` | Reads a detected CSV into evidence. Fails safe; never zeroes a malformed field. |
| `lib/financial-data-hub/retirement/activityClassification.ts` | Ordered first-match-wins label rules with `unless` vetoes. Unmatched → `UNKNOWN`. |
| `lib/financial-data-hub/retirement/reconciliation.ts` | The balance identity, in exact integer minor units. Zero tolerance. |
| `lib/financial-data-hub/retirement/accountMatching.ts` | Account + member matching. Contains no reference to any balance column. |
| `lib/financial-data-hub/retirement/payslipReconciliation.ts` | FDH-9 employer-super reconciliation. Employer is a required key component. |
| `lib/financial-data-hub/retirement/bankMatching.ts` | Bank corroboration for the two activity types that cross the household-cash boundary. |
| `lib/financial-data-hub/retirement/rolloverIntelligence.ts` | Pairs the two legs of a fund-to-fund transfer. |
| `lib/financial-data-hub/retirement/dedup.ts` | Economic-content fingerprint; overlap, annual-vs-monthly and reissue handling. |
| `lib/financial-data-hub/retirement/smsfDetection.ts` | Routing-only SMSF classifier. Pure; zero imports. |
| `lib/financial-data-hub/services/retirementStatementProcessingService.ts` | Upload + process orchestration. The ninth approved service-role file. |
| `lib/retirement-import-bridge/retirementAccountResolution.ts` | Canonical account/member resolution. |
| `lib/import-bridge/adapters/retirementAdapter.ts` | The typed domain adapter and its nine-column allow-list. |
| `lib/import-bridge/applyRetirementProposalAtomic.ts` | The single RPC caller. |
| `app/api/financial-data-hub/retirement-statement/**` | 7 routes: upload, review, account-match, evidence-matches, approve, proposal, apply. |
| `components/retirement/RetirementStatementImportPanel.tsx` | The Retirement-tab journey. |
| `supabase/migrations/0111_...sql` | 3 evidence tables, 6 guard triggers, 2 RPCs, bridge extension. |

## "No Silent Apply", mechanically

Upload → parse → match → reconcile → review → **approve evidence** →
generate proposal → **USER APPLY**. Everything before the last step leaves
`retirement_accounts` byte-for-byte unchanged, because:

1. No file outside `fdh12_apply_retirement_proposal()` writes it
   (`tests/unit/fdh12Isolation.test.ts`, "the only canonical mutation path").
2. The RPC refuses unapproved evidence (`EVIDENCE_NOT_APPROVED`).
3. The RPC's `v_allowed` array is nine columns, checked before any field name
   reaches SQL.

## The fact that shapes everything

Canonical Retirement is a **summary-balance register** with no event ledger.
There is nowhere to post a contribution, fee, rollover or withdrawal, so
FDH-12 posts none — they remain evidence. That single fact is why spec
sections 59 and 60's double-apply hazards are unreachable rather than merely
guarded. See `FDH12_REUSE_AND_GAP_AUDIT.md` §0.
