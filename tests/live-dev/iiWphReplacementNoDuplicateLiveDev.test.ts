// Document2 (4) WP-H (F5/F6/F14) -- LIVE hosted-DEV proof of the replacement path: old structured statement -> controlled replacement copy
// -> reprocess, twice, with a full before/after oracle read from the real DEV database (project vqycarelcoijzwlpkpcz ONLY).
//
// WHAT RUNS FOR REAL: the real replaceSourceDocumentFile / processSourceDocument / publishPosition / refreshPosition / selectInvestments
// code, REAL PDF bytes, the REAL pdf-parse text layer and CAMS parser, REAL Supabase Storage (investment-source-documents bucket) and the
// REAL DEV schema (unique fingerprints, constraints, triggers).
// WHAT DOES NOT: the HTTP route and its Premium gate (the services are called with the user id, as the earlier live suites do), the
// real malware scan (this process does not set AIE_REAL_MALWARE_SCAN_ENABLED), and the browser. publishPosition normally uses the
// request's cookie client; here `@/lib/supabase/server` is pointed at the service-role client (RLS bypassed) -- cross-tenant denial is
// proved in the unit and PGlite suites, not here.
//
// SAFETY: DEV only (the URL's project ref is checked and the run refuses anything else). The synthetic user is created WITHOUT a password
// (email_confirm only; no sign-in is needed because the services take the user id). Production credentials are never read: only the three
// DEV variables are taken from the env file. Every row the run creates is deleted in afterAll and re-queried for residue.
//
// HOW TO RUN: WPH_ENV_FILE=<path to the .env.local that points at DEV> npx vitest run --config vitest.livedev.config.ts tests/live-dev/iiWphReplacementNoDuplicateLiveDev.test.ts
// Without an env file the suite is a single skipped placeholder (it never silently passes zero assertions).
import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createClient as createSupabaseJsClient } from '@supabase/supabase-js';
import { buildMinimalTextPdf } from '../support/buildMinimalPdf';
import { buildWphCas, OTHER_FOLIO, PRIME_FOLIO_APR, PRIME_FOLIO_Q1, type WphFolio } from '../support/buildWphCasText';

const h = vi.hoisted(() => ({ admin: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.admin }));

const repoRoot = path.resolve(__dirname, '..', '..');
const envFile = process.env.WPH_ENV_FILE ?? path.join(repoRoot, '.env.local');
const HAS_ENV = fs.existsSync(envFile);

if (!HAS_ENV) {
  describe('WP-H live DEV replacement proof', () => {
    it.skip('SKIPPED: no env file (set WPH_ENV_FILE) -- the live DEV proof was NOT executed', () => {
      expect(HAS_ENV).toBe(false);
    });
  });
} else {
  // Only the three DEV variables are read from the file; every other line (including any production variable) is ignored.
  const wanted = new Set(['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']);
  const env: Record<string, string> = {};
  for (const rawLine of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = rawLine.replace(/^﻿/, '').trim().match(/^([A-Za-z_0-9]+)=(.*)$/);
    if (m && wanted.has(m[1])) env[m[1]] = m[2].trim().replace(/^"|"$/g, '');
  }
  const BASE = env.NEXT_PUBLIC_SUPABASE_URL;
  const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!BASE || !ANON || !SERVICE) throw new Error('NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY must be present for the live DEV proof.');
  const EXPECTED_DEV_REF = 'vqycarelcoijzwlpkpcz';
  const actualRef = new URL(BASE).host.split('.')[0];
  if (actualRef !== EXPECTED_DEV_REF) throw new Error(`REFUSING TO RUN: project "${actualRef}" is not the DEV project. This suite never touches production.`);
  process.env.NEXT_PUBLIC_SUPABASE_URL = BASE;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE;
  delete process.env.AIE_REAL_MALWARE_SCAN_ENABLED; // structural-only mode, as documented; the real scan is covered by its own tests

  const admin = createSupabaseJsClient(BASE, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
  h.admin = admin;
  const STAMP = Date.now();
  const RUN_TAG = `wph-${STAMP}`;
  const created: { userIds: string[]; keys: string[] } = { userIds: [], keys: [] };
  const evidence: Record<string, unknown> = { project: EXPECTED_DEV_REF, runTag: RUN_TAG, startedAt: new Date().toISOString(), steps: [] as unknown[] };

  // Unique fund identity per run so the run can never match (or delete) a real instrument.
  const digits = String(STAMP).slice(-6);
  const uniq = (f: WphFolio): WphFolio => ({ ...f, scheme: `WPH Live ${STAMP} ${f.scheme}`, isin: `INFWPH${digits}`, folio: `${f.folio.slice(0, 4)}${digits}` });
  const Q1_FOLIO = uniq(PRIME_FOLIO_Q1);
  const APR_FOLIO = uniq(PRIME_FOLIO_APR);
  const OTHER_UNIQ: WphFolio = { ...OTHER_FOLIO, scheme: `WPH Live ${STAMP} ${OTHER_FOLIO.scheme}`, isin: `INFWPX${digits}`, folio: `${OTHER_FOLIO.folio.slice(0, 4)}${digits}` };
  const Q1 = buildWphCas({ periodStart: '01-Jan-2025', periodEnd: '31-Mar-2025', folios: [Q1_FOLIO] });
  const APR = buildWphCas({ periodStart: '01-Jan-2025', periodEnd: '30-Apr-2025', folios: [APR_FOLIO] });
  const OTHER = buildWphCas({ periodStart: '01-Apr-2023', periodEnd: '31-Mar-2024', folios: [OTHER_UNIQ] });
  const copy = (label: string, text: string) => ({ bytes: new Uint8Array(buildMinimalTextPdf([text.split('\n'), [`Copy reference ${RUN_TAG} ${label}`]])), name: `${label}.pdf` });

  async function makeUser(tag: string): Promise<{ userId: string; memberId: string }> {
    const email = `${RUN_TAG}-${tag}@fhip-synthetic.test`;
    const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true }); // NO password
    if (error || !data.user) throw new Error(`could not create synthetic user ${tag}: ${error?.message}`);
    created.userIds.push(data.user.id);
    const userId = data.user.id;
    await admin.from('user_profiles').upsert({ user_id: userId, country_of_residence: 'IN', preferred_currency: 'INR' }, { onConflict: 'user_id' });
    const { data: hh, error: hhErr } = await admin.from('households').insert({ user_id: userId, household_name: `WPH ${tag}`, primary_country: 'IN' }).select('id').single();
    if (hhErr || !hh) throw new Error(`household insert failed: ${hhErr?.message}`);
    const { data: mem, error: memErr } = await admin.from('household_members').insert({ user_id: userId, household_id: hh.id, full_name: 'Asha Rao', relationship: 'self' }).select('id').single();
    if (memErr || !mem) throw new Error(`household member insert failed: ${memErr?.message}`);
    return { userId, memberId: mem.id as string };
  }

  async function processedStatement(tag: string) {
    const { II_STORAGE_BUCKET } = await import('@/lib/services/investment-intelligence/storage');
    const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
    const { userId, memberId } = await makeUser(tag);
    const first = copy(`${tag}-original`, Q1);
    const key = `${userId}/${randomUUID()}.pdf`;
    created.keys.push(key);
    const up = await admin.storage.from(II_STORAGE_BUCKET).upload(key, first.bytes, { contentType: 'application/pdf', upsert: false });
    if (up.error) throw new Error(`storage upload failed: ${up.error.message}`);
    const { data: doc, error } = await admin
      .from('ii_source_documents')
      .insert({ user_id: userId, owner_member_id: memberId, country_code: 'IN', status: 'uploaded', checksum: createHash('sha256').update(first.bytes).digest('hex'), storage_path: key, original_filename: first.name, mime_type: 'application/pdf', file_size: first.bytes.byteLength, document_type: 'cas_statement' })
      .select('id')
      .single();
    if (error || !doc) throw new Error(`could not create the source document: ${error?.message}`);
    const r = await processSourceDocument({ userId, sourceDocumentId: doc.id as string });
    expect(r.ok, `first processing failed: ${r.error}`).toBe(true);
    return { userId, memberId, docId: doc.id as string };
  }

  async function count(table: string, userId: string, eq: Record<string, unknown> = {}): Promise<number> {
    let q = admin.from(table).select('id', { count: 'exact', head: true }).eq('user_id', userId);
    for (const [k, v] of Object.entries(eq)) q = q.eq(k, v as never);
    const { count: n, error } = await q;
    if (error) throw new Error(`count ${table}: ${error.message}`);
    return n ?? 0;
  }
  async function rows<T = Record<string, unknown>>(table: string, userId: string, cols: string, eq: Record<string, unknown> = {}): Promise<T[]> {
    let q = admin.from(table).select(cols).eq('user_id', userId).limit(5000);
    for (const [k, v] of Object.entries(eq)) q = q.eq(k, v as never);
    const { data, error } = await q;
    if (error) throw new Error(`read ${table}: ${error.message}`);
    return (data ?? []) as T[];
  }
  const sum = (xs: { [k: string]: unknown }[], k: string) => Math.round(xs.reduce((s, r) => s + Number(r[k] ?? 0), 0) * 100) / 100;

  async function oracle(userId: string) {
    const { selectInvestments } = await import('@/lib/read-models/investments');
    const { fxContext } = await import('@/lib/read-models/core/currency');
    const txns = await rows('ii_transactions', userId, 'id, gross_amount, units');
    const snaps = await rows('ii_holding_snapshots', userId, 'id, units, value');
    const invs = await rows('investments', userId, 'id, current_value, source_type', { is_active: true });
    const inv = await selectInvestments(userId, { client: admin as never, fx: fxContext('INR', 56, 'IN') });
    if (inv.status !== 'ok') throw new Error(`Investments read model unavailable: ${JSON.stringify(inv)}`);
    const instruments = (await admin.from('ii_instruments').select('id', { count: 'exact', head: true }).like('instrument_name', `WPH Live ${STAMP}%`)).count ?? 0;
    return {
      economic: {
        accounts: await count('ii_accounts', userId),
        instruments,
        transactions: txns.length,
        transactionAmountSum: sum(txns, 'gross_amount'),
        transactionUnitsSum: sum(txns, 'units'),
        transactionSourceLinks: await count('ii_transaction_source_links', userId),
        holdingSnapshots: snaps.length,
        holdingUnitsSum: sum(snaps, 'units'),
        holdingValueSum: sum(snaps, 'value'),
        publicationsPublished: await count('ii_fhip_publications', userId, { status: 'published' }),
        publicationsAll: await count('ii_fhip_publications', userId),
        investmentsActive: invs.length,
        investmentsActiveValueSum: sum(invs, 'current_value'),
        netWorthInvestmentsPublishedTotal: inv.publishedTotal,
        netWorthInvestmentsLineCount: inv.lines.length,
        unpublishedBucketCount: inv.unpublished.count,
        portfolioTruthRows: await count('ii_portfolio_truth_status', userId),
      },
      bookkeeping: { parseRuns: await count('ii_document_parse_runs', userId), auditEvents: await count('ii_audit_events', userId), reconciliationCases: await count('ii_reconciliation_cases', userId) },
    };
  }
  type Oracle = Awaited<ReturnType<typeof oracle>>;
  const diff = (a: Oracle, b: Oracle) => {
    const out: Record<string, { before: number; after: number }> = {};
    for (const k of Object.keys(a.economic) as (keyof Oracle['economic'])[]) if (a.economic[k] !== b.economic[k]) out[k] = { before: a.economic[k], after: b.economic[k] };
    return out;
  };
  const record = (step: string, o: Oracle, note?: string) => (evidence.steps as unknown[]).push({ step, note, ...o });

  async function publishNewest(userId: string, refresh: boolean) {
    const { publishPosition, refreshPosition } = await import('@/lib/services/investment-intelligence/investmentPublicationService');
    const { data } = await admin.from('ii_holding_snapshots').select('id').eq('user_id', userId).order('as_of_date', { ascending: false }).limit(1);
    const id = (data?.[0] as { id: string } | undefined)?.id as string;
    const r = refresh ? await refreshPosition(userId, id) : await publishPosition(userId, id);
    expect(r.error, `publish/refresh: ${r.error}`).toBeNull();
  }

  async function replaceAndReprocess(f: { userId: string; docId: string }, c: { bytes: Uint8Array; name: string }, confirm: string[] = []) {
    const { replaceSourceDocumentFile } = await import('@/lib/services/investment-intelligence/sourceDocumentReplacement');
    const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
    const rep = await replaceSourceDocumentFile({ userId: f.userId, sourceDocumentId: f.docId, filename: c.name, mimeType: 'application/pdf', bytes: c.bytes, confirmedDifferences: confirm });
    if (!rep.ok) return { rep, proc: null };
    const { data: after } = await admin.from('ii_source_documents').select('storage_path').eq('id', f.docId).single();
    if (after?.storage_path) created.keys.push(after.storage_path as string);
    const proc = await processSourceDocument({ userId: f.userId, sourceDocumentId: f.docId, forceReparse: true });
    return { rep, proc };
  }

  afterAll(async () => {
    const { II_STORAGE_BUCKET } = await import('@/lib/services/investment-intelligence/storage');
    // instruments this run created (names are unique to the run) and their identifiers
    const { data: ins } = await admin.from('ii_instruments').select('id').like('instrument_name', `WPH Live ${STAMP}%`);
    const insIds = (ins ?? []).map((r) => r.id as string);
    for (const userId of created.userIds) {
      for (const t of ['ii_fhip_publications', 'investments', 'ii_reconciliation_cases', 'ii_transaction_source_links', 'ii_transactions', 'ii_holding_snapshots', 'ii_portfolio_truth_status', 'ii_document_parse_runs', 'ii_source_documents', 'ii_accounts']) {
        await admin.from(t).delete().eq('user_id', userId);
      }
      const { data: hhs } = await admin.from('households').select('id').eq('user_id', userId);
      for (const hh of hhs ?? []) await admin.from('household_members').delete().eq('household_id', hh.id as string);
      await admin.from('household_members').delete().eq('user_id', userId);
      await admin.from('households').delete().eq('user_id', userId);
      await admin.auth.admin.deleteUser(userId);
    }
    if (insIds.length) {
      await admin.from('ii_instrument_identifiers').delete().in('instrument_id', insIds);
      await admin.from('ii_instruments').delete().in('id', insIds);
    }
    const keys = [...new Set(created.keys)];
    if (keys.length) await admin.storage.from(II_STORAGE_BUCKET).remove(keys);
    // residue
    for (const userId of created.userIds) {
      for (const t of ['ii_source_documents', 'ii_accounts', 'ii_transactions', 'ii_holding_snapshots', 'investments', 'ii_fhip_publications']) {
        const { data } = await admin.from(t).select('id').eq('user_id', userId).limit(1);
        expect(data ?? [], `residue: ${t} for ${userId}`).toEqual([]);
      }
    }
    const { count: insLeft } = await admin.from('ii_instruments').select('id', { count: 'exact', head: true }).like('instrument_name', `WPH Live ${STAMP}%`);
    expect(insLeft ?? 0, 'residual synthetic instruments').toBe(0);
    for (const userId of created.userIds) {
      const { data: authUser } = await admin.auth.admin.getUserById(userId);
      expect(authUser?.user ?? null, `residual auth user ${userId}`).toBeNull();
    }
    evidence.finishedAt = new Date().toISOString();
    const out = path.join(repoRoot, 'docs', 'reviews', 'evidence_wp_h');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, `dev_oracle_${RUN_TAG}.json`), JSON.stringify(evidence, null, 2));
  }, 240_000);

  describe('WP-H live DEV: replacement path, real PDFs, real storage, real schema', () => {
    it('an identical statement re-downloaded, replaced three times: zero economic change, one canonical investment, Net Worth counted once', async () => {
      const f = await processedStatement('same');
      await publishNewest(f.userId, false);
      const o0 = await oracle(f.userId);
      record('same:0 after first process + publish', o0);
      expect(o0.economic).toMatchObject({ accounts: 1, instruments: 1, transactions: 2, holdingSnapshots: 1, publicationsPublished: 1, investmentsActive: 1, netWorthInvestmentsPublishedTotal: 7800 });

      const one = await replaceAndReprocess(f, copy('same-1', Q1));
      expect(one.rep.ok, JSON.stringify(one.rep)).toBe(true);
      expect(one.rep.ok && one.rep.identity.decision).toBe('match');
      expect(one.proc?.ok, one.proc?.error ?? '').toBe(true);
      expect(one.proc?.summary).toMatchObject({ newTransactionsCount: 0, duplicateTransactionsLinked: 2 });
      const o1 = await oracle(f.userId);
      record('same:1 after replacement #1 + reprocess', o1);
      expect(diff(o0, o1)).toEqual({});

      const two = await replaceAndReprocess(f, copy('same-2', Q1));
      expect(two.rep.ok && two.proc?.ok).toBe(true);
      const o2 = await oracle(f.userId);
      record('same:2 after replacement #2 + reprocess (second pass)', o2);
      expect(diff(o1, o2), 'second pass changed economics').toEqual({});

      const three = await replaceAndReprocess(f, copy('same-2', Q1)); // identical bytes to the previous copy
      expect(three.rep.ok && three.proc?.ok).toBe(true);
      const o3 = await oracle(f.userId);
      record('same:3 after replacement #3 with identical bytes', o3);
      expect(diff(o0, o3), 'after three replacements the economics differ from the start').toEqual({});
      const { count: docs } = await admin.from('ii_source_documents').select('id', { count: 'exact', head: true }).eq('user_id', f.userId);
      expect(docs).toBe(1);
    }, 240_000);

    it('an extended copy needs confirmation; confirmed, only the new purchase and the new holding date are added; the investment is updated once; the second pass changes nothing', async () => {
      const { replaceSourceDocumentFile } = await import('@/lib/services/investment-intelligence/sourceDocumentReplacement');
      const f = await processedStatement('extend');
      await publishNewest(f.userId, false);
      const o0 = await oracle(f.userId);
      const april = copy('extend-april', APR);
      const refused = await replaceSourceDocumentFile({ userId: f.userId, sourceDocumentId: f.docId, filename: april.name, mimeType: 'application/pdf', bytes: april.bytes });
      expect(refused.ok).toBe(false);
      expect(!refused.ok && refused.code).toBe('replacement_needs_confirmation');
      expect(diff(o0, await oracle(f.userId))).toEqual({});
      record('extend:0 before', o0, `refused without confirmation: ${!refused.ok && refused.message}`);

      const done = await replaceAndReprocess(f, april, ['period_differs']);
      expect(done.rep.ok && done.proc?.ok, JSON.stringify(done.rep)).toBe(true);
      const o1 = await oracle(f.userId);
      record('extend:1 after confirmed replacement + reprocess', o1);
      expect(diff(o0, o1)).toEqual({
        transactions: { before: 2, after: 3 },
        transactionAmountSum: { before: 7500, after: 10150 },
        transactionUnitsSum: { before: 150, after: 200 },
        transactionSourceLinks: { before: 2, after: 3 },
        holdingSnapshots: { before: 1, after: 2 },
        holdingUnitsSum: { before: 150, after: 350 },
        holdingValueSum: { before: 7800, after: 18400 },
      });
      await publishNewest(f.userId, true);
      const o2 = await oracle(f.userId);
      record('extend:2 after refreshing the publication to the newer holding', o2);
      expect(o2.economic.investmentsActive).toBe(1);
      expect(o2.economic.netWorthInvestmentsLineCount).toBe(1);
      expect(o2.economic.netWorthInvestmentsPublishedTotal).toBe(10600);

      const again = await replaceAndReprocess(f, copy('extend-april-2', APR), ['period_differs']);
      expect(again.rep.ok && again.proc?.ok).toBe(true);
      const o3 = await oracle(f.userId);
      record('extend:3 second pass', o3);
      expect(diff(o2, o3), 'second pass changed economics').toEqual({});
    }, 240_000);

    it('an unrelated statement is refused before anything changes (and a second user cannot touch it)', async () => {
      const { replaceSourceDocumentFile } = await import('@/lib/services/investment-intelligence/sourceDocumentReplacement');
      const f = await processedStatement('unrelated');
      await publishNewest(f.userId, false);
      const other = await makeUser('other-user');
      const o0 = await oracle(f.userId);
      const before = (await admin.from('ii_source_documents').select('*').eq('id', f.docId).single()).data;
      const r = await replaceSourceDocumentFile({ userId: f.userId, sourceDocumentId: f.docId, filename: 'other.pdf', mimeType: 'application/pdf', bytes: copy('unrelated-other', OTHER).bytes });
      expect(r.ok).toBe(false);
      expect(!r.ok && r.code).toBe('replacement_identity_conflict');
      const cross = await replaceSourceDocumentFile({ userId: other.userId, sourceDocumentId: f.docId, filename: 'x.pdf', mimeType: 'application/pdf', bytes: copy('cross', Q1).bytes });
      expect(!cross.ok && cross.httpStatus).toBe(404);
      expect((await admin.from('ii_source_documents').select('*').eq('id', f.docId).single()).data).toEqual(before);
      const o1 = await oracle(f.userId);
      record('unrelated: after refusal', o1, `${!r.ok && r.message}`);
      expect(diff(o0, o1)).toEqual({});
    }, 240_000);
  });
}
