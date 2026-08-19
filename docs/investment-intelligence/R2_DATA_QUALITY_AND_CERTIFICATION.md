# R2 — Data Quality & Certification Model

Status: FINAL

## 1. Design decision: no single opaque score

Spec section 28: "No mysterious black-box score — if an aggregate confidence score is introduced, document its deterministic formula. Prefer transparent status components over a single unexplained percentage."

R2's decision: **do not introduce a single blended confidence percentage at all.** `dataQuality.ts`'s `DataQualityComponents` is a structured object of independently-meaningful fields:

```ts
interface DataQualityComponents {
  sourceConfidence: number | null;             // from the parser's canHandle() detection
  parserConfidence: number | null;             // computeParserConfidence() — formula below
  ownerMappingConfidence: number | null;
  instrumentMappingConfidence: number | null;  // from schemeResolution.ts's per-match confidence
  transactionCompleteness: 'complete' | 'partial' | 'unknown';
  holdingsReconciliation: 'matched' | 'within_tolerance' | 'material_mismatch' | 'not_evaluated';
  statementFreshnessDays: number | null;
  historyCompleteness: IiHistoryCompleteness | null;
}
```

The ONE number this codebase does compute, `parserConfidence`, has its exact formula documented below and is surfaced as one component among several, not blended further.

## 2. The one documented formula: `computeParserConfidence`

`parsers/registry.ts`:

```
score = 1
      - 0.15 * (count of ERROR-severity parser warnings)
      - 0.05 * (count of WARNING-severity parser warnings)
score *= 0.7 + 0.3 * (average transaction classification confidence)   [only if >=1 transaction was parsed]
score = clamp(score, 0, 1)
```

Rationale: a parse ERROR (a row that could not be extracted at all) materially reduces trust, hence the steep 0.15 penalty. A soft WARNING (e.g. one non-material unclassified line) reduces trust more gently. A document whose transactions mostly failed **classification** (not extraction) can lose at most 30% of score — a classification failure still produces a real, auditable canonical transaction (`type = unclassified`), so it is a "we don't know what this is" outcome, not data loss, and is weighted accordingly. Fully tested in `tests/unit/iiR2DataQualityAndConfig.test.ts` (every term of the formula individually verified, plus the 0/1 clamp boundaries).

## 3. Instrument-mapping confidence

Taken directly from `schemeResolution.ts`'s per-match `confidence`: `1.0` for an ISIN/AMFI/exact-identifier match, `0.85` for a normalised-name match, `0.9` for a controlled alias-map match. Never re-derived or blended elsewhere.

## 4. Certification rules

See `R2_PORTFOLIO_TRUTH_AND_RECONCILIATION.md` section 6 for the full blocker/warning list — reproduced here only as a summary table:

| Condition | Effect |
|---|---|
| Document corrupt / source undetected / parser fatal error | Blocks |
| Unresolved owner | Blocks |
| Unresolved/ambiguous instrument | Blocks |
| Cross-household conflict | Blocks |
| Invalid canonical record | Blocks |
| Open blocking-severity reconciliation case | Blocks |
| Material unclassified transaction | Blocks |
| Unit variance outside tolerance | Blocks |
| Incomplete transaction history (holdings still reconcile) | Warns |
| Holdings-only position | Warns |
| Reconciliation not evaluable (no opening balance) | Warns |
| Stale statement date | Warns |
| Non-material unclassified line | Warns |
| None of the above | `CERTIFIED` |

A blocker is **never** downgraded to a warning even when warning-triggering conditions are also present — proven directly (`tests/unit/iiR2Certification.test.ts`, "a blocker is NEVER downgraded to a warning even when warning-triggering conditions are also present").

## 5. Explainability at the UI layer

The minimal R2 UI (`components/investment-intelligence/InvestmentIntelligenceClient.tsx`) surfaces `blocking_reasons`/`warning_reasons` (each `{code, message}`) directly from `ii_portfolio_truth_status`, not a summarised score — a user (or this project's future support/QA process) can see exactly WHY a position is not yet `CERTIFIED`.
