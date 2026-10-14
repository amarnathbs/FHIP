// What a person is told when the AI reading was not attempted for them (14-10-2026): only the two entitlement
// reasons ever reach the browser, the wording offers the upgrade only to a genuine plan problem, and nothing
// internal (flag, provider, limit, pilot) can leak through it.
import { describe, it, expect } from 'vitest';
import { aiFallbackRefusalFromReason, aiFallbackRefusalNote, AI_FALLBACK_REFUSAL_NOTE } from '@/lib/ai/access/aiFallbackRefusal';

describe('aiFallbackRefusalFromReason', () => {
  it('passes exactly the two entitlement reasons through', () => {
    expect(aiFallbackRefusalFromReason('premium_required')).toBe('premium_required');
    expect(aiFallbackRefusalFromReason('entitlement_unavailable')).toBe('entitlement_unavailable');
  });

  it('never exposes any other gate reason (kill switch, adapter, malware precondition, masking, provider outcome)', () => {
    for (const reason of ['adapter_disabled', 'global_kill_switch_disabled', 'malware_scan_not_enforced', 'masking_unavailable', 'masking_below_policy', 'no_extracted_text', 'budget_exhausted', 'schema_rejected', 'cohort_denied', '', undefined, null]) {
      expect(aiFallbackRefusalFromReason(reason as string | null | undefined), String(reason)).toBeUndefined();
    }
  });
});

describe('aiFallbackRefusalNote', () => {
  it('Free: says it is a Premium feature, tells the person to upgrade and upload again, and mentions manual entry', () => {
    const note = aiFallbackRefusalNote('premium_required')!;
    expect(note).toMatch(/Premium/);
    expect(note).toMatch(/upgrade/i);
    expect(note).toMatch(/upload the file again/i);
    expect(note).toMatch(/manually/i);
  });

  it('unreadable plan: no upgrade offer (an outage is not a plan problem), manual entry still offered', () => {
    const note = aiFallbackRefusalNote('entitlement_unavailable')!;
    expect(note).not.toMatch(/upgrade/i);
    expect(note).toMatch(/try again/i);
    expect(note).toMatch(/manually/i);
  });

  it('anything unrecognised (absent, null, a forged string) yields no note', () => {
    for (const v of [undefined, null, '', 'premium', 'PREMIUM_REQUIRED', 42, {}, ['premium_required']]) expect(aiFallbackRefusalNote(v)).toBeNull();
  });

  it('leaks nothing internal and never uses pilot / invite wording', () => {
    for (const text of Object.values(AI_FALLBACK_REFUSAL_NOTE)) {
      expect(text).not.toMatch(/pilot|invite|allowlist|cohort|openai|gpt|AIE_|kill switch|budget|quota|cost|limited to/i);
    }
  });
});
