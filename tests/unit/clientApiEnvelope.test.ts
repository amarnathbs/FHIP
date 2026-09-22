// Regression for a real defect found 2026-09-22: RetirementStatementImportPanel.tsx
// read every success field straight off the raw JSON body (`body.document_id`,
// `body.pipeline_status`, `body.statement`, ...) instead of unwrapping
// lib/api.ts's `ok()` envelope (`{ data: {...} }`), so every field on every
// successful FDH-12 retirement-statement call resolved to `undefined` in
// production from the panel's introduction (commit f744613, 2026-08-30)
// until this fix. `.error` reads happened to still work by coincidence,
// because `bad()` returns `{ error, ... }` unwrapped — which is exactly why
// the bug went unnoticed: every error path looked fine.
//
// This test locks the actual contract between lib/api.ts and readApiJson()
// by round-tripping real Response objects built from `ok()`/`bad()`/
// `badValidation()`, so a future change to either side that breaks the
// pairing fails here instead of silently breaking a client at runtime.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ok, bad, badValidation } from '@/lib/api';
import { readApiJson } from '@/lib/financial-data-hub/clientApiEnvelope';

describe('readApiJson / lib/api.ts envelope contract', () => {
  it('unwraps a successful ok() response to the raw payload', async () => {
    const res = ok({ document_id: 'doc-1', pipeline_status: 'duplicate_statement' });
    const body = await readApiJson(res);
    expect(body).toEqual({ document_id: 'doc-1', pipeline_status: 'duplicate_statement' });
    // The exact failure mode this regresses: reading fields off the raw body
    // instead of body.data would have silently produced `undefined` here.
    expect((body as { document_id?: unknown }).document_id).not.toBeUndefined();
  });

  it('does NOT nest a bad() response under .data — .error reads directly', async () => {
    const res = bad('Could not read this statement.', 400);
    const body = await readApiJson(res);
    expect(body).toEqual({ error: 'Could not read this statement.' });
    expect((body as { data?: unknown }).data).toBeUndefined();
  });

  it('passes through badValidation()\'s { error: CODE, message } shape unwrapped', async () => {
    const schema = z.object({ jurisdiction: z.enum(['AU', 'IN']) });
    const parsed = schema.safeParse({ jurisdiction: 'US' });
    if (parsed.success) throw new Error('expected validation failure');
    const res = badValidation(parsed.error, 422, 'INVALID_JURISDICTION');
    const body = await readApiJson(res);
    expect(body.error).toBe('INVALID_JURISDICTION');
    expect(typeof body.message).toBe('string');
  });

  it('an empty/absent data payload unwraps to {} rather than undefined', async () => {
    const res = ok(undefined);
    const body = await readApiJson(res);
    expect(body).toEqual({});
  });

  it('malformed JSON resolves to {} instead of throwing', async () => {
    const res = new Response('not json', { status: 200 });
    const body = await readApiJson(res);
    expect(body).toEqual({});
  });
});
