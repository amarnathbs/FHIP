import { describe, it, expect } from 'vitest';
import { ariaLabelForUserState, ariaLabelForCorrectionInput, ariaLiveAnnouncementForRevalidation, textEquivalentForEvidenceRef } from '@/lib/aie/review/ariaLabels';
import { AIE_USER_FACING_STATES } from '@/lib/aie/review/types';
import { GENERIC_FALLBACK_REASON_META } from '@/lib/aie/review/reasonCodes';

// AIE15-A11Y-03/06/07/09 — the one accessibility assertion this repo's
// node-only Vitest harness can genuinely execute (no jsdom/@testing-library
// is configured anywhere in this repo — see ariaLabels.ts's own header).
describe('AIE-1.5 ariaLabels.ts — accessible label/announcement builders (A11Y-03/06/07/09)', () => {
  it('A11Y-07: every user-facing state has a real, non-empty text label — colour is never the only signal', () => {
    for (const state of AIE_USER_FACING_STATES) {
      const label = ariaLabelForUserState(state);
      expect(label.length).toBeGreaterThan(0);
      expect(label).toContain('Status:');
    }
  });

  it('A11Y-03: a correction input label always includes the plain-language question, never just the raw field name', () => {
    const label = ariaLabelForCorrectionInput(GENERIC_FALLBACK_REASON_META, 'Premium');
    expect(label).toContain('Premium');
    expect(label).toContain(GENERIC_FALLBACK_REASON_META.humanQuestion);
  });

  it('A11Y-06: the live-region announcement is always non-empty plain language, never a raw backend state name (IA-07)', () => {
    const readyAnnouncement = ariaLiveAnnouncementForRevalidation({ openBlockingItemCount: 0, runStatus: 'awaiting_acceptance' });
    expect(readyAnnouncement.toLowerCase()).not.toContain('awaiting_acceptance');
    expect(readyAnnouncement.length).toBeGreaterThan(0);

    const oneLeft = ariaLiveAnnouncementForRevalidation({ openBlockingItemCount: 1, runStatus: 'unresolved' });
    expect(oneLeft).toContain('One issue');

    const twoLeft = ariaLiveAnnouncementForRevalidation({ openBlockingItemCount: 2, runStatus: 'unresolved' });
    expect(twoLeft).toContain('2 issues');
  });

  it('A11Y-09: evidence always gets a non-empty text equivalent, even with no evidence_ref at all', () => {
    expect(textEquivalentForEvidenceRef(null).length).toBeGreaterThan(0);
    expect(textEquivalentForEvidenceRef({ ruleId: 'insurance_premium_totals_reconciled', delta: 12.5 })).toContain('12.5');
    expect(textEquivalentForEvidenceRef({ ruleId: 'insurance_document_class_supported' })).toContain('insurance_document_class_supported');
  });
});
