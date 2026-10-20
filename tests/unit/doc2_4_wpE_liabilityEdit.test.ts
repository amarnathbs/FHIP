/**
 * Document2 (4) F24 -- "I cannot update any liability now".
 *
 * WHAT THE EVIDENCE SHOWS (see docs/reviews/DOCUMENT2_4_TRUTH_WP-E.md). The Product Owner's two screenshots carry the exact error
 * `new row for relation "liabilities" violates check constraint "chk_liabilities_masked_identifier"`; the "Card / Account Number (masked)" field
 * held a 9 and then a 10 digit account number. The owner model is NOT the cause: UI owner list, Zod enum, API schema and the DB CHECK on
 * `owner` all agree on self / spouse / joint / child / family_trust / company / smsf / other, and an ordinary edit saves for every one of them.
 *
 * These tests fail on the old behaviour (the long number reached the database and came back as a raw constraint message with HTTP 400) and
 * pass after: the schema refuses it in a plain sentence naming the field, the routes translate the database rule if it is ever the first to
 * answer, and the grid checks the field before sending.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { OWNER_VALUES, OWNER_OPTIONS } from '@/lib/constants';
import { liabilitySchema, liabilityPatchSchema } from '@/lib/validation/liability';
import { validationFields } from '@/lib/api';
import {
  MASKED_IDENTIFIER_MESSAGE,
  maskedIdentifierProblem,
  isMaskedIdentifierConstraintError,
} from '@/lib/validation/maskedIdentifier';
import { liabilityGridConfig } from '@/lib/grid/configs';
import { gridFieldBody } from '@/lib/grid/saveBody';

const base = {
  liability_name: 'Personal loan',
  debt_type: 'personal_loan' as const,
  balance: 12000,
  interest_rate: 7.1,
  interest_rate_type: 'variable' as const,
  lender: 'Source finance',
  currency_code: 'AUD' as const,
  country_code: 'AU' as const,
};

describe('F24 owner model is consistent end to end (the brief\'s first hypothesis, tested and cleared)', () => {
  it('the owner list the form offers is exactly the list the schema accepts, and carries no related_partner value', () => {
    expect(OWNER_OPTIONS.map((o) => o.value)).toEqual([...OWNER_VALUES]);
    expect(OWNER_VALUES).not.toContain('related_partner' as never);
  });

  it.each(['self', 'spouse', 'joint'] as const)('an ordinary edit for owner %s validates on create and on a reloaded-row PATCH', (owner) => {
    expect(liabilitySchema.safeParse({ ...base, owner }).success).toBe(true);
    expect(liabilityPatchSchema.safeParse({ owner, balance: 12123 }).success).toBe(true);
  });

  it.each(['mortgage', 'personal_loan', 'credit_card', 'line_of_credit', 'other_term_loan'] as const)('debt type %s edits for every personal owner', (debt_type) => {
    for (const owner of ['self', 'spouse', 'joint'] as const) {
      expect(liabilityPatchSchema.safeParse({ owner, debt_type, balance: 1 }).success).toBe(true);
    }
  });

  it('a row reloaded from the server (SQL nulls) is sent by the grid with the nulls omitted, so the PATCH validates', () => {
    const reloaded = { ...base, owner: 'joint', notes: null, masked_identifier: null, monthly_repayment: null, credit_limit: null, minimum_payment: null, due_date: null };
    const body = { owner: reloaded.owner, currency_code: reloaded.currency_code, liability_name: reloaded.liability_name, ...gridFieldBody(liabilityGridConfig, reloaded, { original: reloaded, applicable: () => true }) };
    expect(Object.values(body).includes(null as never)).toBe(false);
    expect(liabilityPatchSchema.safeParse(JSON.parse(JSON.stringify(body))).success).toBe(true);
  });

  it('an owner outside the catalogue is still refused (the enum is not widened)', () => {
    expect(liabilitySchema.safeParse({ ...base, owner: 'related_partner' }).success).toBe(false);
  });
});

describe('F24 the masked account field', () => {
  it.each(['300017434', '3000017434', '12345678901234', 'xx1234567'])('refuses %s with the plain sentence and names the field', (value) => {
    for (const schema of [liabilitySchema, liabilityPatchSchema]) {
      const r = schema.safeParse({ ...base, masked_identifier: value });
      expect(r.success).toBe(false);
      if (!r.success) {
        const fields = validationFields(r.error);
        expect(fields.masked_identifier).toBe(MASKED_IDENTIFIER_MESSAGE);
        expect(JSON.stringify(fields)).not.toMatch(/chk_|violates|relation|constraint/i);
      }
    }
  });

  it.each(['7434', '****7434', 'xxxx 7434', '123456', '1234-5678'])('accepts the masked tail %s', (value) => {
    expect(liabilitySchema.safeParse({ ...base, masked_identifier: value }).success).toBe(true);
    expect(liabilityPatchSchema.safeParse({ masked_identifier: value }).success).toBe(true);
  });

  it('mirrors the database CHECK exactly: run of 7+ digits refused, 6 allowed, split runs allowed', () => {
    expect(maskedIdentifierProblem('1234567')).not.toBeNull();
    expect(maskedIdentifierProblem('123456')).toBeNull();
    expect(maskedIdentifierProblem('123 4567')).toBeNull(); // the SQL regex is on consecutive digits
    expect(maskedIdentifierProblem('')).toBeNull();
    expect(maskedIdentifierProblem(undefined)).toBeNull();
  });

  it('the grid field carries the guidance and the same pre-submit check', () => {
    const f = liabilityGridConfig.fields.find((x) => x.name === 'masked_identifier')!;
    expect(f.helpText).toMatch(/last 4 digits/i);
    expect(f.validate?.('3000017434')).toBe(MASKED_IDENTIFIER_MESSAGE);
    expect(f.validate?.('7434')).toBeNull();
  });

  it('recognises the database rule by name', () => {
    expect(isMaskedIdentifierConstraintError({ code: '23514', message: 'new row for relation "liabilities" violates check constraint "chk_liabilities_masked_identifier"' })).toBe(true);
    expect(isMaskedIdentifierConstraintError({ message: 'something else' })).toBe(false);
    expect(isMaskedIdentifierConstraintError(null)).toBe(false);
  });
});

// ------------------------------------------------------------------ route level (real handlers, fake registry)
const h = vi.hoisted(() => ({ dbError: null as null | { code?: string; message: string }, writes: 0 }));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, requireCountryConfirmedUser: async () => ({ user: { id: 'u1' }, unauthenticated: null }) };
});
vi.mock('@/lib/services/registry', () => ({
  makeRegistry: () => ({
    async save() { h.writes += 1; return h.dbError ? { data: null, error: h.dbError } : { data: { id: 'new' }, error: null }; },
    async update() { h.writes += 1; return h.dbError ? { data: null, error: h.dbError } : { data: { id: 'row' }, error: null }; },
    async list() { return { data: [], error: null }; },
    async archive() { return { data: null, error: null }; },
  }),
}));
vi.mock('@/lib/services/jurisdiction', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/jurisdiction')>();
  return { ...actual, assertItemCreationAllowedForUser: async () => ({ allowed: true }) };
});
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({}) }));

const json = (body: unknown) => new Request('http://x.test/api/liabilities', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
const DB_RULE = { code: '23514', message: 'new row for relation "liabilities" violates check constraint "chk_liabilities_masked_identifier"' };

describe('F24 the liability routes (real handlers)', () => {
  beforeEach(() => { h.dbError = null; h.writes = 0; });

  it('PATCH with a full number is a 422 with a field message and never reaches the database', async () => {
    const { PATCH } = await import('@/app/api/liabilities/[id]/route');
    const res = await PATCH(json({ masked_identifier: '3000017434' }), { params: Promise.resolve({ id: 'row' }) });
    const body = await res.json();
    expect(res.status).toBe(422);
    expect(body.fields.masked_identifier).toBe(MASKED_IDENTIFIER_MESSAGE);
    expect(JSON.stringify(body)).not.toMatch(/chk_|violates|relation/);
    expect(h.writes).toBe(0);
  });

  it('POST with a full number is a 422 the same way', async () => {
    const { POST } = await import('@/app/api/liabilities/route');
    const res = await POST(json({ ...base, owner: 'joint', masked_identifier: '300017434' }));
    expect(res.status).toBe(422);
    expect((await res.json()).fields.masked_identifier).toBe(MASKED_IDENTIFIER_MESSAGE);
    expect(h.writes).toBe(0);
  });

  it('if the database rule is ever the first to answer, PATCH and POST translate it (no constraint name, no raw message)', async () => {
    h.dbError = DB_RULE;
    const { PATCH } = await import('@/app/api/liabilities/[id]/route');
    const { POST } = await import('@/app/api/liabilities/route');
    for (const res of [await PATCH(json({ balance: 5 }), { params: Promise.resolve({ id: 'row' }) }), await POST(json({ ...base, owner: 'self' }))]) {
      const body = await res.json();
      expect(res.status).toBe(422);
      expect(body.fields.masked_identifier).toBe(MASKED_IDENTIFIER_MESSAGE);
      expect(JSON.stringify(body)).not.toMatch(/chk_|violates|relation/);
    }
  });

  it('an unrelated database error keeps its previous handling (HTTP 400, own message)', async () => {
    h.dbError = { message: 'boom' };
    const { PATCH } = await import('@/app/api/liabilities/[id]/route');
    const res = await PATCH(json({ balance: 5 }), { params: Promise.resolve({ id: 'row' }) });
    expect(res.status).toBe(400);
  });

  it.each(['self', 'spouse', 'joint'])('a normal edit for owner %s is saved (200)', async (owner) => {
    const { PATCH } = await import('@/app/api/liabilities/[id]/route');
    const res = await PATCH(json({ owner, balance: 12123, masked_identifier: '****7434' }), { params: Promise.resolve({ id: 'row' }) });
    expect(res.status).toBe(200);
    expect(h.writes).toBe(1);
  });
});
