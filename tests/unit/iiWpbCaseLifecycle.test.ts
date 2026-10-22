// Document2 (4) WP-B (F5/F6/F7/F14) -- the pure lifecycle decision every screen and route shares.
//
// The PO's live finding: "Resolve statement" asks for a password and then says "Could not retrieve the stored document" because the
// raw file was (correctly) deleted. These tests pin WHAT each case needs, whether the file is needed, and that a file-dependent
// action is never the primary action when the file is gone. Negative controls: with the file present the same case offers the
// file-dependent action; a case that does not need the file never offers "close as stale".
import { describe, expect, it } from 'vitest';
import {
  classifyCase,
  describeReevaluationOutcome,
  describeTruthBlocker,
  hasStoredFile,
  replacementAllowed,
  type LifecycleDocumentState,
} from '@/lib/services/investment-intelligence/caseLifecycle';

const stored: LifecycleDocumentState = { status: 'password_required', storagePath: 'u/a.pdf', storagePurgedAt: null };
const purged: LifecycleDocumentState = { status: 'password_required', storagePath: 'u/a.pdf', storagePurgedAt: '2026-10-01T00:00:00Z' };
const parsedPurged: LifecycleDocumentState = { status: 'parsed', storagePath: 'u/a.pdf', storagePurgedAt: '2026-10-01T00:00:00Z', hasRetainedData: true };

describe('hasStoredFile', () => {
  it('is true only when a path exists and no purge was recorded', () => {
    expect(hasStoredFile(stored)).toBe(true);
    expect(hasStoredFile(purged)).toBe(false);
    expect(hasStoredFile({ status: 'uploaded', storagePath: null, storagePurgedAt: null })).toBe(false);
    expect(hasStoredFile(null)).toBe(false);
  });
});

describe('classifyCase: document_password_required (the PO F5 / F6 case)', () => {
  it('file present: the primary action is to enter the password (negative control)', () => {
    const l = classifyCase('document_password_required', stored);
    expect(l.primary).toBe('enter_password');
    expect(l.need).toBe('password_and_reprocess');
    expect(l.staleClosable).toBe(false);
  });

  it('file deleted: NO password action; a replacement copy is primary and a governed close is offered', () => {
    const l = classifyCase('document_password_required', purged);
    expect(l.primary).toBe('upload_replacement');
    expect(l.secondary).toContain('close_stale');
    expect(l.staleClosable).toBe(true);
    expect(l.need).toBe('information_no_longer_exists');
    expect(l.fileRequired).toBe(true);
    expect(l.explanation).toMatch(/deleted/i);
    expect(l.explanation).not.toMatch(/Could not retrieve/);
  });
});

describe('classifyCase: cases that never need the file', () => {
  const gone = parsedPurged;
  it.each([
    ['owner_unmatched', 'owner_selection', 'choose_owner'],
    ['owner_mismatch', 'owner_selection', 'choose_owner'],
    ['joint_holding_allocation_required', 'owner_selection', 'choose_owner'],
    ['transaction_unclassified', 'transaction_classification', 'classify_transaction'],
    ['cross_source_conflict', 'source_conflict', 'choose_conflict'],
    ['cross_source_review_required', 'source_conflict', 'choose_conflict'],
  ])('%s resolves in place even when the file is gone', (type, need, primary) => {
    const l = classifyCase(type, gone);
    expect(l.need).toBe(need);
    expect(l.primary).toBe(primary);
    expect(l.fileRequired).toBe(false);
    // never offered "close as stale": it can be answered directly
    expect(l.staleClosable).toBe(false);
  });

  it('ambiguous_instrument: the choice can be saved without the file, applying it needs a replacement copy, and it says so', () => {
    const l = classifyCase('ambiguous_instrument', gone);
    expect(l.primary).toBe('choose_instrument');
    expect(l.applyNeedsFile).toBe(true);
    expect(l.secondary).toContain('upload_replacement');
    expect(l.explanation).toMatch(/replacement copy/i);
    // with the file present there is nothing to explain about a replacement
    const withFile = classifyCase('ambiguous_instrument', stored);
    expect(withFile.secondary).not.toContain('upload_replacement');
  });

  it('informational cases offer acknowledge-only, never a resolve button that does nothing', () => {
    for (const t of ['transaction_missing_from_restatement', 'other']) {
      const l = classifyCase(t, gone);
      expect(l.primary).toBe('acknowledge_only');
      expect(l.staleClosable).toBe(false);
    }
  });
});

describe('classifyCase: failed documents and archived statements', () => {
  it('a corrupt / unsupported / incomplete file with the file present offers Discard first', () => {
    for (const t of ['unsupported_document', 'document_corrupt', 'parse_incomplete']) {
      const l = classifyCase(t, { status: 'unsupported', storagePath: 'u/x.pdf', storagePurgedAt: null });
      expect(l.primary).toBe('discard_document');
      expect(l.staleClosable).toBe(false);
    }
  });

  it('the same cases with the file gone offer a replacement copy and a governed close', () => {
    const l = classifyCase('parse_incomplete', { status: 'parse_failed', storagePath: 'u/x.pdf', storagePurgedAt: '2026-10-01T00:00:00Z' });
    expect(l.primary).toBe('upload_replacement');
    expect(l.staleClosable).toBe(true);
  });

  it('a case still open on an archived statement is stale (the PO saw "Archived, 2 issues")', () => {
    const archived: LifecycleDocumentState = { status: 'archived', storagePath: 'u/x.pdf', storagePurgedAt: '2026-10-01T00:00:00Z' };
    expect(classifyCase('transaction_missing_from_restatement', archived).staleClosable).toBe(true);
    // but an owner question is still answered directly: it concerns the account, not the discarded file
    expect(classifyCase('owner_unmatched', archived).staleClosable).toBe(false);
  });

  it('a value / unit mismatch judged from retained data is closable only once the file is gone', () => {
    expect(classifyCase('value_mismatch', stored).staleClosable).toBe(false);
    expect(classifyCase('value_mismatch', parsedPurged).staleClosable).toBe(true);
  });
});

describe('replacementAllowed', () => {
  it('is refused while the file is still stored (that is a duplicate, not a replacement)', () => {
    const r = replacementAllowed(stored);
    expect(r.ok).toBe(false);
  });
  it('is allowed once the file is gone, including for an already-parsed statement', () => {
    expect(replacementAllowed(purged)).toEqual({ ok: true });
    expect(replacementAllowed(parsedPurged)).toEqual({ ok: true });
  });
  it('is refused mid-parse and for a superseded statement, and for a missing one', () => {
    expect(replacementAllowed({ ...purged, status: 'parsing' }).ok).toBe(false);
    expect(replacementAllowed({ ...purged, status: 'superseded' }).ok).toBe(false);
    expect(replacementAllowed(null).ok).toBe(false);
  });
});

describe('describeTruthBlocker (every blocker says what / why / how and has a real CTA or an honest none)', () => {
  const codes = [
    'unresolved_owner',
    'unresolved_instrument',
    'material_unclassified_transaction',
    'open_blocking_reconciliation_case',
    'unit_variance_exceeds_tolerance',
    'source_undetected',
    'parser_fatal_error',
    'document_corrupt',
    'cross_household_conflict',
  ];
  it.each(codes)('%s has a what, why, how', (code) => {
    const g = describeTruthBlocker(code);
    expect(g.what.length).toBeGreaterThan(10);
    expect(g.why.length).toBeGreaterThan(10);
    expect(g.how.length).toBeGreaterThan(10);
  });
  it('an owner blocker links to the Review tab; an open blocking case anchors to the issues list', () => {
    expect(describeTruthBlocker('unresolved_owner').cta).toEqual({ kind: 'link', label: 'Choose the owner', href: '/investment-intelligence/review' });
    expect(describeTruthBlocker('open_blocking_reconciliation_case').cta.kind).toBe('anchor');
  });
  it('a unit variance admits Re-evaluate will not change it and names the real fix (a fuller statement)', () => {
    const g = describeTruthBlocker('unit_variance_exceeds_tolerance');
    expect(g.how).toMatch(/consolidated statement/i);
    expect(g.how).toMatch(/Re-evaluating does not change this/);
  });
  it('an unknown code falls back to the engine message, never a blank', () => {
    expect(describeTruthBlocker('something_new', 'Engine says X').what).toBe('Engine says X');
  });
});

describe('describeReevaluationOutcome', () => {
  it('says it is now ready when it became certified', () => {
    expect(describeReevaluationOutcome('reconciliation_required', 'certified', [])).toMatch(/now ready to publish/);
  });
  it('says nothing changed when it was already certified', () => {
    expect(describeReevaluationOutcome('certified', 'certified', [])).toMatch(/Nothing changed/);
  });
  it('names the first blocker when it still needs review (the click is never silent)', () => {
    const t = describeReevaluationOutcome('reconciliation_required', 'reconciliation_required', ['The units do not match.', 'Another.']);
    expect(t).toMatch(/still needs review: The units do not match\./);
    expect(t).toMatch(/1 more/);
  });
});
