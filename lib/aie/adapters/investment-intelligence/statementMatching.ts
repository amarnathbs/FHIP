/**
 * AIE-1.2 — statement-period matching (execution sequence step 7's third
 * named dimension: "account/owner/instrument/statement-period matching").
 * Pure, structural validation only — never guesses a missing/invalid period.
 */

export interface StatementPeriodCheck {
  ok: boolean;
  reasonCode?: 'statement_period_missing' | 'statement_period_invalid_order' | 'statement_as_of_date_missing';
}

export function checkStatementPeriod(metadata: {
  statementPeriodStartIso: string | null;
  statementPeriodEndIso: string | null;
  statementAsOfDateIso: string | null;
}): StatementPeriodCheck {
  if (!metadata.statementAsOfDateIso) {
    return { ok: false, reasonCode: 'statement_as_of_date_missing' };
  }
  if (metadata.statementPeriodStartIso && metadata.statementPeriodEndIso) {
    if (metadata.statementPeriodStartIso > metadata.statementPeriodEndIso) {
      return { ok: false, reasonCode: 'statement_period_invalid_order' };
    }
  }
  // A statement that legitimately covers "since inception" prints no
  // explicit start (see camsParser.ts's own since-inception handling,
  // memory: iiCamsSinceInceptionUnlabelledStatementPeriod) — absence of a
  // start/end pair alone is therefore NOT treated as invalid; only a
  // genuinely missing as-of date (no closing reference point at all) is.
  return { ok: true };
}
