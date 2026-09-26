/**
 * WP-12 -- the AU broker-statement journey for a FIRST-TIME Australian user,
 * through the real API routes, the real FDH-11 bridge and Investment
 * Intelligence's own publication service, over one in-memory database:
 *
 *   upload evidence -> review -> "Add as new account" (holder: me) ->
 *   "Create security" -> approve -> Apply -> certify -> "Add to Net Worth"
 *   (D-05) -> the Investments tab / Net Worth read model.
 *
 * A first-time user has no ii_accounts row, no household member and no ASX
 * identifiers on file: before WP-12 every line stayed "unresolved", Approve
 * stayed disabled, positions were never applied (apply_status default) and
 * nothing ever reached `investments` (INV-G1/G2/G3/G10).
 *
 * Plus bank-leg re-typing and the post-bank-approval re-match (INV-G4), and
 * UPL-02's fail-closed scanner. The bridge-level Apply claims (FOREIGN_ACCOUNT,
 * broker cash, fees/taxes, duplicates, 1,001 rows) are in the base-compatible
 * fdh11BridgeApplyIntegrity.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FakeDb, Row } from './helpers/fdh11FakeDb';
import { DOC, USER, world } from './helpers/fdh11World';

const h = vi.hoisted(() => ({ db: null as unknown as { client: unknown }, scanOn: false }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.db.client }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.db.client }));
vi.mock('@/lib/financial-data-hub/services/auditLog', () => ({ recordDocumentAuditEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/api', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/api')>();
  return { ...orig, requireCountryConfirmedUser: vi.fn().mockResolvedValue({ user: { id: 'user-au-1', email: 'au@fhip-test.invalid' } }) };
});
vi.mock('@/lib/services/jurisdiction', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getUserFullExperienceHomeCountry: vi.fn().mockResolvedValue('AU'),
}));
vi.mock('@/lib/aie/malware/config', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isRealMalwareScanEnabled: () => h.scanOn,
}));

import { extractAuPositionsFromCsv, extractAuTransactionsFromCsv } from '@/lib/financial-data-hub/investment/csvExtraction';
import { persistAuInvestmentEvidence, reclassifyCorroboratedAuBankLegs } from '@/lib/financial-data-hub/services/investmentStatementProcessingService';
import { POSITION_NO_MARKET_VALUE_REASON } from '@/lib/investment-import-bridge/applyAuStatementPosition';
import { runBrokerBankRematch } from '@/lib/investment-import-bridge/brokerBankRematch';
import { listImportedAuStatements } from '@/lib/investment-import-bridge/publishAuPositions';
import { selectInvestments } from '@/lib/read-models/investments';
import { ensureIiRealScanAdmissible, startIiRealScan } from '@/lib/services/investment-intelligence/realScanAdmission';
import { POST as accountMatch } from '@/app/api/financial-data-hub/investment-statement/[documentId]/account-match/route';
import { POST as securityMatch } from '@/app/api/financial-data-hub/investment-statement/[documentId]/security-match/route';
import { POST as approveRoute } from '@/app/api/financial-data-hub/investment-statement/[documentId]/approve/route';
import { POST as applyRoute } from '@/app/api/financial-data-hub/investment-statement/[documentId]/apply/route';
import { POST as publishRoute } from '@/app/api/financial-data-hub/investment-statement/[documentId]/publish/route';
import { GET as reviewRoute } from '@/app/api/financial-data-hub/investment-statement/[documentId]/route';

const csv = (s: string) => new TextEncoder().encode(s);
const params = { params: Promise.resolve({ documentId: DOC }) };
const post = (body?: unknown) => new Request('http://x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (r: Response): Promise<any> => ({ status: r.status, ...(await r.json()) });

const PORTFOLIO_CSV = [
  'Security Name,Code,Quantity,Price,Market Value,Valuation Date',
  'BHP Group Ltd,BHP,200,$49.90,"$9,980.00",31/08/2026',
  'Vanguard Australian Shares,VAS,50,$100.00,,31/08/2026',
  'Cash,,,,"1,020.00",31/08/2026',
].join('\n');

async function persistPortfolio(db: FakeDb) {
  const ex = extractAuPositionsFromCsv({ bytes: csv(PORTFOLIO_CSV), columnMap: { securityName: 'Security Name', ticker: 'Code', quantity: 'Quantity', unitPrice: 'Price', marketValue: 'Market Value', valuationDate: 'Valuation Date' }, currencyCode: 'AUD', institutionName: 'CommSec', maskedAccountIdentifier: '****4321', defaultValuationDate: '2026-09-01' });
  if (!ex.ok) throw new Error(ex.error);
  const out = await persistAuInvestmentEvidence({ userId: USER, documentId: DOC, statementType: 'portfolio_csv', extraction: ex.extraction });
  void db;
  return out.statementId;
}

let db: FakeDb;
beforeEach(() => {
  db = world();
  h.db = db;
  h.scanOn = false;
});

describe('first-time AU user: approve -> apply -> Add to Net Worth (INV-G1/G2/G3/G10, PO D-05)', () => {
  it('completes end to end, and Net Worth moves only after the explicit confirm', async () => {
    const statementId = await persistPortfolio(db);

    // Review payload: positions start 'pending' (INV-G2) and the cash line is the statement's cash balance, not a holding (D-11).
    const review = await json(await reviewRoute(new Request('http://x'), params));
    expect(review.data.positions.map((p: Row) => [p.security_name_raw, p.apply_status])).toEqual([['BHP Group Ltd', 'pending'], ['Vanguard Australian Shares', 'pending']]);
    expect(review.data.statement.cash_balance).toBe(1020);

    // No account yet: resolve says no_match (the panel then offers "Add as new account").
    const resolved = await json(await accountMatch(post({ action: 'resolve', account_type: 'broker', currency_code: 'AUD' }), params));
    expect(resolved.data.outcome).toBe('no_match');

    // "Add as new account" REQUIRES the holder (INV-G10) ...
    const noOwner = await json(await accountMatch(post({ action: 'confirm_new', institution_name: 'CommSec', masked_account_identifier: '****4321', currency_code: 'AUD' }), params));
    expect(noOwner.status).toBe(422);
    expect(noOwner.error).toBe('OWNER_REQUIRED');
    expect(noOwner.message).toMatch(/who holds/);
    // ... and "me" works for a user with no household members yet: the self member is created from the profile.
    const created = await json(await accountMatch(post({ action: 'confirm_new', institution_name: 'CommSec', masked_account_identifier: '****4321', currency_code: 'AUD', owner_self: true }), params));
    expect(created.status).toBe(200);
    expect(created.data.owner_recorded).toBe(true);
    const member = db.rows('household_members').find((m) => m.user_id === USER)!;
    expect(member).toMatchObject({ relationship: 'self', full_name: 'Alex Citizen' });
    const account = db.rows('ii_accounts').find((a) => a.id === created.data.account_id)!;
    expect(account).toMatchObject({ user_id: USER, owner_member_id: member.id, country_code: 'AU', account_type: 'broker' });
    expect(db.rows('fdh_investment_statements')[0].canonical_account_id).toBe(account.id);

    // No ASX identifiers on file: security-match is 'unresolved' (the old dead end) ...
    const [bhp, vas] = db.rows('fdh_investment_statement_positions');
    const unresolved = await json(await securityMatch(post({ table: 'fdh_investment_statement_positions', row_id: bhp.id }), { params: Promise.resolve({ documentId: DOC }) }));
    expect(unresolved.data.outcome).toBe('unresolved');
    // ... and "Create security" resolves it (II's own provisional-instrument path).
    for (const [row, cls] of [[bhp, 'equity'], [vas, 'etf']] as const) {
      const r = await json(await securityMatch(post({ table: 'fdh_investment_statement_positions', row_id: row.id, confirm_new_security: true, instrument_class: cls }), params));
      expect(r.data.outcome).toBe('matched');
    }
    expect(db.rows('ii_instrument_identifiers').map((i) => [i.identifier_scheme, i.identifier_value])).toEqual([['asx_ticker', 'BHP'], ['asx_ticker', 'VAS']]);

    // Approve, then Apply.
    expect((await approveRoute(post(), params)).status).toBe(200);
    const applied = await json(await applyRoute(post(), params));
    expect(applied.data.applied_count).toBe(1);
    const bhpResult = applied.data.positions.find((p: Row) => p.security_name === 'BHP Group Ltd');
    const vasResult = applied.data.positions.find((p: Row) => p.security_name === 'Vanguard Australian Shares');
    expect(bhpResult.ok).toBe(true);
    // A holding with no printed value is SKIPPED with a reason -- never a $0 holding (INV-G7/INV-G9).
    expect(vasResult).toMatchObject({ ok: false, reason: POSITION_NO_MARKET_VALUE_REASON });
    expect(db.rows('fdh_investment_statement_positions').find((p) => p.id === vas.id)).toMatchObject({ apply_status: 'skipped', apply_rejected_reason: POSITION_NO_MARKET_VALUE_REASON });
    const snaps = db.rows('ii_holding_snapshots');
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({ user_id: USER, account_id: account.id, units: 200, value: 9980, as_of_date: '2026-08-31', source_nav: 49.9, price_source: 'statement_price' });

    // Certified with the AU-safe certification (no FK-violating source document id).
    const truth = db.rows('ii_portfolio_truth_status');
    expect(truth).toHaveLength(1);
    expect(truth[0]).toMatchObject({ user_id: USER, account_id: account.id, latest_source_document_id: null, history_completeness: 'holdings_only' });
    expect(['certified', 'certified_with_warnings']).toContain(truth[0].status);
    expect(applied.data.certification[0].status).toBe(truth[0].status);

    // BEFORE "Add to Net Worth": Net Worth unchanged, the holding is in the visible bucket (D-05).
    const before = await selectInvestments(USER, { client: db.client as never });
    if (before.status !== 'ok') throw new Error('unavailable');
    expect(before.publishedTotal).toBe(0);
    expect(before.unpublished).toMatchObject({ label: 'Imported, not yet in Net Worth', count: 1, total: 9980 });

    // The confirm step: preview, then publish exactly what the user confirmed.
    const preview = await json(await publishRoute(post({ action: 'preview' }), params));
    expect(preview.data.holdings).toHaveLength(1);
    expect(preview.data.holdings[0]).toMatchObject({ name: 'BHP Group Ltd', value: 9980, published: false });
    expect(preview.data.holdings[0].eligibility_status).not.toBe('NOT_ELIGIBLE');
    const snapshotId = preview.data.holdings[0].snapshot_id;
    const published = await json(await publishRoute(post({ action: 'publish', decisions: [{ snapshot_id: snapshotId }] }), params));
    expect(published.data.published_count).toBe(1);

    const inv = db.rows('investments');
    expect(inv).toHaveLength(1);
    expect(inv[0]).toMatchObject({ user_id: USER, source_type: 'investment_intelligence_published', owner: 'self', current_value: 9980, currency_code: 'AUD', ii_canonical_account_id: account.id, master_item_key: 'australian_shares' });

    // AFTER: Net Worth includes it exactly once; the bucket is empty; the line carries its provenance label.
    const after = await selectInvestments(USER, { client: db.client as never });
    if (after.status !== 'ok') throw new Error('unavailable');
    expect(after.publishedTotal).toBe(9980);
    expect(after.unpublished.count).toBe(0);
    expect(after.lines[0].provenance.kind).toBe('investment_intelligence');

    // Repeat confirm: idempotent -- no second row, no double count.
    await publishRoute(post({ action: 'publish', decisions: [{ snapshot_id: snapshotId }] }), params);
    expect(db.rows('investments')).toHaveLength(1);

    // UI CONTRACT: every key the panel / Investments tab reads is present in
    // the exact case the API sends (a camel/snake mismatch renders blank).
    const keys = (o: object) => Object.keys(o).sort();
    expect(keys(applied.data)).toEqual(expect.arrayContaining(['applied_count', 'skipped_count', 'activities', 'positions', 'bank_legs', 'bank_leg_error', 'certification']));
    expect(keys(applied.data.positions[0])).toEqual(expect.arrayContaining(['id', 'ok', 'code', 'reason', 'security_name']));
    expect(keys(preview.data.holdings[0])).toEqual(expect.arrayContaining(['snapshot_id', 'name', 'as_of_date', 'value', 'currency_code', 'eligibility_status', 'blocking_reasons', 'warning_reasons', 'duplicate_candidates', 'published', 'refreshes_existing', 'error']));
    expect(keys(published.data.results[0])).toEqual(expect.arrayContaining(['snapshot_id', 'ok', 'reason']));
    const again = await json(await accountMatch(post({ action: 'resolve', account_type: 'broker', currency_code: 'AUD' }), params));
    expect(again.data).toMatchObject({ outcome: 'single_match', owner_recorded: true });
    expect(keys(again.data.candidates[0])).toEqual(['accountId', 'institutionName', 'maskedAccountIdentifier', 'ownerRecorded']);
    const { GET: importedRoute } = await import('@/app/api/investments/imported-statements/route');
    const imported = await json(await importedRoute());
    expect(keys(imported.data)).toEqual(['statements', 'unpublished', 'unpublished_unavailable']);
    expect(keys(imported.data.unpublished)).toEqual(['count', 'holdings', 'label', 'reporting_currency', 'total']);
    expect(keys(imported.data.statements[0])).toEqual(expect.arrayContaining(['statementId', 'documentId', 'institutionName', 'statementType', 'importedAt', 'approvalStatus', 'cashBalance', 'warnings', 'counts', 'skipped', 'holdings']));
    expect(keys(imported.data.statements[0].holdings[0])).toEqual(['applyStatus', 'asOfDate', 'currencyCode', 'inNetWorth', 'name', 'value']);

    // Import history (Investments tab): dates, outcome per line, skip reason, broker cash shown only.
    const history = await listImportedAuStatements(USER);
    expect(history[0]).toMatchObject({ statementId, documentId: DOC, approvalStatus: 'approved', cashBalance: 1020 });
    expect(history[0].holdings.map((x) => [x.name, x.applyStatus, x.inNetWorth])).toEqual([['BHP Group Ltd', 'applied', true], ['Vanguard Australian Shares', 'skipped', false]]);
    expect(history[0].skipped).toEqual([{ line: 'Vanguard Australian Shares', reason: POSITION_NO_MARKET_VALUE_REASON }]);
  });

  it('refuses to publish a snapshot that is not on this statement', async () => {
    await persistPortfolio(db);
    const res = await json(await publishRoute(post({ action: 'publish', decisions: [{ snapshot_id: '00000000-0000-4000-8000-000000000000' }] }), params));
    expect(res.data.results[0]).toMatchObject({ ok: false, code: 'NOT_ON_THIS_STATEMENT' });
    expect(db.rows('investments')).toHaveLength(0);
  });

  it('an ambiguous security can only be resolved to one of the server-recomputed candidates', async () => {
    await persistPortfolio(db);
    const [bhp] = db.rows('fdh_investment_statement_positions');
    const r = await json(await securityMatch(post({ table: 'fdh_investment_statement_positions', row_id: bhp.id, confirm_instrument_id: '00000000-0000-4000-8000-00000000abcd' }), params));
    expect(r.status).toBe(422);
    expect(r.error).toBe('NOT_A_CANDIDATE');
  });
});

describe('INV-G4: bank legs the approved statement corroborates are re-typed; a later bank approval re-matches', () => {
  const brokerCsv = ['Date,Type,Code,Security Name,Quantity,Price,Amount', '03/08/2026,CASH_DEPOSIT,,,,,10000.00', '20/08/2026,SELL,CBA,Commonwealth Bank,100,150.00,15000.00', '25/08/2026,DIVIDEND,BHP,BHP Group Ltd,,,400.00'].join('\n');
  const institutions = {
    fdh_financial_institutions: [{ id: 'i-cs', country_code: 'AU', institution_code: 'commsec', institution_name: 'CommSec', institution_type: 'broker' }],
    fdh_institution_aliases: [{ institution_id: 'i-cs', alias_normalized: 'COMMSEC' }],
  };
  const legs = (approval: string): Row[] => [
    { id: 'fund', user_id: USER, transaction_date: '2026-08-03', amount_original: 10000, currency_original: 'AUD', credit_debit: 'debit', economic_transaction_type: 'expense', description_clean: 'COMMSEC DEPOSIT', approval_status: approval, dedup_status: 'unique', user_override: false },
    { id: 'sell', user_id: USER, transaction_date: '2026-08-22', amount_original: 15000, currency_original: 'AUD', credit_debit: 'credit', economic_transaction_type: 'income', description_clean: 'COMMSEC SETTLEMENT', approval_status: approval, dedup_status: 'unique', user_override: false },
    { id: 'div', user_id: USER, transaction_date: '2026-08-25', amount_original: 400, currency_original: 'AUD', credit_debit: 'credit', economic_transaction_type: 'income', description_clean: 'BHP GROUP DIV', approval_status: approval, dedup_status: 'unique', user_override: false },
  ];
  async function persistBroker() {
    const ex = extractAuTransactionsFromCsv({ bytes: csv(brokerCsv), columnMap: { date: 'Date', type: 'Type', amount: 'Amount', ticker: 'Code', securityName: 'Security Name', quantity: 'Quantity', price: 'Price' }, currencyCode: 'AUD', institutionName: 'CommSec' });
    if (!ex.ok) throw new Error(ex.error);
    return (await persistAuInvestmentEvidence({ userId: USER, documentId: DOC, statementType: 'investment_transaction_csv', extraction: ex.extraction })).statementId;
  }

  it('bank approved LATER: the post-bank-approval matcher links the legs and re-types funding/proceeds, never the dividend', async () => {
    db = world({ ...institutions, fdh_transactions: legs('pending') });
    h.db = db;
    const sid = await persistBroker();
    db.rows('fdh_investment_statements')[0].approval_status = 'approved';
    // First run: the bank lines are not approved yet -> nothing is linked.
    const first = await runBrokerBankRematch({ userId: USER, statementUploadId: 'bank-doc', trigger: 'statement_approve' });
    expect(first).toEqual({ linked: 0, reclassified: 0 });
    // The bank statement is approved -> the seam runs the matcher again.
    for (const t of db.rows('fdh_transactions')) t.approval_status = 'approved';
    const second = await runBrokerBankRematch({ userId: USER, statementUploadId: 'bank-doc', trigger: 'statement_approve' });
    expect(second).toEqual({ linked: 3, reclassified: 2 });
    const type = (id: string) => db.rows('fdh_transactions').find((t) => t.id === id)!.economic_transaction_type;
    expect([type('fund'), type('sell'), type('div')]).toEqual(['investment', 'asset_sale', 'income']);
    expect(db.rpcCalls.every((c) => c.args.p_source_kind === 'investment_statement_activity')).toBe(true);
    // Idempotent: a third run links and re-types nothing new.
    expect(await runBrokerBankRematch({ userId: USER, statementUploadId: 'bank-doc', trigger: 'statement_approve' })).toEqual({ linked: 0, reclassified: 0 });
    void sid;
  });

  it('an UNAPPROVED broker statement re-types nothing; a user-settled leg is never overridden', async () => {
    db = world({ ...institutions, fdh_transactions: legs('approved') });
    h.db = db;
    const sid = await persistBroker();
    await runBrokerBankRematch({ userId: USER, statementUploadId: 'x', trigger: 'statement_approve' });
    expect(db.rows('fdh_transactions').find((t) => t.id === 'fund')!.economic_transaction_type).toBe('expense');
    db.rows('fdh_investment_statements')[0].approval_status = 'approved';
    db.rows('fdh_transactions').find((t) => t.id === 'fund')!.user_override = true;
    const out = await reclassifyCorroboratedAuBankLegs(USER, sid);
    expect(out).toMatchObject({ reclassified: 1, skippedUserOverride: 1 });
    expect(db.rows('fdh_transactions').find((t) => t.id === 'fund')!.economic_transaction_type).toBe('expense');
  });
});

describe('UPL-02: the II real scan fails CLOSED when it is on but cannot run', () => {
  it('upload: scan on + no 0196 columns -> scanner_unavailable (was: admitted on the structural check)', async () => {
    h.scanOn = true;
    const r = await startIiRealScan({ userId: USER, sourceDocumentId: 'sd', storagePath: 'p', bytes: new Uint8Array([1]), contentType: 'application/pdf', contentHash: 'h', hasScanColumns: false });
    expect(r).toEqual({ admitted: false, reason: 'scanner_unavailable' });
  });
  it('process: scan on + no 0196 columns -> scanner_unavailable; scan off -> admitted as before', async () => {
    db = world({ ii_source_documents: [{ id: 'sd', user_id: USER, storage_path: 'p', mime_type: 'application/pdf' }] });
    h.db = db;
    h.scanOn = true;
    expect(await ensureIiRealScanAdmissible(USER, 'sd')).toEqual({ admitted: false, reason: 'scanner_unavailable' });
    h.scanOn = false;
    expect(await ensureIiRealScanAdmissible(USER, 'sd')).toEqual({ admitted: true });
  });
});
