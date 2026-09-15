/**
 * PC5 (M4) — K.15's acceptance summary and K.21's lifecycle copy.
 *
 * The two pure functions here carry the summary's only real judgements:
 * what counts as complete history, and how an identifier is masked. Both
 * have a "don't claim more than you know" failure mode worth pinning —
 * reporting `complete` for a check that never ran would be exactly the
 * fabricated-assurance PC4-INV-08 is about.
 */
import { describe, it, expect } from 'vitest';
import { PC5_PDF_LIFECYCLE_COPY, deriveHistoryCompleteness, maskFolio } from '@/lib/pc5/acceptanceSummary';
import type { AieReconciliationOutcome } from '@/lib/aie/types';

const rf = (n: number, outcome: AieReconciliationOutcome) => ({ ruleId: `ii_adapter_roll_forward:acc-${n}:inst-${n}`, outcome });

describe('PC5 K.15 — deriveHistoryCompleteness', () => {
  it('reports NOT_ASSESSED when no roll-forward rule ran at all', () => {
    expect(deriveHistoryCompleteness([])).toBe('not_assessed');
    expect(deriveHistoryCompleteness([{ ruleId: 'ii_adapter_duplicate_overlap', outcome: 'pass' }])).toBe('not_assessed');
  });

  it('NOT_ASSESSED is a real answer, not a fallback — a statement with no prior snapshot has no roll-forward to check, and claiming "complete" would assert a check that never ran', () => {
    expect(deriveHistoryCompleteness([{ ruleId: 'ii_adapter_canonical_conflict:acc-1', outcome: 'pass' }])).toBe('not_assessed');
  });

  it('reports COMPLETE only when every roll-forward rule passed', () => {
    expect(deriveHistoryCompleteness([rf(1, 'pass'), rf(2, 'pass_with_tolerance')])).toBe('complete');
  });

  it('reports INCOMPLETE when any roll-forward rule did not pass', () => {
    expect(deriveHistoryCompleteness([rf(1, 'pass'), rf(2, 'fail')])).toBe('incomplete');
    expect(deriveHistoryCompleteness([rf(1, 'indeterminate')])).toBe('incomplete');
    // `not_applicable` on a roll-forward rule that DID run is not a pass.
    expect(deriveHistoryCompleteness([rf(1, 'not_applicable')])).toBe('incomplete');
  });

  it('ignores non-roll-forward rules entirely when at least one roll-forward exists', () => {
    expect(deriveHistoryCompleteness([rf(1, 'pass'), { ruleId: 'ii_adapter_duplicate_overlap', outcome: 'fail' }])).toBe('complete');
  });
});

describe('PC5 K.15 — maskFolio never prints an identifier in full', () => {
  it('keeps only the last four characters of a long folio', () => {
    expect(maskFolio('1122334455')).toBe('******4455');
  });

  it('hides all but the last character of a short folio', () => {
    expect(maskFolio('1234')).toBe('***4');
    expect(maskFolio('12')).toBe('*2');
    expect(maskFolio('7')).toBe('7');
  });

  it('returns null for an absent folio, so the UI can say "not stated" rather than render an empty mask', () => {
    expect(maskFolio(null)).toBeNull();
  });

  it('never returns the input unchanged for anything longer than one character', () => {
    for (const folio of ['12', '123', '1234', '1122334455', 'ABCDEF123456']) {
      expect(maskFolio(folio)).not.toBe(folio);
      expect(maskFolio(folio)).toContain('*');
    }
  });

  it('preserves length, so two different folios of different lengths remain visibly different', () => {
    expect(maskFolio('1122334455')!.length).toBe('1122334455'.length);
  });
});

describe('PC5 K.21 — the PDF lifecycle copy states BOTH halves and the masking limitation', () => {
  it('says the original file is deleted', () => {
    expect(PC5_PDF_LIFECYCLE_COPY.body).toMatch(/permanently deleted/i);
  });

  it('says the investment data REMAINS — the half users get wrong if it is left implicit', () => {
    expect(PC5_PDF_LIFECYCLE_COPY.body).toMatch(/data stays|holdings and transactions below are saved/i);
  });

  it('states plainly that masking cannot be reversed, by the user OR by us', () => {
    expect(PC5_PDF_LIFECYCLE_COPY.maskingNote).toMatch(/cannot be reversed/i);
    expect(PC5_PDF_LIFECYCLE_COPY.maskingNote).toMatch(/by you or by us/i);
  });

  it('never promises a reveal, a recovery or an original copy', () => {
    const all = Object.values(PC5_PDF_LIFECYCLE_COPY).join(' ');
    expect(all).not.toMatch(/\breveal\b/i);
    expect(all).not.toMatch(/you can (still )?(see|view|recover|download) the original/i);
  });
});
