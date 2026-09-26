/**
 * selectInvestments -- one portfolio total + the "Imported, not yet in Net
 * Worth" bucket (DC-08 / INV-G1, PO D-05); selectRetirement and selectAssets
 * register semantics (GAP-RET-02, DC-16 / D-04).
 */
import { describe, expect, it } from 'vitest';

import { selectAssets } from '@/lib/read-models/assets';
import { selectInvestments } from '@/lib/read-models/investments';
import { selectRetirement } from '@/lib/read-models/retirement';
import { makeFakeSupabase, type Row } from './helpers/fakeSupabase';
import { account, profile, statement, tables, USER } from './helpers/fixtures';

const inv = (id: string, value: number, extra: Row = {}): Row => ({
  id, user_id: USER, investment_name: id, investment_type: 'shares', current_value: value, currency_code: 'AUD', owner: 'self',
  master_item_key: null, source_type: 'manual', ii_canonical_account_id: null, ii_canonical_instrument_id: null, is_active: true, ...extra,
});
const snap = (id: string, acc: string, inst: string, date: string, value: number, extra: Row = {}): Row => ({
  id, user_id: USER, account_id: acc, instrument_id: inst, as_of_date: date, units: 10, value, currency_code: 'AUD', created_at: `${date}T00:00:00Z`, ...extra,
});

describe('selectInvestments', () => {
  it('published total counts investments rows only; an Applied-but-unpublished AU holding is a separate, labelled bucket', async () => {
    const { client } = makeFakeSupabase(tables(profile(), {
      investments: [inv('manual', 5000), inv('ii-pub', 8000, { source_type: 'investment_intelligence_published', ii_canonical_account_id: 'acc1', ii_canonical_instrument_id: 'cba' })],
      ii_holding_snapshots: [
        snap('s1', 'acc1', 'cba', '2026-07-31', 7900),
        snap('s2', 'acc1', 'cba', '2026-08-31', 8000),
        snap('s3', 'acc2', 'bhp', '2026-07-31', 900),
        snap('s4', 'acc2', 'bhp', '2026-08-31', 1000), // latest, unpublished
        snap('s5', 'acc2', 'wes', '2026-08-31', 0, { units: 0 }), // sold out
      ],
      ii_fhip_publications: [],
    }));
    const res = await selectInvestments(USER, { client });
    if (res.status !== 'ok') throw new Error('unavailable');
    expect(res.publishedTotal).toBe(13000);
    expect(res.unpublished).toMatchObject({ label: 'Imported, not yet in Net Worth', count: 1, total: 1000 });
    expect(res.unpublished.holdings[0]).toMatchObject({ accountId: 'acc2', instrumentId: 'bhp', snapshotId: 's4' });
    expect(res.lines.find((l) => l.id === 'ii-pub')!.provenance.label).toBe('Imported via Investment Intelligence');
  });

  it('a position covered by a published ii_fhip_publications row (e.g. EPF into retirement) is not in the bucket', async () => {
    const { client } = makeFakeSupabase(tables(profile(), {
      investments: [],
      ii_holding_snapshots: [snap('e1', 'epf', 'epf-inst', '2026-08-31', 50000)],
      ii_fhip_publications: [{ user_id: USER, canonical_position_id: 'e1', status: 'published' }],
    }));
    const res = await selectInvestments(USER, { client });
    expect(res.status === 'ok' && res.unpublished.count).toBe(0);
  });

  it("fails closed: an ii_holding_snapshots error is 'unavailable', not an empty bucket", async () => {
    const { client } = makeFakeSupabase(tables(profile(), { investments: [inv('m', 1)] }), { failOn: new Set(['ii_holding_snapshots']) });
    expect((await selectInvestments(USER, { client })).status).toBe('unavailable');
  });
});

const ret = (id: string, extra: Row = {}): Row => ({
  id, user_id: USER, account_name: id, account_type: 'super', current_balance: 100000, currency_code: 'AUD', owner: 'self',
  employer_contribution: null, personal_contribution: null, contribution_frequency: null, source_type: 'manual', retirement_member_id: null, is_active: true, ...extra,
});

describe('selectRetirement', () => {
  it('a null contribution_frequency is UNKNOWN, never monthly (a 6,000 period total is not 6,000/month)', async () => {
    const { client } = makeFakeSupabase(tables(profile(), { retirement_accounts: [
      ret('stmt', { employer_contribution: 6000, contribution_frequency: null, source_type: 'retirement_statement_import' }),
      ret('annual', { employer_contribution: 12000, contribution_frequency: 'annually' }),
    ] }));
    const res = await selectRetirement(USER, { client });
    if (res.status !== 'ok') throw new Error('unavailable');
    expect(res.householdEmployerContributionMonthly).toBe(1000);
    expect(res.unknownFrequencyCount).toBe(1);
    expect(res.lines.find((l) => l.id === 'stmt')!.employerContribution).toEqual({ amountNative: 6000, frequency: null, monthlyReporting: null, frequencyKnown: false });
    expect(res.lines.find((l) => l.id === 'stmt')!.provenance.label).toBe('Imported from retirement statement');
    expect(res.totalBalance).toBe(200000);
  });

  it('INR balances convert; SMSF-owned balance stays in Net Worth but out of household contributions', async () => {
    const { client } = makeFakeSupabase(tables(profile(), { retirement_accounts: [
      ret('epf', { currency_code: 'INR', current_balance: 560000 }),
      ret('smsf', { owner: 'smsf', current_balance: 50000, personal_contribution: 1000, contribution_frequency: 'monthly' }),
    ] }));
    const res = await selectRetirement(USER, { client });
    if (res.status !== 'ok') throw new Error('unavailable');
    expect(res.totalBalance).toBe(60000);
    expect(res.householdBalance).toBe(10000);
    expect(res.householdPersonalContributionMonthly).toBe(0);
  });
});

describe('selectAssets', () => {
  it('bank closing balances are EVIDENCE ("not in Net Worth"), never added to the asset total (D-04)', async () => {
    const { client } = makeFakeSupabase(tables(profile(), {
      assets: [{ id: 'house', user_id: USER, asset_name: 'Home', asset_class: 'property', current_value: 900000, currency_code: 'AUD', owner: 'joint', master_item_key: 'primary_residence', source_type: 'manual', linked_liability_id: null, is_active: true }],
      fdh_financial_accounts: [account('bank'), account('card', 'credit_card')],
      fdh_statement_uploads: [statement('s-jul', 'bank', '2026-07-01', '2026-07-31'), statement('s-aug', 'bank', '2026-08-01', '2026-08-31'), statement('s-card', 'card', '2026-08-01', '2026-08-31')],
      fdh_reconciliation_results: [
        { user_id: USER, statement_upload_id: 's-jul', reported_closing_balance: 4000, currency_code: 'AUD', created_at: '2026-08-01T00:00:00Z' },
        { user_id: USER, statement_upload_id: 's-aug', reported_closing_balance: 5200, currency_code: 'AUD', created_at: '2026-09-01T00:00:00Z' },
        { user_id: USER, statement_upload_id: 's-card', reported_closing_balance: 1500, currency_code: 'AUD', created_at: '2026-09-01T00:00:00Z' },
      ],
    }));
    const res = await selectAssets(USER, { client });
    if (res.status !== 'ok') throw new Error('unavailable');
    expect(res.total).toBe(900000);
    expect(res.bankBalanceEvidence.accounts).toHaveLength(1);
    expect(res.bankBalanceEvidence.accounts[0]).toMatchObject({ accountId: 'bank', statementUploadId: 's-aug', asOf: '2026-08-31', label: 'Bank balance per statement — not in Net Worth' });
    expect(res.bankBalanceEvidence.total).toBe(5200);
  });

  it('a USD asset is surfaced unconverted, never added raw', async () => {
    const { client } = makeFakeSupabase(tables(profile(), {
      assets: [{ id: 'u', user_id: USER, asset_name: 'US account', asset_class: 'cash', current_value: 1000, currency_code: 'USD', owner: 'self', master_item_key: null, source_type: 'manual', linked_liability_id: null, is_active: true }],
    }));
    const res = await selectAssets(USER, { client });
    expect(res.status === 'ok' && res.total).toBe(0);
    expect(res.status === 'ok' && res.unconverted).toEqual({ count: 1, byCurrency: { USD: 1000 } });
  });
});
