// DOCUMENT2 (4) review, WP-C: the entity screens and routes (F21 SMSF liability form, F22 rent, F23 expenses and the SMSF bank statement entry, F23b Company /
// Family Trust / HUF workspace). EVIDENCE LABEL: UNIT-TESTED by rendering to static HTML and by the real route handlers over the in-memory PostgREST fake.
// There is no DOM environment and NO signed-in browser session was used: layout at 375 / 768 / 1280 px and keyboard behaviour are NOT verified in a real browser.
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createInMemoryDb, type Row } from './support/inMemorySupabase';
import { EntityModeChooser, ENTITY_NET_ONLY_NOTE } from '@/components/entities/EntityModeChooser';
import { EntityFlowPanel } from '@/components/entities/EntityFlowPanel';
import { SmsfLiabilityForm } from '@/components/retirement/smsf/SmsfLiabilityForm';
import { SmsfHoldingForm } from '@/components/retirement/smsf/SmsfHoldingForm';
import { SmsfCashFlowSection } from '@/components/retirement/smsf/SmsfCashFlowSection';
import type { SmsfFundRow, SmsfHoldingRow } from '@/components/retirement/smsf/types';
import { businessEntityCreateInputSchema } from '@/lib/validation/businessEntity';
import { smsfLiabilitySchema } from '@/lib/validation/smsf';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const FUND = { id: 'f1', fund_name: 'PO SMSF', mode: 'detailed', currency_code: 'AUD' } as SmsfFundRow;
const PROPERTY = { id: 'p1', holding_name: '250 Elizebth st', holding_class: 'property' } as SmsfHoldingRow;

describe('F21: the SMSF liability form carries the canonical liability fields and never sends the user to personal Liabilities', () => {
  const html = renderToStaticMarkup(h(SmsfLiabilityForm, { fundId: 'f1', currency: 'AUD', propertyHoldings: [PROPERTY], onSaved: () => undefined, onCancel: () => undefined }));
  const t = text(html);
  it('asks for lender, balance, rate, rate type, repayment, due date, account (last 4) and the property it funds', () => {
    for (const label of ['Lender', 'Outstanding balance', 'Interest rate %', 'Rate type', 'Monthly repayment', 'Next payment due', 'Account number, last 4 digits', 'Property this loan funds']) expect(t).toContain(label);
    expect(t).toContain('250 Elizebth st');
  });
  it('says plainly that it is a debt of the fund, not personal, and has no link to the personal Liabilities page', () => {
    expect(t).toContain('This is a debt of the fund, not yours');
    expect(t).toContain('never appears in your personal liabilities');
    expect(html).not.toContain('href="/liabilities"');
    expect(read('components/retirement/smsf/SmsfDetailedWorkspace.tsx')).not.toContain('/liabilities"');
  });
  it('a whole account number is refused before it is sent (the PO\'s 300017434), 4 digits pass the shared rule', () => {
    const base = { liability_name: 'Loan', liability_type: 'property_loan', balance: 1, currency_code: 'AUD' };
    expect(smsfLiabilitySchema.safeParse({ ...base, masked_identifier: '300017434' }).success).toBe(false);
    expect(smsfLiabilitySchema.safeParse({ ...base, masked_identifier: '7434' }).success).toBe(true);
    expect(smsfLiabilitySchema.safeParse({ ...base, interest_rate_type: 'fixed', fixed_rate_expiry: '2027-03-31' }).success).toBe(true);
  });
});

describe('F22: rent is an amount and a frequency on the fund\'s own income, not a dropdown of someone else\'s record', () => {
  it('the property asset form no longer offers "Linked Rental Income", it points at Income and says why', () => {
    const html = renderToStaticMarkup(h(SmsfHoldingForm, { fundId: 'f1', currency: 'AUD', existing: { ...PROPERTY, holding_type: 'residential_property', value: 475_000, currency_code: 'AUD', country_code: 'AU', linked_income_source_id: null, notes: null } as SmsfHoldingRow, onSaved: () => undefined, onCancel: () => undefined }));
    expect(html).not.toContain('Linked Rental Income');
    expect(text(html)).toContain('Rent this property earns is entered under Income and expenses below');
  });
  it('a property still tied to a personal income record says it is recorded the earlier way and keeps the link untouched', () => {
    const html = renderToStaticMarkup(h(SmsfHoldingForm, { fundId: 'f1', currency: 'AUD', existing: { ...PROPERTY, holding_type: 'residential_property', value: 1, currency_code: 'AUD', country_code: 'AU', linked_income_source_id: 'inc-1', notes: null } as SmsfHoldingRow, onSaved: () => undefined, onCancel: () => undefined }));
    expect(text(html)).toContain('recorded the earlier way');
    expect(read('components/retirement/smsf/SmsfHoldingForm.tsx')).toContain('legacyLinkedIncomeSourceId');
  });
  it('the income panel is entity scoped, says it never appears in personal Income, and offers add', () => {
    const t = text(renderToStaticMarkup(h(EntityFlowPanel, { flow: 'income', apiBase: '/api/smsf/f1', currency: 'AUD', assetLinkField: 'smsf_holding_id', assetOptions: [{ id: 'p1', name: 'Unit 1' }] })));
    expect(t).toContain('Income');
    expect(t).toContain('+ Add income');
    expect(t).toContain('never appears in your personal Income');
  });
});

describe('F23: SMSF expenses and the SMSF bank statement entry', () => {
  it('the expense panel is entity scoped and tells the user a loan repayment is not an expense', () => {
    const t = text(renderToStaticMarkup(h(EntityFlowPanel, { flow: 'expenses', apiBase: '/api/smsf/f1', currency: 'AUD' })));
    expect(t).toContain('+ Add expense');
    expect(t).toContain('A loan repayment is not entered here');
  });
  it('the SMSF card section has income, expenses and a Premium bank statement entry that reuses the one upload panel with the owner fixed to the fund', () => {
    const t = text(renderToStaticMarkup(h(SmsfCashFlowSection, { fund: FUND })));
    expect(t).toContain('Bank statements of the fund');
    expect(t).toContain('Upload a bank statement');
    expect(t).toContain('Premium');
    expect(t).toContain('never in your household spending');
    const src = read('components/retirement/smsf/SmsfCashFlowSection.tsx');
    expect(src).toContain("fixedOwner={{ kind: 'smsf' }}");
    expect(src).toContain("from '@/components/expenses/BankStatementImportPanel'");
  });
  it('the shared upload panel keeps its owner-before-upload contract: a fixed owner still sends the owner query, the panel never builds its own upload route', () => {
    const src = read('components/expenses/BankStatementImportPanel.tsx');
    expect(src).toContain('useState<OwnerSelection | null>(fixedOwner ?? null)');
    expect(src).toContain('bankUploadParams({');
    expect(src).toContain('importAccess?.state');
  });
  it('the SMSF page reads its own actuals and keeps them beside, never added to, the recurring figures', () => {
    const src = read('components/retirement/smsf/SmsfReportsPanel.tsx');
    expect(src).toContain('From the fund&apos;s bank statements');
    expect(src).toContain('not added to them');
  });
});

describe('F23b: the Company, Family Trust and HUF workspace', () => {
  it('a NEW entity is recorded itemised by default, a net value is only required when the user chooses net value only', () => {
    expect(businessEntityCreateInputSchema.parse({ name: 'Smith Trust', entity_type: 'family_trust' })).toMatchObject({ valuation_mode: 'detailed' });
    expect(businessEntityCreateInputSchema.safeParse({ name: 'Co', valuation_mode: 'summary' }).success).toBe(false);
    expect(businessEntityCreateInputSchema.safeParse({ name: 'Co', valuation_mode: 'summary', summary_net_asset_value: 250_000 }).success).toBe(true);
  });
  it('the chooser offers exactly the two ways with the plain note that a net value only hides the structure', () => {
    const html = renderToStaticMarkup(h(EntityModeChooser, { entityId: 'e1', mode: 'detailed', currency: 'AUD', onChanged: () => undefined }));
    const t = text(html);
    expect(t).toContain('How do you want to record this entity?');
    expect(t).toContain('Itemised assets and liabilities (recommended)');
    expect(t).toContain('Net value only');
    expect(t).toContain(ENTITY_NET_ONLY_NOTE);
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(html).not.toContain('Check the effect');
  });
  it('the page hands every entity to the entity card, asks the share only for a Company, and keeps HUF India only', () => {
    const src = read('app/(app)/companies/page.tsx');
    expect(src).toContain('<EntityCard');
    expect(src).toContain("newEntityType === 'company' &&");
    expect(src).toContain("canCreateHuf && <option value=\"huf\">");
    expect(src).toContain("useState<'summary' | 'detailed'>('detailed')");
  });
  it('the card carries assets and liabilities, income, expenses, the monthly picture and the history', () => {
    const src = read('components/entities/EntityCard.tsx');
    for (const part of ['<EntityLinesPanel', "flow=\"income\"", "flow=\"expenses\"", '<EntityCashFlowSummary', '<EntityModeChooser', 'entity-history']) expect(src).toContain(part);
  });
});

const { userMock } = vi.hoisted(() => ({ userMock: vi.fn(() => ({ user: { id: 'user-a' }, unauthenticated: null })) }));
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, requireCountryConfirmedUser: () => userMock() };
});

async function world(tables: Record<string, Row[]>, rpc?: (name: string, args: Record<string, unknown>) => { data: unknown; error: { message: string; code?: string } | null }) {
  vi.resetModules();
  const db = createInMemoryDb();
  db.reset(tables);
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  const client = {
    from: (t: string) => (db.client as { from: (x: string) => unknown }).from(t),
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return rpc ? rpc(name, args) : { data: null, error: null };
    },
  };
  vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => client }));
  return { db, rpcCalls };
}
const post = (body: unknown) => new Request('http://x', { method: 'POST', body: JSON.stringify(body) });
const patchReq = (body: unknown) => new Request('http://x', { method: 'PATCH', body: JSON.stringify(body) });
const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });

describe('business entity routes: the rule lives in the database, the API only translates', () => {
  it('a bare PATCH can no longer flip the way an entity is recorded: the field is not part of the update', async () => {
    const { db } = await world({ business_entities: [{ id: 'e1', user_id: 'user-a', entity_type: 'company', valuation_mode: 'detailed', summary_net_asset_value: null, is_active: true }] });
    const { PATCH } = await import('@/app/api/business-entities/[id]/route');
    await PATCH(patchReq({ valuation_mode: 'summary', summary_net_asset_value: 5 }), idCtx('e1'));
    expect(db.tables.business_entities![0]!.valuation_mode).toBe('detailed');
  });

  it('switch-mode: preview first (confirm false is the default), the RPC is told so, and the preview is returned untouched', async () => {
    const preview = { status: 'preview', net_before: 250_000, net_after: 600_000, variance: 350_000 };
    const { rpcCalls } = await world({}, () => ({ data: preview, error: null }));
    const { POST } = await import('@/app/api/business-entities/[id]/switch-mode/route');
    const res = await POST(post({ to_mode: 'detailed', assets: [{ label: 'Rental property', value: 1_000_000, currency_code: 'AUD' }], liabilities: [{ label: 'Loan', value: 400_000, currency_code: 'AUD' }] }), idCtx('e1'));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual(preview);
    expect(rpcCalls[0]).toMatchObject({ name: 'business_entity_switch_mode', args: { p_entity_id: 'e1', p_to_mode: 'detailed', p_confirm: false, p_net: null } });
  });

  it('switch-mode: the database refusal comes back as a coded 409 in plain words, never raw SQL', async () => {
    await world({}, () => ({ data: null, error: { message: 'ENTITY_BOTH_REPRESENTATIONS: an itemised entity derives its net out of its assets and liabilities, so it cannot also carry a typed net value', code: '23514' } }));
    const { POST } = await import('@/app/api/business-entities/[id]/switch-mode/route');
    const res = await POST(post({ to_mode: 'summary', net: 5, confirm: true }), idCtx('e1'));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('ENTITY_BOTH_REPRESENTATIONS');
    expect(body.message).not.toMatch(/ENTITY_|SQL|constraint/);
  });

  it('switch-mode: itemised needs at least one line, net value only needs a net', async () => {
    await world({});
    const { POST } = await import('@/app/api/business-entities/[id]/switch-mode/route');
    expect((await POST(post({ to_mode: 'detailed', assets: [], liabilities: [] }), idCtx('e1'))).status).toBe(422);
    expect((await POST(post({ to_mode: 'summary' }), idCtx('e1'))).status).toBe(422);
  });

  it('adding a line to another household\'s entity answers 404 and writes nothing; removing a line retires it (kept, not deleted)', async () => {
    const { db } = await world({
      business_entities: [{ id: 'e1', user_id: 'user-a', entity_type: 'company', is_active: true }, { id: 'e2', user_id: 'user-b', entity_type: 'company', is_active: true }],
      business_entity_assets: [{ id: 'a1', user_id: 'user-a', business_entity_id: 'e1', label: 'Plant', value: 10, currency_code: 'AUD', is_active: true }],
    });
    const assets = await import('@/app/api/business-entities/[id]/assets/route');
    const item = await import('@/app/api/business-entities/[id]/assets/[assetId]/route');
    expect((await assets.POST(post({ label: 'X', value: 1, currency_code: 'AUD' }), idCtx('e2'))).status).toBe(404);
    expect(db.writes).toHaveLength(0);
    const res = await item.DELETE(new Request('http://x', { method: 'DELETE' }), { params: Promise.resolve({ assetId: 'a1' }) });
    expect(res.status).toBe(200);
    expect(db.tables.business_entity_assets).toHaveLength(1);
    expect(db.tables.business_entity_assets![0]!.is_active).toBe(false);
  });

  it('the entity GET carries the database-derived net while itemised and never invents one when it cannot be read', async () => {
    await world({ business_entities: [{ id: 'e1', user_id: 'user-a', entity_type: 'family_trust', valuation_mode: 'detailed', is_active: true }] }, (name) => (name === 'business_entity_derived_net' ? { data: 600_000, error: null } : { data: null, error: null }));
    const one = await import('@/app/api/business-entities/[id]/route');
    expect((await (await one.GET(new Request('http://x'), idCtx('e1'))).json()).data.derived_net).toBe(600_000);
    await world({ business_entities: [{ id: 'e1', user_id: 'user-a', entity_type: 'family_trust', valuation_mode: 'detailed', is_active: true }] }, () => ({ data: null, error: { message: 'boom' } }));
    const again = await import('@/app/api/business-entities/[id]/route');
    expect((await (await again.GET(new Request('http://x'), idCtx('e1'))).json()).data.derived_net).toBeNull();
  });
});
