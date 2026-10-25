// Document2 (4) WP-B2 (25-10-2026) -- the PO's production report, reproduced and fixed with the REAL services against the REAL migration
// ledger (PGlite), then rendered with the REAL row component.
//
//   (1) A position that already has an active publication still showed "Publish to FHIP", and the panel said "New position adds X to net
//       worth" for something already counted. Now: the list says Published (+ Refresh when a newer certified statement exists, always
//       Unpublish), offers Publish only for an unpublished position, and the panel states what is true.
//   (2) Re-evaluate on a "Needs review" position (units rebuilt from the transactions do not match the statement) looked like nothing
//       happened. Now: a result card with the time, the figures, where the history is missing, what fixes it and a real Upload button.
//
// EVIDENCE LABEL: PGLITE-VERIFIED (isolated replay). NOT DEV-verified, NOT production-verified, no browser click-through.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createHash } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { replayAll } from './support/promoTestHelpers';
import { createPgliteSupabase, pgliteOptions, type PgliteSupabase } from './support/pgliteSupabase';
import { buildMinimalTextPdf } from '../support/buildMinimalPdf';
import { buildWphCas, PRIME_FOLIO_APR, PRIME_FOLIO_Q1 } from '../support/buildWphCasText';

const h = vi.hoisted(() => ({
  client: null as unknown as PgliteSupabase,
  filesByKey: new Map<string, Uint8Array>(),
  userId: '',
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.client }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.client }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  requireCountryConfirmedUser: async () => ({ user: { id: h.userId, email: null }, unauthenticated: null }),
}));
vi.mock('@/lib/services/investment-intelligence/storage', async (orig) => ({
  ...(await orig<typeof import('@/lib/services/investment-intelligence/storage')>()),
  uploadSourceDocumentObject: async (key: string, bytes: Uint8Array) => {
    h.filesByKey.set(key, bytes);
    return { error: null };
  },
  downloadSourceDocumentObject: async (key: string) => {
    const bytes = h.filesByKey.get(key);
    return bytes ? { bytes, error: null } : { bytes: null, error: 'not found' };
  },
  deleteSourceDocumentObject: async (key: string) => {
    h.filesByKey.delete(key);
    return { error: null };
  },
  verifySourceDocumentObjectAbsent: async (key: string) => !h.filesByKey.has(key),
}));
vi.mock('@/lib/aie/malware/config', async (orig) => ({ ...(await orig<typeof import('@/lib/aie/malware/config')>()), isRealMalwareScanEnabled: () => false }));

import { processSourceDocument } from '@/lib/services/investment-intelligence/documentProcessing';
import { replaceSourceDocumentFile } from '@/lib/services/investment-intelligence/sourceDocumentReplacement';
import { buildPreview, publishPosition, refreshPosition, unpublishPosition } from '@/lib/services/investment-intelligence/investmentPublicationService';
import { GET as summaryGET } from '@/app/api/investment-intelligence/source-documents/[id]/summary/route';
import { POST as certifyPOST } from '@/app/api/investment-intelligence/portfolio-truth/certify/route';
import { PortfolioTruthPositionRow, type TruthRowPosition, type TruthRowStatus } from '@/components/investment-intelligence/PortfolioTruthPositionRow';
import { describePanelImpact } from '@/lib/investment-intelligence/publicationState';
import { buildReevaluationCard } from '@/lib/investment-intelligence/reevaluationResult';
import { formatMoneyCode } from '@/lib/engines/money';
import { fmtDate } from '@/components/investment-intelligence/dateDisplay';

const Q1 = buildWphCas({ periodStart: '01-Jan-2025', periodEnd: '31-Mar-2025', folios: [PRIME_FOLIO_Q1] });
const APR = buildWphCas({ periodStart: '01-Jan-2025', periodEnd: '30-Apr-2025', folios: [PRIME_FOLIO_APR] });
// FTI036-like: the statement shows 150 units but only a 40-unit purchase is held (the earlier history was never uploaded)
const GAP_FOLIO = { ...PRIME_FOLIO_Q1, txns: [{ date: '10-Jan-2025', amount: '2,000.00', price: '50.0000', units: '40.000', balance: '40.000', ref: 'WPB2-001' }] };
const GAP = buildWphCas({ periodStart: '01-Jan-2025', periodEnd: '31-Mar-2025', folios: [GAP_FOLIO] });

let db: PGlite;
let n = 0;
const uid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

function copy(label: string, text: string) {
  return { bytes: new Uint8Array(buildMinimalTextPdf([text.split('\n'), [`Copy reference ${label}`]])), name: `${label}.pdf` };
}

interface Fixture {
  userId: string;
  memberId: string;
  docId: string;
}

async function statement(label: string, text: string): Promise<Fixture> {
  const userId = uid();
  const memberId = uid();
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [userId, `${label}-${userId}@example.test`]);
  await db.query(`insert into user_profiles (user_id, country_of_residence, preferred_currency) values ($1, 'IN', 'INR') on conflict (user_id) do update set country_of_residence = 'IN', preferred_currency = 'INR'`, [userId]);
  await db.query(`insert into household_members (id, user_id, full_name, relationship, is_active) values ($1, $2, 'Asha Rao', 'self', true)`, [memberId, userId]);
  const docId = uid();
  const first = copy(`${label}-original`, text);
  const key = `${userId}/${label}-original.pdf`;
  h.filesByKey.set(key, first.bytes);
  await db.query(
    `insert into ii_source_documents (id, user_id, owner_member_id, country_code, status, storage_path, original_filename, mime_type, file_size, checksum, document_type)
     values ($1, $2, $3, 'IN', 'uploaded', $4, $5, 'application/pdf', $6, $7, 'cas_statement')`,
    [docId, userId, memberId, key, first.name, first.bytes.byteLength, createHash('sha256').update(first.bytes).digest('hex')],
  );
  h.userId = userId;
  const r = await processSourceDocument({ userId, sourceDocumentId: docId });
  expect(r.ok, `processing: ${r.error}`).toBe(true);
  return { userId, memberId, docId };
}

const latestSnapshotId = async (userId: string) => (await db.query<{ id: string }>(`select id from ii_holding_snapshots where user_id = $1 order by as_of_date desc, created_at desc limit 1`, [userId])).rows[0].id;
const olderSnapshotId = async (userId: string) => (await db.query<{ id: string }>(`select id from ii_holding_snapshots where user_id = $1 order by as_of_date asc, created_at asc limit 1`, [userId])).rows[0].id;

async function summaryOf(f: Fixture) {
  h.userId = f.userId;
  const res = await summaryGET(new Request('http://t/x'), { params: Promise.resolve({ id: f.docId }) });
  expect(res.status).toBe(200);
  return (await res.json()).data as {
    portfolioTruthStatuses: (TruthRowStatus & { accountLabel: string | null; instrumentName: string | null })[];
    positions: Record<string, TruthRowPosition>;
  };
}

const IDLE = { certifyingThis: false, certifyingAny: false, publishBusy: false, unpublishBusy: false, refreshBusy: false };
function row(s: TruthRowStatus, position: TruthRowPosition | undefined, extra: Partial<Parameters<typeof PortfolioTruthPositionRow>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(PortfolioTruthPositionRow, {
      status: s,
      position,
      label: 'Prime Flexi Cap Fund — 1122334455',
      fallbackCurrency: 'INR',
      busy: IDLE,
      result: null,
      resultError: null,
      incompleteHistoryNote: false,
      onReevaluate: () => undefined,
      onPublish: () => undefined,
      onRefresh: () => undefined,
      onUnpublish: () => undefined,
      onUpload: () => undefined,
      onGoToAnchor: () => undefined,
      ...extra,
    }),
  );
}
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1].trim());

beforeAll(async () => {
  db = new PGlite(pgliteOptions);
  await replayAll(db);
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ role: 'service_role' })]);
  h.client = createPgliteSupabase(db);
}, 900_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(() => h.filesByKey.clear());

describe('(1) a published position is shown as Published, never as something to publish', () => {
  it('REPRODUCTION + FIX: certified and published -> Published pill, counted value, Unpublish; NO "Publish to FHIP" button; no dead Refresh', async () => {
    const f = await statement('pub-current', Q1);
    const pub = await publishPosition(f.userId, await latestSnapshotId(f.userId));
    expect(pub.error).toBeNull();
    const sum = await summaryOf(f);
    const s = sum.portfolioTruthStatuses[0];
    expect(['certified', 'certified_with_warnings']).toContain(s.status);
    const position = sum.positions[`${s.account_id}:${s.instrument_id}`];
    expect(position.publication.kind).toBe('published_current');
    const html = row(s, position);
    expect(html).toContain('data-publication-state="published_current"');
    expect(html).toContain('data-testid="published-pill"');
    expect(html).toContain('Counted in net worth: ');
    expect(html).toMatch(/7,800/);
    expect(html).toContain('the statement dated 31-03-2025'); // day-first
    expect(buttons(html)).toEqual(['Re-evaluate', 'Unpublish']);
    expect(buttons(html)).not.toContain('Publish to FHIP');
    expect(buttons(html)).not.toContain('Refresh');
    expect(html).toContain('Up to date: no newer certified statement.');
  }, 300_000);

  it('NEGATIVE CONTROL: the same position, once unpublished, is offered Publish to FHIP again (the button is not simply gone)', async () => {
    const f = await statement('pub-unpublished', Q1);
    const pub = await publishPosition(f.userId, await latestSnapshotId(f.userId));
    expect((await unpublishPosition(f.userId, pub.publicationId as string)).error).toBeNull();
    const sum = await summaryOf(f);
    const s = sum.portfolioTruthStatuses[0];
    const position = sum.positions[`${s.account_id}:${s.instrument_id}`];
    expect(position.publication.kind).toBe('not_published');
    expect(buttons(row(s, position))).toEqual(['Re-evaluate', 'Publish to FHIP']);
  }, 300_000);

  it('the panel for an already-published position says what is TRUE: already counted, nothing to publish, no confirm button', async () => {
    const f = await statement('pub-panel', Q1);
    await publishPosition(f.userId, await latestSnapshotId(f.userId));
    h.userId = f.userId;
    const { preview, error } = await buildPreview(f.userId, await latestSnapshotId(f.userId));
    expect(error).toBeNull();
    const ap = preview!.alreadyPublished!;
    expect(ap.relation).toBe('same_snapshot');
    expect(ap.alreadyCountedValue).toBe(7800);
    // the old code reported the WHOLE value as the net change ("New position adds 7,800"); an already counted position changes nothing
    expect(preview!.financialImpact?.netChange).toBe(0);
    expect(preview!.financialImpact?.currentIncludedValue).toBe(7800);
    const panel = describePanelImpact({
      publication: { kind: ap.relation, counted: ap.alreadyCountedValue, asOf: ap.publishedAsOf },
      eligible: true,
      willCount: preview!.currentValuation?.value ?? preview!.certifiedValue,
      fmt: (x) => formatMoneyCode(x, 'INR'),
      date: (iso) => fmtDate(iso, 'INR'),
    });
    expect(panel.action).toBe('none'); // Confirm is NOT offered: there is nothing valid to confirm
    expect(panel.confirmLabel).toBeNull();
    expect(panel.headline).toMatch(/^Already counted in net worth: .*7,800/);
    expect(panel.headline).not.toMatch(/New position/);
    expect(panel.change).toBe(0);
  }, 300_000);

  it('a NEWER certified statement: the row shows Published AND Refresh with the stale note; the panel says "Already counted ... Refresh will update it to ... (change ...)" and Confirm is a refresh; refreshing makes it current', async () => {
    const f = await statement('pub-newer', Q1);
    const q1Id = await latestSnapshotId(f.userId);
    await publishPosition(f.userId, q1Id);
    const rep = await replaceSourceDocumentFile({ userId: f.userId, sourceDocumentId: f.docId, filename: 'apr.pdf', mimeType: 'application/pdf', bytes: copy('apr', APR).bytes, confirmedDifferences: ['period_differs'] });
    expect(rep.ok, JSON.stringify(rep)).toBe(true);
    const proc = await processSourceDocument({ userId: f.userId, sourceDocumentId: f.docId, forceReparse: true });
    expect(proc.ok, proc.error ?? '').toBe(true);
    const aprId = await latestSnapshotId(f.userId);
    expect(aprId).not.toBe(q1Id);

    const sum = await summaryOf(f);
    const s = sum.portfolioTruthStatuses[0];
    const position = sum.positions[`${s.account_id}:${s.instrument_id}`];
    expect(position.publication.kind).toBe('published_refresh_available');
    expect(position.latestSnapshotId).toBe(aprId); // the Publish/Refresh target is the LATEST certified snapshot
    const html = row(s, position);
    expect(buttons(html)).toEqual(['Re-evaluate', 'Refresh', 'Unpublish']);
    expect(buttons(html)).not.toContain('Publish to FHIP');
    expect(html).toContain('data-testid="stale-note"');
    expect(html).toContain('30-04-2025'); // the newer statement, day-first
    expect(html).toMatch(/7,800/); // what net worth counts today

    const { preview } = await buildPreview(f.userId, aprId);
    const ap = preview!.alreadyPublished!;
    expect(ap.relation).toBe('newer_snapshot');
    expect(ap.alreadyCountedValue).toBe(7800);
    const willCount = preview!.currentValuation?.value ?? preview!.certifiedValue!;
    expect(preview!.financialImpact?.netChange).toBeCloseTo(willCount - 7800, 2);
    const panel = describePanelImpact({
      publication: { kind: ap.relation, counted: ap.alreadyCountedValue, asOf: ap.publishedAsOf },
      eligible: true,
      willCount,
      fmt: (x) => formatMoneyCode(x, 'INR'),
      date: (iso) => fmtDate(iso, 'INR'),
    });
    expect(panel.action).toBe('refresh');
    expect(panel.confirmLabel).toBe('Confirm refresh');
    expect(panel.headline).toMatch(/Already counted in net worth: .*7,800/);
    expect(panel.detail).toMatch(/Refresh will update it to .*\(change \+/);

    // CONTROL: the older statement cannot replace the newer one, so no confirm is offered for it either
    const older = (await buildPreview(f.userId, q1Id)).preview!;
    expect(older.alreadyPublished!.relation).toBe('same_snapshot');

    const refreshed = await refreshPosition(f.userId, aprId);
    expect(refreshed.error).toBeNull();
    const after = await summaryOf(f);
    const pos2 = after.positions[`${s.account_id}:${s.instrument_id}`];
    expect(pos2.publication.kind).toBe('published_current');
    expect(buttons(row(after.portfolioTruthStatuses[0], pos2))).toEqual(['Re-evaluate', 'Unpublish']);
    const counted = Number((await db.query<{ v: string }>(`select current_value::text v from investments where user_id = $1 and is_active`, [f.userId])).rows[0].v);
    expect(counted).toBeCloseTo(willCount, 2);
    // and the older snapshot, previewed now, is "older": nothing valid to confirm
    const stale = (await buildPreview(f.userId, q1Id)).preview!;
    expect(stale.alreadyPublished!.relation).toBe('older_snapshot');
    expect(describePanelImpact({ publication: { kind: 'older_snapshot', counted, asOf: null }, eligible: true, willCount: 7800, fmt: (x) => String(x), date: (i) => i }).action).toBe('none');
  }, 600_000);
});

describe('(2) Re-evaluate on a "Needs review" position always shows a visible, specific, actionable result', () => {
  it('REPRODUCTION: units rebuilt (40) vs statement (150) -> blocked with unit_variance_exceeds_tolerance, and the check is re-run from the REAL route with the figures in the response', async () => {
    const f = await statement('gap', GAP);
    const sum = await summaryOf(f);
    const s = sum.portfolioTruthStatuses[0];
    expect(s.status).toBe('reconciliation_required');
    expect((s.blocking_reasons ?? []).map((b) => b.code)).toContain('unit_variance_exceeds_tolerance');
    const position = sum.positions[`${s.account_id}:${s.instrument_id}`];
    expect(position.earliestTransactionDate).toBe('2025-01-10');

    h.userId = f.userId;
    const res = await certifyPOST(new Request('http://t/x', { method: 'POST', body: JSON.stringify({ accountId: s.account_id, instrumentId: s.instrument_id }) }));
    expect(res.status).toBe(200);
    const after = (await res.json()).data as { status: string; blocking_reasons: { code: string; message: string }[]; reconciled_closing_units: number; statement_closing_units: number; unit_variance: number };
    expect(after.status).toBe('reconciliation_required'); // Re-evaluate cannot invent history: it stays blocked
    expect(Number(after.reconciled_closing_units)).toBe(40);
    expect(Number(after.statement_closing_units)).toBe(150);
    expect(Number(after.unit_variance)).toBe(-110);

    const card = buildReevaluationCard(
      {
        before: s.status,
        after: after.status,
        blocking: after.blocking_reasons,
        reconciledClosingUnits: after.reconciled_closing_units,
        statementClosingUnits: after.statement_closing_units,
        unitVariance: after.unit_variance,
        earliestTransactionDate: position.earliestTransactionDate,
        previousReasonCodes: (s.blocking_reasons ?? []).map((b) => b.code),
        checkedAtLabel: '25-10-2026 14:05',
      },
      (iso) => fmtDate(iso, 'INR'),
    );
    expect(card.tone).toBe('blocked');
    expect(card.headline).toBe('Still needs review: the units rebuilt from the transactions (40) do not match the statement closing balance (150); 110 units are missing.');
    expect(card.lines.join(' ')).toMatch(/earliest transaction held for this position is dated 10-01-2025, so the missing history is from before 10-01-2025/);
    expect(card.lines.join(' ')).toMatch(/upload a CAMS or KFintech consolidated statement that covers the whole history/);
    expect(card.lines.join(' ')).toMatch(/There is no way to accept this gap/); // no governed alternative exists: said, never silent
    expect(card.lines[0]).toBe('Nothing has changed since the last check: the same reason still applies.');
    expect(card.cta).toEqual({ label: 'Upload statement', kind: 'upload' });
    expect(card.checkedLine).toBe('Checked just now (25-10-2026 14:05).');

    // what the person SEES: a status card (not a grey one-liner), the figures, the time and a real Upload statement button
    const uploads: string[] = [];
    const html = row(s, position, { result: card, onUpload: () => uploads.push('x') });
    expect(html).toContain('data-testid="reevaluate-result"');
    expect(html).toContain('role="status"');
    expect(html).toContain('(40)');
    expect(html).toContain('(150)');
    expect(html).toContain('Checked just now (25-10-2026 14:05).');
    expect(buttons(html)).toContain('Upload statement');
    // the standing blocker box is not repeated underneath the result (it said the same words: the "nothing happened" look)
    expect(html).not.toContain('data-testid="truth-blocker"');
  }, 300_000);

  it('before any click the standing explanation already carries the figures and the Upload statement button', async () => {
    const f = await statement('gap-standing', GAP);
    const sum = await summaryOf(f);
    const s = sum.portfolioTruthStatuses[0];
    const html = row(s, sum.positions[`${s.account_id}:${s.instrument_id}`]);
    expect(html).toContain('data-testid="truth-blocker"');
    expect(html).toContain('(40)');
    expect(html).toContain('110 units are missing');
    expect(html).toContain('10-01-2025');
    expect(buttons(html)).toContain('Upload statement');
  }, 300_000);

  it('while it runs the row says so; a failed request shows a plain error with what to do; a position that becomes ready says so', () => {
    const base = { account_id: 'a', instrument_id: 'i', status: 'reconciliation_required', blocking_reasons: [], warning_reasons: [] } as TruthRowStatus;
    expect(row(base, undefined, { busy: { ...IDLE, certifyingThis: true, certifyingAny: true } })).toContain('Re-evaluating this position…');
    const failed = row(base, undefined, { resultError: 'The check could not be run.' });
    expect(failed).toContain('data-testid="reevaluate-error"');
    expect(failed).toContain('Re-evaluate did not complete: The check could not be run. Nothing was changed.');
    const ready = buildReevaluationCard({ before: 'reconciliation_required', after: 'certified', blocking: [], reconciledClosingUnits: 150, statementClosingUnits: 150, unitVariance: 0, earliestTransactionDate: null, previousReasonCodes: ['unresolved_owner'], checkedAtLabel: '25-10-2026 14:06' }, (i) => i);
    expect(ready.tone).toBe('ready');
    expect(ready.headline).toBe('Re-evaluated: this position is now ready to publish.');
    expect(row({ ...base, status: 'certified' }, undefined, { result: ready })).toContain('data-tone="ready"');
  });
});
