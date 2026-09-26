/**
 * FDH-10 extraction warnings as PERSISTED, USER-VISIBLE evidence (WP-10, G6).
 *
 * Before WP-10 the warnings an extraction raised -- including every row it
 * EXCLUDED (an unrecognised line type, an unreadable date or amount, a $0.00
 * placeholder) -- only flipped `review_status` and were then lost. They are
 * now stored on `fdh_liability_statements.extraction_warnings` (0207) in this
 * shape and shown on the review screen and in Statement history.
 *
 * Pure; no data access. The words the user reads for each code live with the
 * UI (components/liabilities/liabilityLedgerCopy.ts), which imports nothing
 * from this module (tests/unit/fdh1Isolation.test.ts).
 */

export interface LiabilityExtractionWarning {
  /** Stable machine code, e.g. 'zero_amount', 'unrecognised_activity_type'. */
  code: string;
  /** 1-based data row of the source file, when the warning is about one row. */
  row?: number;
  /** A short non-financial detail, e.g. the unrecognised type label. */
  detail?: string;
}

const ROW_PATTERN = /^(?:row|ai_activity)_(\d+)_(.+)$/;
const WITH_DETAIL = ['unrecognised_activity_type_'];

/** Parses the extractors' string warnings into the persisted shape. */
export function toExtractionWarnings(warnings: readonly string[]): LiabilityExtractionWarning[] {
  return warnings.map((w) => {
    const m = ROW_PATTERN.exec(w);
    if (!m) return { code: w };
    const rest = m[2];
    const prefix = WITH_DETAIL.find((p) => rest.startsWith(p));
    if (prefix) return { code: prefix.slice(0, -1), row: Number(m[1]), detail: rest.slice(prefix.length).slice(0, 60) };
    return { code: rest, row: Number(m[1]) };
  });
}
