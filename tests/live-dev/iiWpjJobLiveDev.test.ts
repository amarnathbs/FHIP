// Document2 (4) WP-J -- LIVE hosted-DEV certification of the statement JOB: real PDFs, real Storage, real DEV schema, the real worker slicing
// the real pipeline, with a full economic oracle read from the DEV database (project vqycarelcoijzwlpkpcz ONLY).
//
// NEEDS migrations 0312 and 0313 on DEV. Until the Product Owner has applied them (docs/reviews/po_apply_wp_j/02 and 03) this file reports
// NOT PERFORMED and runs nothing. Nothing here can create the tables.
//
// WHAT RUNS FOR REAL: admitStatementJob, advanceStatementJob (claim, slices, checkpoints, staging, settle), the pipeline steps, replaceSourceDocumentFile,
// the CAMS parser, Storage, every constraint and trigger of the DEV schema. WHAT DOES NOT: the HTTP routes and the Premium gate (the services are called
// with the user id), the real malware scan (structural-only mode), the browser, the scheduled backstop (DEV has no public app origin).
//
// SAFETY: DEV only (the project ref is checked). Synthetic users are created WITHOUT a password. Everything created is deleted and re-queried
// for residue, including job rows and staging. Production credentials are never read: only the three DEV variables are taken from the env file.
//
// HOW TO RUN: WPJ_ENV_FILE=<.env.local that points at DEV> WPJ_SIZES=25x12 npx vitest run --config vitest.livedev.config.ts tests/live-dev/iiWpjJobLiveDev.test.ts
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

if (!HAS_ENV) {
  describe('WP-J live DEV job certification', () => {
    it.skip('NOT PERFORMED: no env file (set WPJ_ENV_FILE)', () => {
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
  if (new URL(BASE).host.split('.')[0] !== EXPECTED_DEV_REF) throw new Error('REFUSING TO RUN: this is not the DEV project.');
  process.env.NEXT_PUBLIC_SUPABASE_URL = BASE;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE;
  delete process.env.AIE_REAL_MALWARE_SCAN_ENABLED;

  const admin = createSupabaseJsClient(BASE, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
  h.admin = admin;
  const STAMP = Date.now();
  const RUN_TAG = `wpjjob-${STAMP}`;
  const created: { userIds: string[]; keys: string[]; stamps: string[] } = { userIds: [], keys: [], stamps: [] };
  const evidence: Record<string, unknown> = { project: EXPECTED_DEV_REF, runTag: RUN_TAG, startedAt: new Date().toISOString(), steps: [] as unknown[] };
  const sizes = (process.env.WPJ_SIZES ?? '25x12').split(',').map((s) => {
    const [p, t] = s.trim().split('x').map(Number);
    return { positions: p, txns: t };
  });

  async function tablesPresent(): Promise<boolean> {
    const a = await admin.from('ii_statement_jobs').select('id', { head: true, count: 'exact' }).limit(1);
    const b = await admin.from('ii_document_parse_runs').select('new_transactions_count', { head: true, count: 'exact' }).limit(1);
    return !a.error && !b.error;
  }

  async function makeUser(tag: string) {
    const { data, error } = await admin.auth.admin.createUser({ email: `${RUN_TAG}-${tag}@fhip-synthetic.test`, email_confirm: true });
    if (error || !data.user) throw new Error(`could not create synthetic user ${tag}: ${error?.message}`);
    created.userIds.push(data.user.id);
    const userId = data.user.id;
    await admin.from('user_profiles').upsert({ user_id: userId, country_of_residence: 'IN', preferred_currency: 'INR' }, { onConflict: 'user_id' });
    const { data: hh } = await admin.from('households').insert({ user_id: userId, household_name: `WPJ ${tag}`, primary_country: 'IN' }).select('id').single();
    const { data: mem, error: memErr } = await admin.from('household_members').insert({ user_id: userId, household_id: hh!.id, full_name: 'Asha Rao', relationship: 'self' }).select('id').single();
    if (memErr || !mem) throw new Error(`household member insert failed: ${memErr?.message}`);
    return { userId, memberId: mem.id as string };
  }

  async function count(table: string, userId: string, eq: Record<string, unknown> = {}): Promise<number> {
    let q = admin.from(table).select('id', { count: 'exact', head: true }).eq('user_id', userId);
    for (const [k, v] of Object.entries(eq)) q = q.eq(k, v as never);
    const { count: n, error } = await q;
    if (error) throw new Error(`count ${table}: ${error.message}`);
    return n ?? 0;
  }
  async function oracle(userId: string) {
    // PostgREST caps one response at its max_rows (1000 on DEV), so a plain .limit(20000) silently returned 1000 rows; page explicitly.
    const rows = async (table: string, cols: string) => {
      const all: Array<Record<string, number | string>> = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await admin.from(table).select(cols).eq('user_id', userId).order('id', { ascending: true }).range(from, from + 999);
        if (error) throw new Error(`oracle read of ${table} failed: ${error.message}`);
        const page = (data ?? []) as unknown as Array<Record<string, number | string>>;
        all.push(...page);
        if (page.length < 1000) break;
      }
      return all;
    };
    const sum = (xs: Array<Record<string, number | string>>, k: string) => Math.round(xs.reduce((s, r) => s + Number(r[k] ?? 0), 0) * 100) / 100;
    const txns = await rows('ii_transactions', 'gross_amount, units, status');
    const active = txns.filter((t) => t.status !== 'reversed');
    const snaps = await rows('ii_holding_snapshots', 'units, value');
    return {
      accounts: await count('ii_accounts', userId),
      transactionsActive: active.length,
      transactionsReversed: txns.length - active.length,
      transactionAmountSumActive: sum(active, 'gross_amount'),
      transactionUnitsSumActive: sum(active, 'units'),
      links: await count('ii_transaction_source_links', userId),
      originatingLinks: await count('ii_transaction_source_links', userId, { is_originating: true }),
      holdings: snaps.length,
      holdingValueSum: sum(snaps, 'value'),
      publications: await count('ii_fhip_publications', userId),
      investments: await count('investments', userId),
      truthRows: await count('ii_portfolio_truth_status', userId),
      runsRunning: await count('ii_document_parse_runs', userId, { run_status: 'running' }),
    };
  }

  afterAll(async () => {
    const { II_STORAGE_BUCKET } = await import('@/lib/services/investment-intelligence/storage');
    const insIds: string[] = [];
    for (const stamp of created.stamps) {
      const { data: ins } = await admin.from('ii_instruments').select('id').like('instrument_name', `WPJ ${stamp}%`).limit(5000);
      insIds.push(...(ins ?? []).map((r) => r.id as string));
    }
    for (const userId of created.userIds) {
      for (const t of ['ii_statement_jobs', 'ii_fhip_publications', 'investments', 'ii_reconciliation_cases', 'ii_transaction_source_links', 'ii_transactions', 'ii_holding_snapshots', 'ii_portfolio_truth_status', 'ii_document_parse_runs', 'ii_source_documents', 'ii_accounts']) {
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
    if (created.keys.length) await admin.storage.from(II_STORAGE_BUCKET).remove([...new Set(created.keys)]);
    for (const userId of created.userIds) {
      for (const t of ['ii_source_documents', 'ii_accounts', 'ii_transactions', 'ii_holding_snapshots', 'ii_statement_jobs', 'ii_statement_job_chunks']) {
        const { data } = await admin.from(t).select('id').eq('user_id', userId).limit(1);
        expect(data ?? [], `residue: ${t} for ${userId}`).toEqual([]);
      }
      expect((await admin.auth.admin.getUserById(userId)).data?.user ?? null, `residual auth user ${userId}`).toBeNull();
    }
    evidence.finishedAt = new Date().toISOString();
    const out = path.join(repoRoot, 'docs', 'reviews', 'evidence_wp_j');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, `dev_job_${RUN_TAG}.json`), JSON.stringify(evidence, null, 2));
  }, 900_000);

  describe('WP-J live DEV: the statement job, real PDFs, real storage, real schema', () => {
    it('precondition: migrations 0312 and 0313 are on DEV (otherwise NOT PERFORMED)', async () => {
      const ok = await tablesPresent();
      evidence.preconditionMet = ok;
      if (!ok) {
        evidence.verdict = 'NOT PERFORMED: migrations 0312 / 0313 are not applied on DEV (docs/reviews/po_apply_wp_j/02 and 03).';
        console.warn(String(evidence.verdict));
      }
      expect(typeof ok).toBe('boolean');
    });

    for (const size of sizes) {
      it(`${size.positions} positions x ${size.txns}: job in slices, replacement replays x2, a killed slice resumed, two-user denial, zero residue`, async () => {
        if (!evidence.preconditionMet) return; // NOT PERFORMED (recorded in the evidence file)
        const { II_STORAGE_BUCKET } = await import('@/lib/services/investment-intelligence/storage');
        const { admitStatementJob } = await import('@/lib/services/investment-intelligence/statementJob/admission');
        const { advanceStatementJob, SimulatedSliceKill } = await import('@/lib/services/investment-intelligence/statementJob/worker');
        const { getJobForUser } = await import('@/lib/services/investment-intelligence/statementJob/store');
        const { replaceSourceDocumentFile } = await import('@/lib/services/investment-intelligence/sourceDocumentReplacement');
        const stamp = String(STAMP + size.positions).slice(-6);
        created.stamps.push(stamp);
        const cas = buildWpjLargeCas({ positions: size.positions, txnsPerPosition: size.txns, stamp, omitRefs: true });
        const pdf = (label: string) => new Uint8Array(buildMinimalTextPdf([...paginateLines(cas.lines), [`Copy reference ${RUN_TAG} ${label}`]]));
        const { userId, memberId } = await makeUser(`${size.positions}x${size.txns}`);
        const other = await makeUser(`other-${size.positions}x${size.txns}`);
        const first = pdf('original');
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
        const step: Record<string, unknown> = { positions: size.positions, transactions: cas.totalTransactions };

        async function drive(jobId: string, budget = 17000, fault?: (p: string) => void) {
          let slices = 0;
          const t0 = Date.now();
          let slowest = 0;
          for (;;) {
            const s0 = Date.now();
            const out = await advanceStatementJob(jobId, { userId, sliceBudgetMs: budget, fault });
            slowest = Math.max(slowest, Date.now() - s0);
            if (out.kind === 'not_found') throw new Error('job not found');
            if (out.kind === 'advanced') slices += 1;
            if (out.job.status !== 'queued' && out.job.status !== 'processing') return { slices, job: out.job, wallMs: Date.now() - t0, slowestSliceMs: slowest };
            if (slices > 400) throw new Error('did not finish');
          }
        }

        // 1. first processing as a job
        const a = await admitStatementJob({ userId, documentId: docId, kind: 'process' });
        if (a.kind !== 'job') throw new Error(`expected a job, got ${a.kind}`);
        const run1 = await drive(a.job.id);
        expect(run1.job.status, JSON.stringify(run1.job.result_summary)).toBe('completed');
        const o1 = await oracle(userId);
        step.first = { slices: run1.slices, wallMs: run1.wallMs, slowestSliceMs: run1.slowestSliceMs, oracle: o1 };
        expect(o1).toMatchObject({ accounts: cas.folios.length, transactionsActive: cas.totalTransactions, holdings: size.positions, truthRows: size.positions, runsRunning: 0 });

        // 2. two replacement copies, each reprocessed as a job: the oracle never moves
        for (const label of ['copy-1', 'copy-2']) {
          const rep = await replaceSourceDocumentFile({ userId, sourceDocumentId: docId, filename: `${label}.pdf`, mimeType: 'application/pdf', bytes: pdf(label), confirmedDifferences: [] });
          expect(rep.ok, JSON.stringify(rep)).toBe(true);
          const { data: after } = await admin.from('ii_source_documents').select('storage_path').eq('id', docId).single();
          if (after?.storage_path) created.keys.push(after.storage_path as string);
          const r = await admitStatementJob({ userId, documentId: docId, kind: 'process', forceReparse: true });
          if (r.kind !== 'job') throw new Error(`expected a job, got ${r.kind}`);
          const run = await drive(r.job.id);
          expect(run.job.status, JSON.stringify(run.job.result_summary)).toBe('completed');
          const o = await oracle(userId);
          (step[label] as unknown) = { slices: run.slices, wallMs: run.wallMs, slowestSliceMs: run.slowestSliceMs, oracle: o };
          expect({ ...o, runsRunning: 0 }, `economics changed after ${label}`).toEqual({ ...o1, runsRunning: 0 });
        }

        // 3. a killed slice, resumed after its lease ran out
        const rep = await replaceSourceDocumentFile({ userId, sourceDocumentId: docId, filename: 'copy-3.pdf', mimeType: 'application/pdf', bytes: pdf('copy-3'), confirmedDifferences: [] });
        expect(rep.ok).toBe(true);
        const { data: after3 } = await admin.from('ii_source_documents').select('storage_path').eq('id', docId).single();
        if (after3?.storage_path) created.keys.push(after3.storage_path as string);
        const k = await admitStatementJob({ userId, documentId: docId, kind: 'process', forceReparse: true });
        if (k.kind !== 'job') throw new Error('expected a job');
        let killed = false;
        const killAtSchemes = (p: string) => {
          if (!killed && p === 'schemes:written') {
            killed = true;
            throw new SimulatedSliceKill(p);
          }
        };
        try {
          // one unit per slice until the hook fires
          for (let i = 0; i < 60 && !killed; i++) await advanceStatementJob(k.job.id, { userId, sliceBudgetMs: 0, fault: killAtSchemes });
        } catch (e) {
          if (!(e instanceof SimulatedSliceKill)) throw e;
        }
        expect(killed).toBe(true);
        await admin.from('ii_statement_jobs').update({ lease_expires_at: new Date(Date.now() - 1000).toISOString() }).eq('id', k.job.id);
        const resumed = await drive(k.job.id);
        expect(resumed.job.status).toBe('completed');
        const ok3 = await oracle(userId);
        expect({ ...ok3, runsRunning: 0 }, 'economics changed after a killed and resumed run').toEqual({ ...o1, runsRunning: 0 });
        expect((await getJobForUser(userId, k.job.id))!.reclaim_count).toBeGreaterThanOrEqual(1);
        step.killedAndResumed = { oracle: ok3 };

        // 4. two-user denial and zero staging
        expect(await getJobForUser(other.userId, k.job.id)).toBeNull();
        expect((await advanceStatementJob(k.job.id, { userId: other.userId })).kind).toBe('not_found');
        const stolen = await admitStatementJob({ userId: other.userId, documentId: docId, kind: 'process' });
        expect(stolen.kind === 'answer' && stolen.result.status).toBe('not_found');
        expect(await count('ii_statement_job_chunks', userId)).toBe(0);
        (evidence.steps as unknown[]).push(step);
      }, 3_600_000);
    }
  });
}
