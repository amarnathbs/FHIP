# R7 — Format Detection Specification

## Pipeline (deterministic, filename-blind)

```
bytes
  -> decodeCsvBytes()        encoding: utf-8 / utf-8-bom / latin1 (replacement-char heuristic)
  -> detectDelimiter()       , ; \t | — consistent-count-across-lines, else null
  -> findHeaderRowIndex()    scans up to 25 lines for a label-shaped row
  -> parseCsvSafe()          safety-limited RFC4180 parse (row/column/field-length caps)
  -> score every registry adapter's signature against the header
  -> resolve DETECTED / AMBIGUOUS / UNSUPPORTED / MANUAL_MAPPING_REQUIRED / INVALID
```

`detectBankCsvFormat(bytes: Uint8Array)` — a single-argument pure function (certification case R7-TC027 asserts the signature has arity 1, i.e. it is structurally incapable of taking a filename).

## Resolution rule

- Every adapter's `scoreHeader()` returns `[0,1]`: `0.8 × (required headers present) + 0.2 × (optional headers present)`, **exact match only** (not substring — see the fix in `R7_TESTING_AND_VERIFICATION.md` §2 for why substring matching was rejected).
- Best score `< 0.6` (`DETECTION_MIN_CONFIDENCE`) → `manual_mapping_required` (a plausible CSV, no known adapter).
- Best and second-best both `≥ 0.6` and within `0.15` (`DETECTION_CONFIDENCE_GAP`) of each other → `ambiguous`.
- Otherwise → `detected`, adapter = best scorer.
- No delimiter found → `invalid` (`delimiter_not_detected`).
- No header row found in the scan depth → `invalid` (`header_not_found`).
- A safety-limit violation during parsing (row/column/field-length/unterminated quote) → `invalid`, carrying the specific `CsvIntakeError` code.

## Evidence persisted (`fdh_statement_uploads.detection_evidence`, jsonb)

```json
{
  "encoding": "utf-8",
  "delimiter": ",",
  "headerRowIndex": 0,
  "header": ["Date", "Description", "Debit Amount", "Credit Amount", "Balance"],
  "candidates": [{ "adapterId": "au_cba_debit_credit_v1", "score": 1 }, ...]
}
```

Never raw statement rows or amounts — only header labels and adapter scores.

## Confidence-gap constants and their rationale

`DETECTION_MIN_CONFIDENCE = 0.6` and `DETECTION_CONFIDENCE_GAP = 0.15` were chosen so that a lone certified adapter matching all required + all optional headers (score 1.0) resolves DETECTED, while two structurally-similar adapters (e.g. a certified institution adapter and the generic country-neutral fallback, both matching the same required-header set) resolve AMBIGUOUS rather than an arbitrary pick — proven by certification case R7-TC031 (a fixture the generic adapter alone matches cleanly, confirming the constants do not over-trigger AMBIGUOUS on a genuinely unambiguous file) and the exact-match fix (R7-TC021/R7-TC024, which caught and fixed a real false-ambiguity bug from an earlier substring-matching version).
