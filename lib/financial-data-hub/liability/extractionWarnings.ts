/**
 * FDH-10 extraction warnings as PERSISTED, USER-VISIBLE evidence (WP-10, G6).
 *
 * Before WP-10 the warnings an extraction raised -- including every row it
 * EXCLUDED (an unrecognised line type, an unreadable date or amount, a $0.00
 * placeholder) -- only flipped `review_status` and were then lost. They are
 * now stored on `fdh_liability_statements.extraction_warnings` (0207) in this
 * shape and shown on the review screen and in Statement history.
 *
 * Pure; no data access. Safe on the client.
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

const COPY: Record<string, string> = {
  zero_amount: 'A $0.00 line was left out (it moves no money).',
  unrecognised_activity_type: 'A line with a type we do not recognise was left out.',
  unparseable_date: 'A line with an unreadable date was left out.',
  unparseable_amount: 'A line with an unreadable amount was left out.',
  adjustment_direction_unknown: 'The statement has adjustment lines whose direction we could not tell, so its balance could not be checked.',
  adjustment_sign_inferred_from_balance: 'The direction of the adjustment lines was taken from the statement balance.',
  ai_opening_balance_not_printed_dropped: 'The opening balance was not printed on the statement, so it was not used.',
  ai_closing_balance_not_printed_dropped: 'The closing balance was not printed on the statement, so it was not used.',
};

/** One sentence the user reads for a persisted warning. Never empty. */
export function describeLiabilityExtractionWarning(w: LiabilityExtractionWarning): string {
  const base = COPY[w.code]
    ?? (w.code.startsWith('other_activity_not_in_totals') ? 'Some lines of type "Other" are not included in the statement totals.' : null)
    ?? (w.code.startsWith('ai_') ? 'The AI-read draft raised a note on this statement.' : 'The statement raised a note during reading.');
  const where = w.row !== undefined ? ` (row ${w.row}${w.detail ? `: "${w.detail}"` : ''})` : '';
  return `${base}${where}`;
}
