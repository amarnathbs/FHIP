/**
 * `attemptAiPayslipFallback` (payslipProcessingService.ts) — the payslip
 * AI-fallback GATING logic, unit-tested with every external dependency
 * (feature flags, masking, the AI gateway call, the audit log) faked. Never
 * calls a real AI provider or a real database — mirrors
 * `tests/unit/iiAiFallbackDocumentExtractionTrigger.test.ts`'s own
 * "inject a fake provider" discipline for the equivalent Investment
 * Intelligence mechanism this adapter's shape was modelled on.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Pre-existing, unrelated environment gap (found while building this test,
// reported separately): `pdf-parse` is imported by
// `lib/financial-data-hub/bank-pdf/textExtraction.ts` but is not declared in
// package.json / installed in node_modules, so any test that transitively
// imports `payslipProcessingService.ts` fails at import time with
// "Cannot find package 'pdf-parse'" — nothing to do with this dispatch's own
// code. `attemptAiPayslipFallback` never calls `extractPdfPages` (only
// `processPayslipDocument` does), so mocking this one module out is a safe,
// narrow way to unit-test this dispatch's own new function without either
// installing a new dependency or being blocked by a pre-existing gap.
vi.mock('@/lib/financial-data-hub/bank-pdf/textExtraction', () => ({ extractPdfPages: vi.fn() }));

const auditEvents: { eventType: string; metadata?: unknown }[] = [];

vi.mock('@/lib/financial-data-hub/services/auditLog', () => ({
  recordDocumentAuditEvent: vi.fn((e: { eventType: string; metadata?: unknown }) => {
    auditEvents.push(e);
    return Promise.resolve();
  }),
}));

const flagState = { adapterEnabled: false, globalEnabled: false, cohortAllows: true };
vi.mock('@/lib/aie/featureFlags', () => ({
  isAieAiFallbackEnabled: () => flagState.globalEnabled,
  isUserInAiePilotCohort: () => flagState.cohortAllows,
}));
// AIE-1 final completion: the email resolver (service-role Auth lookup) is
// outside this unit's scope; the cohort decision itself is mocked above.
vi.mock('@/lib/aie/pilotCohortEmail', () => ({
  resolveEmailForAiePilotCohort: async () => null,
}));
// ...and so is the durable draft store (migration 0197): reported as not
// present, i.e. the pre-0197 behaviour this suite was written against.
vi.mock('@/lib/financial-data-hub/services/aiFallbackDrafts', () => ({
  saveAiFallbackDraft: async () => ({ persisted: false, reason: 'table_missing' }),
  claimPendingAiFallbackDraft: async () => ({ claimed: false, reason: 'table_missing' }),
  releaseClaimedAiFallbackDraft: async () => undefined,
  documentsWithPendingAiFallbackDrafts: async () => new Set(),
}));

const maskingState = { throwOnMask: false, belowPolicy: false };
vi.mock('@/lib/aie/masking/piiMasking', () => ({
  maskText: (text: string) => {
    if (maskingState.throwOnMask) throw new Error('masking key unset');
    return { maskedText: `MASKED(${text})`, coverageByType: {} };
  },
  isBelowMaskingPolicy: () => maskingState.belowPolicy,
}));

const providerState = { outcome: 'success' as 'success' | 'schema_rejected' | 'kill_switch_blocked', facts: null as unknown };
vi.mock('@/lib/aie/adapters/payslip', () => ({
  AIE_PAYSLIP_DOCUMENT_FACTS_SCHEMA_NAME: 'aie_payslip_document_facts',
  AIE_PAYSLIP_DOCUMENT_FACTS_SCHEMA_VERSION: '1',
  isAiePayslipAiFallbackEnabled: () => flagState.adapterEnabled,
  requestPayslipAiExtraction: vi.fn(() =>
    Promise.resolve(providerState.outcome === 'success' ? { outcome: 'success', facts: providerState.facts } : { outcome: providerState.outcome }),
  ),
  mapPayslipFactsToExtraction: (facts: unknown) => {
    // Minimal stand-in mirroring the real mapping's "needs gross or net" rule.
    const f = facts as { grossPay?: number } | null;
    if (!f || f.grossPay === undefined) return null;
    return { country: 'AU', currencyCode: 'AUD', payFrequency: 'unknown', payFrequencySource: 'stated_on_payslip', grossPay: f.grossPay, components: [], parserName: 'x', parserVersion: '1', extractionConfidence: 0, warnings: [] };
  },
}));

import { attemptAiPayslipFallback } from '@/lib/financial-data-hub/services/payslipProcessingService';

beforeEach(() => {
  auditEvents.length = 0;
  flagState.adapterEnabled = false;
  flagState.globalEnabled = false;
  flagState.cohortAllows = true;
  maskingState.throwOnMask = false;
  maskingState.belowPolicy = false;
  providerState.outcome = 'success';
  providerState.facts = { grossPay: 2000 };
});

describe('attemptAiPayslipFallback', () => {
  it('is disabled by default: this adapter\'s own flag off refuses before any AI call, even if everything else is on', async () => {
    flagState.globalEnabled = true;
    const result = await attemptAiPayslipFallback('user-1', 'doc-1', 'raw text', 'AU');
    expect(result).toEqual({ ok: false, reason: 'adapter_disabled' });
  });

  it('refuses when the SHARED global AIE kill switch is off, even with this adapter enabled', async () => {
    flagState.adapterEnabled = true;
    flagState.globalEnabled = false;
    const result = await attemptAiPayslipFallback('user-1', 'doc-1', 'raw text', 'AU');
    expect(result).toEqual({ ok: false, reason: 'global_kill_switch_disabled' });
  });

  it('refuses when the shared pilot cohort denies this user', async () => {
    flagState.adapterEnabled = true;
    flagState.globalEnabled = true;
    flagState.cohortAllows = false;
    const result = await attemptAiPayslipFallback('user-1', 'doc-1', 'raw text', 'AU');
    expect(result).toEqual({ ok: false, reason: 'cohort_denied' });
  });

  it('degrades to unavailable (never throws) when masking is unavailable', async () => {
    flagState.adapterEnabled = true;
    flagState.globalEnabled = true;
    maskingState.throwOnMask = true;
    const result = await attemptAiPayslipFallback('user-1', 'doc-1', 'raw text', 'AU');
    expect(result).toEqual({ ok: false, reason: 'masking_unavailable' });
  });

  it('refuses and audits when the masked text is still below the masking policy — never sends the payload', async () => {
    flagState.adapterEnabled = true;
    flagState.globalEnabled = true;
    maskingState.belowPolicy = true;
    const result = await attemptAiPayslipFallback('user-1', 'doc-1', 'raw text', 'AU');
    expect(result).toEqual({ ok: false, reason: 'masking_below_policy' });
    expect(auditEvents.map((e) => e.eventType)).toContain('payslip_ai_fallback_masking_below_policy');
  });

  it('propagates a non-success provider outcome as the failure reason, deterministic processing already failed so this is a clean refusal', async () => {
    flagState.adapterEnabled = true;
    flagState.globalEnabled = true;
    providerState.outcome = 'schema_rejected';
    const result = await attemptAiPayslipFallback('user-1', 'doc-1', 'raw text', 'AU');
    expect(result).toEqual({ ok: false, reason: 'schema_rejected' });
  });

  it('refuses when the AI response maps to insufficient fields (neither gross nor net readable)', async () => {
    flagState.adapterEnabled = true;
    flagState.globalEnabled = true;
    providerState.facts = { grossPay: undefined };
    const result = await attemptAiPayslipFallback('user-1', 'doc-1', 'raw text', 'AU');
    expect(result).toEqual({ ok: false, reason: 'insufficient_fields' });
  });

  it('succeeds end-to-end when every gate passes and the AI produced a usable extraction', async () => {
    flagState.adapterEnabled = true;
    flagState.globalEnabled = true;
    const result = await attemptAiPayslipFallback('user-1', 'doc-1', 'raw text', 'AU');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.extraction.grossPay).toBe(2000);
      expect(result.extraction.country).toBe('AU');
    }
    expect(auditEvents.map((e) => e.eventType)).toEqual(
      expect.arrayContaining(['payslip_ai_fallback_attempted', 'payslip_ai_fallback_draft_ready']),
    );
  });

  it('never records a provider-attempt audit event when a gate refused before the AI was ever called', async () => {
    const result = await attemptAiPayslipFallback('user-1', 'doc-1', 'raw text', 'AU');
    expect(result.ok).toBe(false);
    expect(auditEvents).toHaveLength(0);
  });
});
