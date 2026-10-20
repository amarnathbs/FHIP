// SMSF entity-level UI, validation and API contracts (PO decision 17-10-2026): itemised assets and liabilities OR a net value only, never both.
// EVIDENCE LABEL: UNIT-TESTED by rendering to static HTML and by source contracts (no DOM environment in this repository, and no signed-in
// browser session was used: layout at 375 / 768 / 1280 px and keyboard behaviour are NOT verified in a real browser).
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SmsfNetPosition } from '@/components/retirement/smsf/SmsfNetPosition';
import { NET_ONLY_NOTE, SmsfModeSwitch } from '@/components/retirement/smsf/SmsfModeSwitch';
import { smsfRpcError } from '@/lib/services/smsfErrors';
import { smsfFundCreateSchema, smsfLiabilitySchema, smsfSwitchModeSchema, smsfAdoptRowsSchema } from '@/lib/validation/smsf';
import type { SmsfFundRow } from '@/components/retirement/smsf/types';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const FUND = {
  id: 'f1', user_id: 'u', retirement_account_id: 'r', fund_name: 'PO SMSF', mode: 'detailed', summary_balance: null, summary_balance_date: null,
  detailed_net_value: 133_000, activated_detailed_at: null, currency_code: 'AUD', notes: null, is_active: true, created_at: '', updated_at: '',
  retirement_accounts: { id: 'r', account_name: 'SMSF', current_balance: 133_000, currency_code: 'AUD', is_active: true },
} as SmsfFundRow;

describe('net position: derived, read-only', () => {
  it('PO oracle: assets 503,000 less liabilities 370,000 shows 133,000 and offers NO input', () => {
    const html = renderToStaticMarkup(h(SmsfNetPosition, { assets: 503_000, liabilities: 370_000, currency: 'AUD' }));
    expect(text(html)).toContain('$503,000');
    expect(text(html)).toContain('$370,000');
    expect(text(html)).toContain('$133,000');
    expect(text(html)).toContain('You do not type the net');
    expect(html).not.toContain('<input');
    expect(html).toContain('aria-live="polite"');
  });
  it('a fund that owes more than it owns shows a negative net in words, not only colour', () => {
    const html = text(renderToStaticMarkup(h(SmsfNetPosition, { assets: 100_000, liabilities: 150_000, currency: 'AUD' })));
    expect(html).toContain('50,000');
    expect(html).toContain('the fund owes more than it owns');
  });
});

describe('the recording-mode chooser', () => {
  const html = renderToStaticMarkup(h(SmsfModeSwitch, { fund: FUND, refreshKey: 0, onChanged: () => undefined }));
  it('offers exactly the two ways, itemised marked recommended, with the plain note that net-only hides the structure', () => {
    const t = text(html);
    expect(t).toContain('How do you want to record this fund?');
    expect(t).toContain('Itemised assets and liabilities (recommended)');
    expect(t).toContain('Net value only');
    expect(t).toContain(NET_ONLY_NOTE);
    expect(t).toContain('Only one of these is ever counted');
    expect(html.match(/type="radio"/g)).toHaveLength(2);
  });
  it('is a labelled fieldset with the current way selected, and shows no switch form until the user picks the other way', () => {
    expect(html).toContain('<fieldset');
    expect(html).toContain('<legend');
    expect(html).toMatch(/checked=""[^>]*/);
    expect(html).not.toContain('Check the effect');
    expect(html).not.toContain('Net value (assets minus debts)');
  });
  it('renders the net-only chooser state of a net-only fund the same way (two radios, no lines)', () => {
    const netOnly = { ...FUND, mode: 'summary' as const, summary_balance: 133_000 };
    const out = renderToStaticMarkup(h(SmsfModeSwitch, { fund: netOnly, refreshKey: 0, onChanged: () => undefined }));
    expect(out.match(/type="radio"/g)).toHaveLength(2);
  });
});

describe('either-or on the screen (source contracts)', () => {
  const card = read('components/retirement/smsf/SmsfFundCard.tsx');
  const workspace = read('components/retirement/smsf/SmsfDetailedWorkspace.tsx');
  it('the typed net input exists ONLY inside the net-value-only block of the fund card', () => {
    const idx = card.indexOf('fund-balance-');
    const summaryBlock = card.indexOf("fund.mode === 'summary' && (");
    const detailedBlock = card.indexOf("fund.mode === 'detailed' && (");
    expect(idx).toBeGreaterThan(summaryBlock);
    expect(summaryBlock).toBeGreaterThan(-1);
    expect(detailedBlock).toBeGreaterThan(idx);
  });
  it('the itemised workspace has no net-value input and links no personal liability any more', () => {
    expect(workspace).not.toContain('fund-balance');
    expect(workspace).not.toContain('Link existing liability');
    expect(workspace).not.toContain('switch-to-detailed');
    expect(workspace).not.toContain('switch-to-summary');
    expect(workspace).toContain('Move into the fund');
  });
  it('the earlier staged switch routes are gone', () => {
    expect(fs.existsSync(path.join(ROOT, 'app/api/smsf/[id]/switch-to-detailed/route.ts'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'app/api/smsf/[id]/switch-to-summary/route.ts'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'app/api/smsf/[id]/switch-mode/route.ts'))).toBe(true);
  });
  it('API: linking a personal liability to an itemised fund is refused; holdings, liabilities and the fund patch translate the rule to 409', () => {
    expect(read('app/api/smsf/[id]/property-loan/route.ts')).toContain("fund?.mode === 'detailed'");
    for (const f of ['app/api/smsf/[id]/holdings/route.ts', 'app/api/smsf/[id]/liabilities/route.ts', 'app/api/smsf/[id]/route.ts']) {
      expect(read(f)).toContain('smsfRpcError');
    }
  });
  it('accessibility basics: every liability and switch input has an associated label', () => {
    for (const f of ['components/retirement/smsf/SmsfLiabilityForm.tsx', 'components/retirement/smsf/SmsfModeSwitch.tsx']) {
      const src = read(f);
      const inputs = (src.match(/<(input|select)\b/g) ?? []).length;
      const labels = (src.match(/htmlFor=/g) ?? []).length + (src.match(/<label className="flex items-start/g) ?? []).length;
      expect(labels).toBeGreaterThanOrEqual(inputs - 4 /* radios are wrapped by their label */);
    }
  });
});

describe('API error translation', () => {
  it('maps the rule and the usual database codes to plain statuses and wording', () => {
    expect(smsfRpcError({ message: 'ENTITY_BOTH_REPRESENTATIONS: an itemised fund cannot also carry a typed net value', code: '23514' })).toEqual({
      status: 409, errorCode: 'ENTITY_BOTH_REPRESENTATIONS', message: 'an itemised fund cannot also carry a typed net value',
    });
    expect(smsfRpcError({ message: 'ENTITY_MODE_SWITCH_ONLY: x', code: '42501' }).status).toBe(409);
    expect(smsfRpcError({ message: 'smsf: fund x not found or not visible to the current user', code: 'P0002' })).toMatchObject({ status: 404, message: 'fund x not found or not visible to the current user' });
    expect(smsfRpcError({ message: 'smsf: not authenticated', code: '42501' }).status).toBe(403);
    expect(smsfRpcError({ message: 'smsf: already recorded that way', code: '55000' }).status).toBe(409);
    expect(smsfRpcError({ message: 'smsf: enter at least one asset', code: '22023' }).status).toBe(422);
    expect(smsfRpcError({ message: 'boom' }).status).toBe(400);
  });
});

describe('validation: either-or at the API edge', () => {
  const base = { account_name: 'SMSF', fund_name: 'PO SMSF' };
  it('create: no typed value means itemised (the default), a typed value means net-only, both is rejected', () => {
    const d = smsfFundCreateSchema.parse(base);
    expect(d.mode).toBe('detailed');
    const s = smsfFundCreateSchema.parse({ ...base, summary_balance: 133_000 });
    expect(s.mode).toBe('summary');
    expect(smsfFundCreateSchema.safeParse({ ...base, mode: 'detailed', summary_balance: 133_000 }).success).toBe(false);
    expect(smsfFundCreateSchema.safeParse({ ...base, mode: 'summary' }).success).toBe(false);
  });
  it('switch to itemised needs at least one asset or liability; switch to net-only needs a non-negative net; confirm defaults to false (preview)', () => {
    expect(smsfSwitchModeSchema.safeParse({ to_mode: 'detailed' }).success).toBe(false);
    const ok = smsfSwitchModeSchema.parse({
      to_mode: 'detailed',
      assets: [{ holding_class: 'property', holding_type: 'residential_property', holding_name: '250 Elizebth st', value: 503_000, currency_code: 'AUD' }],
      liabilities: [{ liability_name: 'SMSF property loan', balance: 370_000, currency_code: 'AUD' }],
    });
    expect(ok.confirm).toBe(false);
    expect(smsfSwitchModeSchema.safeParse({ to_mode: 'summary' }).success).toBe(false);
    expect(smsfSwitchModeSchema.safeParse({ to_mode: 'summary', net: -1 }).success).toBe(false);
    expect(smsfSwitchModeSchema.parse({ to_mode: 'summary', net: 133_000 }).confirm).toBe(false);
    expect(smsfSwitchModeSchema.safeParse({ to_mode: 'detailed', assets: [{ holding_class: 'cash', holding_type: 'au_shares', holding_name: 'x', value: 1, currency_code: 'AUD' }] }).success).toBe(false);
  });
  it('a liability is non-negative, named, has a currency, and defaults its type', () => {
    expect(smsfLiabilitySchema.parse({ liability_name: 'Loan', balance: 370_000, currency_code: 'AUD' }).liability_type).toBe('other');
    expect(smsfLiabilitySchema.safeParse({ liability_name: ' ', balance: 1, currency_code: 'AUD' }).success).toBe(false);
    expect(smsfLiabilitySchema.safeParse({ liability_name: 'x', balance: -1, currency_code: 'AUD' }).success).toBe(false);
    expect(smsfLiabilitySchema.safeParse({ liability_name: 'x', balance: 1, currency_code: 'GBP' }).success).toBe(false);
  });
  it('adopting register rows needs at least one uuid', () => {
    expect(smsfAdoptRowsSchema.safeParse({ retirement_row_ids: [] }).success).toBe(false);
    expect(smsfAdoptRowsSchema.safeParse({ retirement_row_ids: ['not-a-uuid'] }).success).toBe(false);
  });
});
