// Document2 (4) WP-J task 0 -- PROFILE where the time goes when a LARGE CAMS statement is processed / reprocessed (the
// "Upload replacement copy" that never finishes on production). DEV project vqycarelcoijzwlpkpcz ONLY.
//
// WHAT IT MEASURES (real code, real PDF bytes, real Storage, real DEV schema): every HTTP request the pipeline makes to Supabase is
// timed through a wrapping fetch (method, table or function, duration, and, for audit inserts, the event type), then the timeline is
// cut into the pipeline's own steps:
//   read/parse            download + PDF text extraction + parse (ends at the `source_detected` audit event)
//   accounts              folio / account resolution (ends at the first scheme-universe read)
//   scheme_resolution     the active scheme universe is read (paginated) and every scheme in the statement is resolved/created
//   transactions          fingerprint prefetch, per-transaction duplicate links, cross-source candidates, batched inserts
//   holdings              holding snapshot upserts
//   missing_detection     previously recorded transactions the statement did not re-confirm
//   certification         reconciliation + certification of every (account, scheme) pair
//   finalize              document + run close, raw-file purge, audit
// and the same for (a) the first processing, (b) a controlled replacement copy + forced reprocess (the PO's failing action),
// (c) "Re-evaluate all positions" (recertifyPosition for every position), (d) publication of three positions.
//
// SAFETY: DEV only (the project ref is checked), synthetic users created WITHOUT a password, everything created is deleted and
// re-queried for residue. Production credentials are never read: only the three DEV variables are taken from the env file.
//
// HOW TO RUN: WPJ_ENV_FILE=<.env.local that points at DEV> WPJ_SIZES=25x12,60x30 npx vitest run --config vitest.livedev.config.ts tests/live-dev/iiWpjProfileLiveDev.test.ts
// Without an env file the suite is one skipped placeholder (it never silently passes zero assertions).
import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createClient as createSupabaseJsClient } from '@supabase/supabase-js';
import { buildMinimalTextPdf } from '../support/buildMinimalPdf';
import { buildWpjLargeCas, paginateLines } from '../support/buildWpjLargeCas';

const h = vi.hoisted(() => ({ admin: null as unknown }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.admin }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.admin }));

const repoRoot = path.resolve(__dirname, '..', '..');
const envFile = process.env.WPJ_ENV_FILE ?? path.join(repoRoot, '.env.local');
const HAS_ENV = fs.existsSync(envFile);

interface Req {
  t0: number;
  t1: number;
  method: string;
  kind: string; // rest | rpc | storage | auth | other
  table: string;
  event?: string;
  status?: string;
}

if (!HAS_ENV) {
  describe('WP-J live DEV profile', () => {
    it.skip('SKIPPED: no env file (set WPJ_ENV_FILE) -- the profile was NOT executed', () => {
      expect(HAS_ENV).toBe(false);
    });
  });
} else {
  const wanted = new Set(['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']);
  const env: Record<string, string> = {};
  for (const rawLine of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = rawLine.replace(/^﻿/, '').trim().match(/^([A-Za-z_0-9]+)=(.*)$/);
    if (m && wanted.has(m[1])) env[m[1]] = m[2].trim().replace(/^"|"$/g, '');
  }
  const BASE = env.NEXT_PUBLIC_SUPABASE_URL;
  const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!BASE || !ANON || !SERVICE) throw new Error('The three DEV variables must be present.');
  const EXPECTED_DEV_REF = 'vqycarelcoijzwlpkpcz';
  const actualRef = new URL(BASE).host.split('.')[0];
  if (actualRef !== EXPECTED_DEV_REF) throw new Error(`REFUSING TO RUN: project "${actualRef}" is not the DEV project.`);
  process.env.NEXT_PUBLIC_SUPABASE_URL = BASE;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE;
  delete process.env.AIE_REAL_MALWARE_SCAN_ENABLED;

  const log: Req[] = [];
  const timedFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const u = new URL(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    let kind = 'other';
    let table = u.pathname;
    if (u.pathname.startsWith('/rest/v1/rpc/')) {
      kind = 'rpc';
      table = u.pathname.replace('/rest/v1/rpc/', '');
    } else if (u.pathname.startsWith('/rest/v1/')) {
      kind = 'rest';
      table = u.pathname.replace('/rest/v1/', '');
    } else if (u.pathname.startsWith('/storage/')) {
      kind = 'storage';
    } else if (u.pathname.startsWith('/auth/')) {
      kind = 'auth';
    }
    let event: string | undefined;
    let status: string | undefined;
    if (typeof init?.body === 'string' && init.body.length < 20000) {
      const em = init.body.match(/"event_type"\s*:\s*"([a-z_]+)"/);
      if (em) event = em[1];
      const sm = init.body.match(/"status"\s*:\s*"([a-z_]+)"/);
      if (sm) status = sm[1];
    }
    const t0 = performance.now();
    try {
      return await fetch(input, init);
    } finally {
      log.push({ t0, t1: performance.now(), method, kind, table, event, status });
    }
  };

  const admin = createSupabaseJsClient(BASE, SERVICE, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: timedFetch } });
  h.admin = admin;
  const STAMP = Date.now();
  const RUN_TAG = `wpj-${STAMP}`;
  const created: { userIds: string[]; keys: string[]; stamps: string[] } = { userIds: [], keys: [], stamps: [] };
  const evidence: Record<string, unknown> = { project: EXPECTED_DEV_REF, runTag: RUN_TAG, startedAt: new Date().toISOString(), fixtures: [] as unknown[] };

  const sizes = (process.env.WPJ_SIZES ?? '25x12,60x30').split(',').map((s) => {
    const [p, t] = s.trim().split('x').map(Number);
    return { positions: p, txns: t };
  });

  async function makeUser(tag: string): Promise<{ userId: string; memberId: string }> {
    const email = `${RUN_TAG}-${tag}@fhip-synthetic.test`;
    const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (error || !data.user) throw new Error(`could not create synthetic user ${tag}: ${error?.message}`);
    created.userIds.push(data.user.id);
    const userId = data.user.id;
    await admin.from('user_profiles').upsert({ user_id: userId, country_of_residence: 'IN', preferred_currency: 'INR' }, { onConflict: 'user_id' });
    const { data: hh, error: hhErr } = await admin.from('households').insert({ user_id: userId, household_name: `WPJ ${tag}`, primary_country: 'IN' }).select('id').single();
    if (hhErr || !hh) throw new Error(`household insert failed: ${hhErr?.message}`);
    const { data: mem, error: memErr } = await admin.from('household_members').insert({ user_id: userId, household_id: hh.id, full_name: 'Asha Rao', relationship: 'self' }).select('id').single();
    if (memErr || !mem) throw new Error(`household member insert failed: ${memErr?.message}`);
    return { userId, memberId: mem.id as string };
  }

  /** Cuts a request timeline into the pipeline's own steps. */
  function stepsOf(reqs: Req[]) {
    const rest = reqs.filter((r) => r.kind === 'rest' || r.kind === 'rpc' || r.kind === 'storage');
    if (rest.length === 0) return {};
    const start = Math.min(...reqs.map((r) => r.t0));
    const end = Math.max(...reqs.map((r) => r.t1));
    const firstIdx = (pred: (r: Req) => boolean, from = 0) => {
      for (let i = from; i < rest.length; i++) if (pred(rest[i])) return i;
      return -1;
    };
    const lastIdx = (pred: (r: Req) => boolean, from = 0) => {
      let found = -1;
      for (let i = from; i < rest.length; i++) if (pred(rest[i])) found = i;
      return found;
    };
    const iDetected = firstIdx((r) => r.table === 'ii_audit_events' && r.event === 'source_detected');
    const iUniverse = firstIdx((r) => r.table === 'ii_instrument_identifiers' && r.method === 'GET', Math.max(iDetected, 0));
    const iTxn = firstIdx((r) => r.table === 'ii_transactions', Math.max(iUniverse, 0));
    const iHold = firstIdx((r) => r.table === 'ii_holding_snapshots' && r.method === 'POST', Math.max(iTxn, 0));
    const iHoldLast = iHold >= 0 ? lastIdx((r) => r.table === 'ii_holding_snapshots' && r.method === 'POST', iHold) : -1;
    const iCert = iHoldLast >= 0 ? firstIdx((r) => r.table === 'ii_holding_snapshots' && r.method === 'GET', iHoldLast + 1) : -1;
    const iFinal = iCert >= 0 ? firstIdx((r) => r.table === 'ii_source_documents' && r.method === 'PATCH' && r.status === 'parsed', iCert) : -1;
    const cut = (a: number, b: number) => {
      if (a < 0) return { ms: 0, requests: 0 };
      const to = b < 0 ? rest.length : b;
      const sl = rest.slice(a, to);
      const from = a === 0 ? start : rest[a].t0;
      const until = to >= rest.length ? end : rest[to].t0;
      return { ms: Math.round(until - from), requests: sl.length };
    };
    const steps: Record<string, { ms: number; requests: number }> = {};
    steps.read_and_parse = (() => {
      const to = iDetected >= 0 ? iDetected + 1 : rest.length;
      return { ms: Math.round((iDetected >= 0 ? rest[iDetected].t1 : end) - start), requests: to };
    })();
    const afterDetected = iDetected >= 0 ? iDetected + 1 : 0;
    steps.accounts = cut(afterDetected, iUniverse);
    steps.scheme_resolution = cut(iUniverse, iTxn);
    steps.transactions = cut(iTxn, iHold);
    steps.holdings = iHold >= 0 ? cut(iHold, iHoldLast + 1) : { ms: 0, requests: 0 };
    steps.missing_detection = iHoldLast >= 0 ? cut(iHoldLast + 1, iCert) : { ms: 0, requests: 0 };
    steps.certification = iCert >= 0 ? cut(iCert, iFinal) : { ms: 0, requests: 0 };
    steps.finalize = iFinal >= 0 ? cut(iFinal, -1) : { ms: 0, requests: 0 };
    return { totalMs: Math.round(end - start), totalRequests: reqs.length, steps };
  }

  function byTable(reqs: Req[]) {
    const m = new Map<string, { n: number; ms: number }>();
    for (const r of reqs) {
      const k = `${r.method} ${r.table}`;
      const cur = m.get(k) ?? { n: 0, ms: 0 };
      cur.n += 1;
      cur.ms += r.t1 - r.t0;
      m.set(k, cur);
    }
    return [...m.entries()].map(([k, v]) => ({ call: k, requests: v.n, totalMs: Math.round(v.ms) })).sort((a, b) => b.totalMs - a.totalMs).slice(0, 12);
  }

  async function timeSection<T>(fn: () => Promise<T>): Promise<{ value: T; reqs: Req[]; wallMs: number }> {
    const from = log.length;
    const t0 = performance.now();
    const value = await fn();
    const wallMs = Math.round(performance.now() - t0);
    return { value, reqs: log.slice(from), wallMs };
  }

  afterAll(async () => {
    const { II_STORAGE_BUCKET } = await import('@/lib/services/investment-intelligence/storage');
    const insIds: string[] = [];
    for (const stamp of created.stamps) {
      const { data: ins } = await admin.from('ii_instruments').select('id').like('instrument_name', `WPJ ${stamp}%`).limit(5000);
      insIds.push(...(ins ?? []).map((r) => r.id as string));
    }
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
    for (let i = 0; i < insIds.length; i += 200) {
      const slice = insIds.slice(i, i + 200);
      await admin.from('ii_instrument_identifiers').delete().in('instrument_id', slice);
      await admin.from('ii_instruments').delete().in('id', slice);
    }
    const keys = [...new Set(created.keys)];
    if (keys.length) await admin.storage.from(II_STORAGE_BUCKET).remove(keys);
    for (const stamp of created.stamps) {
      const { count } = await admin.from('ii_instruments').select('id', { count: 'exact', head: true }).like('instrument_name', `WPJ ${stamp}%`);
      expect(count ?? 0, 'residual synthetic instruments').toBe(0);
    }
    for (const userId of created.userIds) {
      for (const t of ['ii_source_documents', 'ii_accounts', 'ii_transactions', 'ii_holding_snapshots', 'investments', 'ii_fhip_publications']) {
        const { data } = await admin.from(t).select('id').eq('user_id', userId).limit(1);
        expect(data ?? [], `residue: ${t} for ${userId}`).toEqual([]);
      }
      const { data: authUser } = await admin.auth.admin.getUserById(userId);
      expect(authUser?.user ?? null, `residual auth user ${userId}`).toBeNull();
    }
    evidence.finishedAt = new Date().toISOString();
    const out = path.join(repoRoot, 'docs', 'reviews', 'evidence_wp_j');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, `dev_profile_${RUN_TAG}.json`), JSON.stringify(evidence, null, 2));
  }, 900_000);

  describe('WP-J live DEV profile: where the time goes for a large CAMS statement', () => {
    it('measures the DEV round trip and the scheme universe', async () => {
      const samples: number[] = [];
      for (let i = 0; i < 10; i++) {
        const t0 = performance.now();
        await admin.from('ii_accounts').select('id').limit(1);
        samples.push(performance.now() - t0);
      }
      samples.sort((a, b) => a - b);
      const { count: instruments } = await admin.from('ii_instruments').select('id', { count: 'exact', head: true }).eq('is_active', true);
      const { count: identifiers } = await admin.from('ii_instrument_identifiers').select('id', { count: 'exact', head: true }).eq('is_active', true);
      const { count: aliases } = await admin.from('ii_scheme_alias_map').select('id', { count: 'exact', head: true }).eq('is_active', true);
      evidence.environment = { roundTripMsMedian: Math.round(samples[5]), roundTripMsMin: Math.round(samples[0]), activeInstruments: instruments, activeIdentifiers: identifiers, activeAliases: aliases };
      expect(samples.length).toBe(10);
    }, 120_000);

    for (const size of sizes) {
      it(`${size.positions} positions x ${size.txns} purchases: first processing, replacement reprocess, re-evaluate all, publish`, async () => {
        const { II_STORAGE_BUCKET } = await import('@/lib/services/investment-intelligence/storage');
        const { processSourceDocument, recertifyPosition } = await import('@/lib/services/investment-intelligence/documentProcessing');
        const { replaceSourceDocumentFile } = await import('@/lib/services/investment-intelligence/sourceDocumentReplacement');
        const { publishPosition } = await import('@/lib/services/investment-intelligence/investmentPublicationService');
        const stamp = String(STAMP + size.positions).slice(-6);
        created.stamps.push(stamp);
        const cas = buildWpjLargeCas({ positions: size.positions, txnsPerPosition: size.txns, stamp });
        const makePdf = (label: string) => new Uint8Array(buildMinimalTextPdf([...paginateLines(cas.lines), [`Copy reference ${RUN_TAG} ${label}`]]));
        const { userId, memberId } = await makeUser(`${size.positions}x${size.txns}`);
        const first = makePdf('original');
        const key = `${userId}/${randomUUID()}.pdf`;
        created.keys.push(key);
        const up = await admin.storage.from(II_STORAGE_BUCKET).upload(key, first, { contentType: 'application/pdf', upsert: false });
        if (up.error) throw new Error(`storage upload failed: ${up.error.message}`);
        const { data: doc, error } = await admin
          .from('ii_source_documents')
          .insert({ user_id: userId, owner_member_id: memberId, country_code: 'IN', status: 'uploaded', checksum: createHash('sha256').update(first).digest('hex'), storage_path: key, original_filename: 'large.pdf', mime_type: 'application/pdf', file_size: first.byteLength, document_type: 'cas_statement' })
          .select('id')
          .single();
        if (error || !doc) throw new Error(`could not create the source document: ${error?.message}`);
        const docId = doc.id as string;
        const fixture: Record<string, unknown> = { positions: size.positions, txnsPerPosition: size.txns, transactions: cas.totalTransactions, folios: cas.folios.length, pdfKB: Math.round(first.byteLength / 1024) };

        const firstRun = await timeSection(() => processSourceDocument({ userId, sourceDocumentId: docId }));
        fixture.first_processing = { ok: firstRun.value.ok, status: firstRun.value.status, error: firstRun.value.error, summary: firstRun.value.summary, wallMs: firstRun.wallMs, ...stepsOf(firstRun.reqs), busiest: byTable(firstRun.reqs) };

        const replace = await timeSection(async () => {
          const rep = await replaceSourceDocumentFile({ userId, sourceDocumentId: docId, filename: 'large-copy.pdf', mimeType: 'application/pdf', bytes: makePdf('copy-1'), confirmedDifferences: [] });
          if (rep.ok) {
            const { data: after } = await admin.from('ii_source_documents').select('storage_path').eq('id', docId).single();
            if (after?.storage_path) created.keys.push(after.storage_path as string);
          }
          return rep;
        });
        fixture.replacement_attach = { ok: replace.value.ok, decision: replace.value.ok ? replace.value.identity.decision : null, wallMs: replace.wallMs, requests: replace.reqs.length };

        const reprocess = await timeSection(() => processSourceDocument({ userId, sourceDocumentId: docId, forceReparse: true }));
        fixture.replacement_reprocess = { ok: reprocess.value.ok, status: reprocess.value.status, error: reprocess.value.error, summary: reprocess.value.summary, wallMs: reprocess.wallMs, ...stepsOf(reprocess.reqs), busiest: byTable(reprocess.reqs) };

        const { data: snaps } = await admin.from('ii_holding_snapshots').select('id, account_id, instrument_id').eq('user_id', userId).eq('source_document_id', docId).limit(5000);
        const positions = [...new Map(((snaps ?? []) as { account_id: string; instrument_id: string }[]).map((p) => [`${p.account_id}:${p.instrument_id}`, p] as const)).values()];
        const reeval = await timeSection(async () => {
          let okCount = 0;
          for (const p of positions) {
            const r = await recertifyPosition(userId, p.account_id, p.instrument_id);
            if (r.ok) okCount += 1;
          }
          return okCount;
        });
        fixture.reevaluate_all = { positions: positions.length, ok: reeval.value, wallMs: reeval.wallMs, requests: reeval.reqs.length, msPerPosition: positions.length ? Math.round(reeval.wallMs / positions.length) : null, busiest: byTable(reeval.reqs) };

        const publishSample = ((snaps ?? []) as { id: string }[]).slice(0, 3);
        const pub = await timeSection(async () => {
          const out: unknown[] = [];
          for (const s of publishSample) out.push(await publishPosition(userId, s.id));
          return out;
        });
        fixture.publish_three_positions = { wallMs: pub.wallMs, requests: pub.reqs.length, msPerPosition: publishSample.length ? Math.round(pub.wallMs / publishSample.length) : null };

        (evidence.fixtures as unknown[]).push(fixture);
        expect(firstRun.value.ok, `first processing: ${firstRun.value.error}`).toBe(true);
      }, 3_600_000);
    }
  });
}
