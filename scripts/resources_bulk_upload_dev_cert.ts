/* eslint-disable @typescript-eslint/no-explicit-any -- live HTTP harness: response bodies are untyped JSON */
/**
 * Resources Bulk Upload (Articles + Money Updates) -- LIVE DEV certification over HTTP.
 *
 * Drives the REAL authenticated Admin routes of a running dev server (pointed at DEV, project vqycarelcoijzwlpkpcz) with
 * real Supabase sessions for SYNTHETIC users, then verifies the resulting rows directly. Nothing real is imported:
 * every file, category, tag, author, CTA, source and user is synthetic and prefixed with the run tag. Full cleanup and a
 * zero-residue re-check run at the end (also on failure).
 *
 * Run (server up on the given port, migration 0272 applied on DEV):
 *   npx tsx scripts/resources_bulk_upload_dev_cert.ts http://localhost:3993
 *
 * HARD GUARDS: refuses to run unless the Supabase URL is the DEV project; never reads or uses any production variable.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { ARTICLE_SCHEMA } from '../lib/resources/import/article/schema';
import { MONEY_UPDATE_SCHEMA } from '../lib/resources/import/money-update/schema';
import { IMPORT_LIMITS } from '../lib/resources/import/types';
import { stripUnusedBinContentType } from '../lib/resources/import/xlsx-sanitize';
import { fixtureSession, maskEmail, restoreBorrowedProfiles } from './lib/resourcesBulkFixtureSessions';

const CAP = IMPORT_LIMITS.maxRows;
const APP = process.argv[2] ?? 'http://localhost:3993';
const ROOT = path.resolve(__dirname, '..');
function env(name: string): string {
  if (process.env[name]) return process.env[name] as string;
  const raw = fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').replace(/^﻿/, '');
  for (const l of raw.split(/\r?\n/)) if (l.startsWith(`${name}=`)) return l.slice(name.length + 1).trim();
  throw new Error(`missing ${name}`);
}
const URL_ = env('NEXT_PUBLIC_SUPABASE_URL');
if (!URL_.includes('vqycarelcoijzwlpkpcz') || URL_.includes('twwpnltizhtjxhamyoxt')) throw new Error('REFUSING: not the DEV project');
const ANON = env('NEXT_PUBLIC_SUPABASE_ANON_KEY');
const SERVICE = env('SUPABASE_SERVICE_ROLE_KEY');
const REF = new URL(URL_).host.split('.')[0];
const RUN = `bulkrecert${Date.now().toString(36)}`;
const admin: SupabaseClient = createClient(URL_, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } });

// ------------------------------------------------------------------ check framework
type Result = { name: string; pass: boolean; detail?: string };
const results: Result[] = [];
const evidence: Record<string, unknown> = { run: RUN, app: APP, startedAt: new Date().toISOString() };
function check(name: string, pass: boolean, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail && !pass ? `  -- ${detail}` : ''}`);
}

// ------------------------------------------------------------------ users and HTTP
interface TestUser { id: string; email: string; label: string; cookie: string }
const users: Record<string, TestUser> = {};
/** Existing fixture users used in this run (ids only). Nothing about them is created, edited or deleted. */
const fixtureIds = new Set<string>();
const STARTED_AT = new Date().toISOString();

type Want = { kind: 'role'; role: string } | { kind: 'superAdmin' } | { kind: 'customer' };
async function makeUser(label: string, want: Want): Promise<TestUser> {
  const s = await fixtureSession(admin, ANON, URL_, REF, label, want, fixtureIds);
  console.log(`fixture ${label}: ${maskEmail(s.email)}`);
  return { id: s.id, email: s.email, label, cookie: s.cookie };
}

interface Api { status: number; json: any; text: string; ms: number; bytes: number; headers: Headers }
async function api(user: TestUser | null, method: string, p: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<Api> {
  const headers: Record<string, string> = { ...extraHeaders };
  if (user) headers.cookie = user.cookie;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const t = Date.now();
  const res = await fetch(`${APP}${p}`, { method, headers, body: payload, redirect: 'manual' });
  const text = await res.text();
  const ms = Date.now() - t;
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, ms, bytes: Buffer.byteLength(text), headers: res.headers };
}

// ------------------------------------------------------------------ files
const ARTICLE_COLS = ARTICLE_SCHEMA.columns.map((c) => c.key);
const MU_COLS = MONEY_UPDATE_SCHEMA.columns.map((c) => c.key);
type Row = Record<string, string>;
const fx: { cat: string; catSlug: string; tag1: string; tag2: string; author: string; authorSlug: string; cta: string; ctaId: string } = { cat: '', catSlug: '', tag1: '', tag2: '', author: '', authorSlug: '', cta: '', ctaId: '' };

function articleRow(i: number, over: Row = {}): Row {
  return {
    template_version: '1.0', external_id: `${RUN}-A${i}`, title: `Synthetic ${RUN} article ${i}`, slug: `${RUN}-article-${i}`, jurisdiction: 'australia', difficulty: 'beginner', compliance_classification: 'green',
    freshness_type: 'evergreen', next_review_at: '2027-03-31', expires_at: '', excerpt: `Synthetic excerpt ${i} for ${RUN}.`,
    quick_answer: `Quick answer ${i}.`, key_takeaways: 'Takeaway one\nTakeaway two\nTakeaway three',
    main_content: '## First heading\n\nParagraph one for the golden fixture.\n\n### Sub heading\n\n- bullet a\n- bullet b\n\n## Second heading\n\n1. step one\n2. step two\n\nA closing paragraph.',
    example: 'A worked example with $100.', financial_health_meaning: 'This matters for savings.\n\nAnd for resilience.',
    primary_category: fx.catSlug, tags: `${fx.tag1}|${fx.tag2}`, author: fx.authorSlug, primary_cta: fx.cta, secondary_cta: '', seo_title: '', seo_description: '', is_indexable: 'FALSE',
    source_1_name: `${RUN} Source A`, source_1_document_title: 'Doc A', source_1_url: `https://example.com/${RUN}/a`, source_1_type: 'regulator', source_1_publication_date: '2026-08-12', source_1_is_public: 'TRUE',
    ...over,
  };
}
function muRow(i: number, over: Row = {}): Row {
  return {
    template_version: '1.0', external_id: `${RUN}-M${i}`, title: `Synthetic ${RUN} money update ${i}`, slug: `${RUN}-mu-${i}`, jurisdiction: 'india', difficulty: 'beginner', compliance_classification: 'amber',
    event_date: '2026-09-30', next_review_at: '2026-12-31', expires_at: '', affected_audience: 'Synthetic audience', excerpt: `Synthetic update excerpt ${i}.`,
    what_happened: 'It happened.', why_it_matters: 'It matters.', who_may_be_affected: 'Some people.\n\n- group a\n- group b', financial_health_impact: 'It affects health.', how_fhip_can_help: 'FHIP can help.',
    primary_category: fx.catSlug, tags: fx.tag1, primary_cta: '', secondary_cta: '', seo_title: '', seo_description: '', is_indexable: '',
    source_1_name: `${RUN} Source M`, source_1_document_title: 'Doc M', source_1_url: `https://example.com/${RUN}/m`, source_1_type: 'regulator', source_1_publication_date: '2026-09-30', source_1_is_public: 'TRUE',
    ...over,
  };
}
const colsOf = (t: 'article' | 'money_update') => (t === 'article' ? ARTICLE_COLS : MU_COLS);
function csvBytes(t: 'article' | 'money_update', rows: Row[], extraCols: Row = {}): Buffer {
  const cols = [...colsOf(t), ...Object.keys(extraCols)];
  const q = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);
  return Buffer.from([cols.join(','), ...rows.map((r) => cols.map((c) => q({ ...r, ...extraCols }[c] ?? '')).join(','))].join('\r\n') + '\r\n', 'utf8');
}
/** Fill the DOWNLOADED template workbook (so the round trip really starts from the template) and return the bytes. */
function fillTemplate(templateBytes: Buffer, t: 'article' | 'money_update', rows: Row[]): Buffer {
  const wb = XLSX.read(templateBytes, { type: 'buffer' });
  const sheetName = t === 'article' ? 'Article_Upload' : 'Money_Update_Upload';
  const cols = colsOf(t);
  const aoa = [cols, ...rows.map((r) => cols.map((c) => r[c] ?? ''))];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  for (const addr of Object.keys(ws)) if (!addr.startsWith('!') && typeof (ws[addr] as any).v === 'string') (ws[addr] as any).t = 's';
  wb.Sheets[sheetName] = ws;
  // Re-saving through the writer re-adds the unused .bin default that Excel itself never writes: sanitise like the template generator.
  return Buffer.from(stripUnusedBinContentType(new Uint8Array(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))));
}
async function upload(user: TestUser | null, type: 'article' | 'money_update', name: string, bytes: Buffer, mime = '', sheetName?: string): Promise<Api> {
  const f = new FormData();
  f.set('contentType', type);
  f.set('file', new File([new Uint8Array(bytes)], name, { type: mime }));
  // Shared ingest convention: for a workbook the operator CHOOSES the sheet (the UI preselects the template's).
  if (name.toLowerCase().endsWith('.xlsx')) f.set('sheetName', sheetName ?? (type === 'article' ? 'Article_Upload' : 'Money_Update_Upload'));
  return api(user, 'POST', '/api/admin/resources/import/runs', f);
}

// ------------------------------------------------------------------ db helpers
async function postsBySlugPrefix(prefix: string) {
  const { data } = await admin.from('resource_posts').select('id, slug, status, visibility, is_indexable, content_type, created_by, title, excerpt, content_blocks, primary_category_id, author_id, event_date, affected_audience, freshness_type, compliance_classification, content_id').like('slug', `${prefix}%`).limit(2000);
  return data ?? [];
}
async function countPosts(): Promise<number> {
  const { count } = await admin.from('resource_posts').select('id', { count: 'exact', head: true }).like('slug', `${RUN}%`);
  return count ?? 0;
}
async function deleteRunPosts() {
  const posts = await postsBySlugPrefix(RUN);
  const ids = posts.map((p) => p.id);
  for (let i = 0; i < ids.length; i += 100) await admin.from('resource_posts').delete().in('id', ids.slice(i, i + 100));
}

// ------------------------------------------------------------------ scale (1 / 50 / 100 / cap rows, both adapters)
async function scaleRun(E: TestUser, sizes: number[]): Promise<unknown[]> {
  const scale: unknown[] = [];
  for (const type of ['article', 'money_update'] as const) {
    for (const n of sizes) {
      const rows = Array.from({ length: n }, (_, i) => (type === 'article' ? articleRow(10000 + n * 10 + i) : muRow(20000 + n * 10 + i)));
      const f = csvBytes(type, rows);
      const u = await upload(E, type, `scale_${type}_${n}.csv`, f, 'text/csv');
      const m = u.json?.data?.metrics ?? {};
      let ap = await api(E, 'POST', `/api/admin/resources/import/runs/${u.json?.data?.runId}/apply`);
      let timeoutPath: unknown = null;
      if (ap.status === 503) {
        // the graceful database-time-limit path: plain message, nothing created, run still ready, a retry is safe
        const first = ap;
        const stat = await api(E, 'GET', `/api/admin/resources/import/runs/${u.json?.data?.runId}`);
        const created0 = await countPosts();
        ap = await api(E, 'POST', `/api/admin/resources/import/runs/${u.json?.data?.runId}/apply`);
        timeoutPath = { firstStatus: first.status, firstMessage: first.json?.error, runStatusAfter: stat.json?.data?.run?.status, postsCreatedByFirst: created0, retryStatus: ap.status, retryCreated: ap.json?.data?.created, retryMs: ap.ms };
        check(`G TIMEOUT PATH ${type} ${n}: first apply hit the time limit: plain message, nothing created, run still ready; the retry is safe (no duplicates whatever its outcome)`, first.json?.error?.startsWith('Nothing was created.') === true && stat.json?.data?.run?.status === 'ready' && (await countPosts()) - created0 === (ap.status === 200 ? n : 0), JSON.stringify(timeoutPath));
      }
      const pv = await api(E, 'GET', `/api/admin/resources/import/runs/${u.json?.data?.runId}`);
      scale.push({ type, rows: n, fileBytes: f.length, uploadTotalMs: u.ms, parseMs: m.parseMs, resolveMs: m.resolveMs, validateMs: m.validateMs, stageMs: m.stageMs, dbQueriesDuringUpload: m.dbQueries, uploadResponseBytes: u.bytes, previewResponseBytes: pv.bytes, applyMs: ap.ms, applyResponseBytes: ap.bytes, timeoutPath, applyHttp: ap.status, applyCode: ap.json?.code ?? null, applyError: ap.json?.error ?? null, created: ap.json?.data?.created });
      check(`G scale ${type} ${n} rows: upload ok, apply created ${n}`, u.json?.data?.status === 'ready' && ap.json?.data?.created === n, `${u.status} apply ${ap.status} ${ap.json?.code ?? ''} ${ap.json?.error ?? ''}`);
    }
  }
  return scale;
}

// ------------------------------------------------------------------ the run
async function main() {
  console.log(`Resources Bulk Upload DEV certification, run ${RUN}, app ${APP}`);
  // ---- fixtures
  const cat = await admin.from('resource_categories').insert({ name: `${RUN} Category`, slug: `${RUN}-cat` }).select('id').single();
  fx.cat = cat.data!.id; fx.catSlug = `${RUN}-cat`;
  const t1 = await admin.from('resource_tags').insert({ name: `${RUN} Tag One`, slug: `${RUN}-tag-one` }).select('id').single();
  const t2 = await admin.from('resource_tags').insert({ name: `${RUN} Tag Two`, slug: `${RUN}-tag-two` }).select('id').single();
  fx.tag1 = `${RUN}-tag-one`; fx.tag2 = `${RUN}-tag-two`;
  const au = await admin.from('resource_authors').insert({ display_name: `${RUN} Author`, slug: `${RUN}-author` }).select('id').single();
  fx.author = au.data!.id; fx.authorSlug = `${RUN}-author`;
  const cta = await admin.from('resource_ctas').insert({ name: `${RUN} CTA`, label: 'Synthetic', destination_type: 'fhip_module', destination_url: '/dashboard' }).select('id').single();
  fx.cta = `${RUN} CTA`; fx.ctaId = cta.data!.id;
  void t1; void t2;

  users.superAdmin = await makeUser('super', { kind: 'superAdmin' });
  users.radmin = await makeUser('radmin', { kind: 'role', role: 'resource_admin' });
  users.editor = await makeUser('editor', { kind: 'role', role: 'editor' });
  users.editor2 = await makeUser('editor2', { kind: 'role', role: 'editor' });
  users.author = await makeUser('author', { kind: 'role', role: 'author' });
  users.compliance = await makeUser('compliance', { kind: 'role', role: 'compliance_reviewer' });
  users.publisher = await makeUser('publisher', { kind: 'role', role: 'publisher' });
  users.analyst = await makeUser('analyst', { kind: 'role', role: 'analyst' });
  users.customer = await makeUser('customer', { kind: 'customer' });
  const E = users.editor;

  // ============================================================ A. templates (4 downloads) + access
  const tpl: Record<string, Buffer> = {};
  for (const type of ['article', 'money_update'] as const) {
    for (const format of ['xlsx', 'csv'] as const) {
      const r = await fetch(`${APP}/api/admin/resources/import/templates?type=${type}&format=${format}`, { headers: { cookie: E.cookie } });
      const buf = Buffer.from(await r.arrayBuffer());
      tpl[`${type}.${format}`] = buf;
      const base = type === 'article' ? 'FHIP_Article_Upload_Template_v1' : 'FHIP_Money_Update_Upload_Template_v1';
      check(`A template ${type}.${format}: 200 with the right file name`, r.status === 200 && (r.headers.get('content-disposition') ?? '').includes(`${base}.${format}`), `status ${r.status}`);
      const cols = colsOf(type);
      if (format === 'csv') check(`A template ${type}.csv: header equals the parser schema`, buf.toString('utf8').replace(/^﻿/, '').split(/\r?\n/)[0] === cols.join(','));
      else {
        const wb = XLSX.read(buf, { type: 'buffer' });
        const up = type === 'article' ? 'Article_Upload' : 'Money_Update_Upload';
        const ex = type === 'article' ? 'Example_Article' : 'Example_Money_Update';
        check(`A template ${type}.xlsx: four sheets, upload header equals the schema`, JSON.stringify(wb.SheetNames) === JSON.stringify(['Instructions', up, 'Lookup_Values', ex]) && JSON.stringify((XLSX.utils.sheet_to_json(wb.Sheets[up], { header: 1 })[0] as string[])) === JSON.stringify(cols));
        const lk = JSON.stringify(XLSX.utils.sheet_to_json(wb.Sheets.Lookup_Values, { header: 1 }));
        check(`A template ${type}.xlsx: Lookup_Values lists live reference data (synthetic category present)`, lk.includes(fx.catSlug));
      }
    }
  }
  for (const [label, u, want] of [['anonymous', null, 401], ['customer', users.customer, 403], ['analyst', users.analyst, 403], ['publisher', users.publisher, 403], ['compliance', users.compliance, 403], ['author', users.author, 200]] as const) {
    const r = await api(u, 'GET', '/api/admin/resources/import/templates?type=article&format=csv');
    check(`A template access: ${label} -> ${want}`, r.status === want, `got ${r.status}`);
  }

  if (process.env.CERT_PHASE === 'pre') {
    // Before migration 0272 is applied: only the parts that need no schema (templates, pages degrade gracefully, nav capability).
    for (const [label, u] of [['editor', E], ['resource admin', users.radmin], ['super admin', users.superAdmin]] as const) {
      const pr = await fetch(`${APP}/admin/resources/import`, { headers: { cookie: u.cookie }, redirect: 'manual' });
      const html = await pr.text();
      check(`PRE page /admin/resources/import renders for ${label} (200, chooser, history degrades gracefully)`, pr.status === 200 && html.includes('What would you like to upload?'), `${pr.status}`);
    }
    const up = await fetch(`${APP}/admin/resources/import/upload?type=article`, { headers: { cookie: E.cookie }, redirect: 'manual' });
    check('PRE page upload?type=article renders for the editor', up.status === 200, `${up.status}`);
    const navMe = await api(E, 'GET', '/api/admin/me');
    check('PRE nav capability for editor', navMe.json?.data?.capabilities?.resourceContentBulkImport === true);
    const cm = await fetch(`${APP}/admin/resources/money-updates`, { headers: { cookie: E.cookie } });
    const cmHtml = await cm.text();
    check('PRE Money Updates page shows the contextual Upload Updates and Download Template buttons', cm.status === 200 && cmHtml.includes('Upload Updates') && cmHtml.includes('Download Template'));
    const ac = await fetch(`${APP}/admin/resources/content`, { headers: { cookie: E.cookie } });
    check('PRE All Content page renders for the editor', ac.status === 200);
    return;
  }

  if (process.env.CERT_PHASE === 'timing') {
    // 0274 verification + timing: >= 5 runs of cap rows per type, then 2 CONCURRENT runs of different run ids per type.
    const stats = (xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b);
      return { n: s.length, min: s[0], median: s[Math.floor(s.length / 2)], max: s[s.length - 1], all: xs };
    };
    // behavioural verification of 0274 (db_ms present, no version rows, forced values, planned ids, wrapper + twin, idempotent)
    const vrun = await upload(E, 'article', 'verify0274.csv', csvBytes('article', [articleRow(70001), articleRow(70002)]), 'text/csv');
    const vid = vrun.json?.data?.runId as string;
    const planned = await admin.from('resource_content_import_rows').select('row_number, planned_post_id').eq('import_run_id', vid).order('row_number');
    check('0274 VERIFY the server assigns planned post ids when staging', (planned.data ?? []).length === 2 && (planned.data ?? []).every((r: any) => !!r.planned_post_id));
    const tok = JSON.parse(Buffer.from(E.cookie.split('=').slice(1).join('=').replace(/^base64-/, '').split(';')[0], 'base64url').toString());
    const userDb = createClient(URL_, ANON, { global: { headers: { Authorization: `Bearer ${tok.access_token}` } }, auth: { autoRefreshToken: false, persistSession: false } });
    const w = await userDb.rpc('apply_resource_content_import', { p_run_id: vid });
    check('0274 VERIFY the signed-in wrapper applies through the new core (created 2, db_ms reported)', !w.error && w.data?.created === 2 && typeof w.data?.db_ms === 'number', JSON.stringify(w.error ?? w.data).slice(0, 200));
    const w2 = await userDb.rpc('apply_resource_content_import', { p_run_id: vid });
    check('0274 VERIFY second apply is idempotent', !w2.error && w2.data?.already_applied === true && (await countPosts()) === 2);
    const vposts = await postsBySlugPrefix(`${RUN}-article-7000`);
    check('0274 VERIFY forced values, planned ids used as post ids, no per-post version rows', vposts.length === 2 && vposts.every((p) => p.status === 'draft' && p.visibility === 'private' && p.is_indexable === false && p.content_type === 'article') && vposts.map((p) => p.id).sort().join() === (planned.data ?? []).map((r: any) => r.planned_post_id).sort().join() && ((await admin.from('resource_post_versions').select('id', { count: 'exact', head: true }).in('post_id', vposts.map((p) => p.id))).count ?? -1) === 0);
    const twinRun = await upload(E, 'money_update', 'verify0274b.csv', csvBytes('money_update', [muRow(70003)]), 'text/csv');
    const tw = await api(E, 'POST', `/api/admin/resources/import/runs/${twinRun.json?.data?.runId}/apply`);
    check('0274 VERIFY the route (service-role twin) applies and reports dbMs', tw.status === 200 && tw.json?.data?.created === 1 && typeof tw.json?.data?.dbMs === 'number', JSON.stringify(tw.json).slice(0, 200));
    await deleteRunPosts();

    const timing: Record<string, unknown> = {};
    for (const type of ['article', 'money_update'] as const) {
      const db: number[] = [];
      const client: number[] = [];
      for (let k = 0; k < 5; k++) {
        const rows = Array.from({ length: CAP }, (_, i) => (type === 'article' ? articleRow(80000 + k * 1000 + i) : muRow(80000 + k * 1000 + i)));
        const u = await upload(E, type, `timing_${type}_${k}.csv`, csvBytes(type, rows), 'text/csv');
        const ap = await api(E, 'POST', `/api/admin/resources/import/runs/${u.json?.data?.runId}/apply`);
        const ok = ap.status === 200 && ap.json?.data?.created === CAP;
        check(`TIMING ${type} ${CAP} rows run ${k + 1}: applied (db_ms ${ap.json?.data?.dbMs}, client ${ap.ms} ms)`, ok, `${ap.status} ${ap.json?.code ?? ''}`);
        if (ok) {
          db.push(ap.json.data.dbMs);
          client.push(ap.ms);
        }
        await deleteRunPosts();
      }
      // two concurrent runs of DIFFERENT run ids
      const mk = async (tag: number) => {
        const rows = Array.from({ length: CAP }, (_, i) => (type === 'article' ? articleRow(90000 + tag * 1000 + i) : muRow(90000 + tag * 1000 + i)));
        return (await upload(E, type, `timing_${type}_c${tag}.csv`, csvBytes(type, rows), 'text/csv')).json?.data?.runId as string;
      };
      const [r1, r2] = [await mk(1), await mk(2)];
      const par = await Promise.all([r1, r2].map((r) => api(E, 'POST', `/api/admin/resources/import/runs/${r}/apply`)));
      const bothOk = par.every((r) => r.status === 200 && r.json?.data?.created === CAP);
      check(`TIMING ${type} two CONCURRENT ${CAP}-row runs (different run ids): both applied (db_ms ${par.map((r) => r.json?.data?.dbMs)}, client ${par.map((r) => r.ms)} ms)`, bothOk && (await countPosts()) === 2 * CAP, par.map((r) => `${r.status} ${r.json?.code ?? ''}`).join(' '));
      timing[type] = { dbMs: stats(db), clientMs: stats(client), concurrent: par.map((r) => ({ status: r.status, dbMs: r.json?.data?.dbMs ?? null, clientMs: r.ms })) };
      await deleteRunPosts();
    }
    evidence.timingCap = timing;
    console.log(JSON.stringify(timing));
    return;
  }

  if (process.env.CERT_PHASE === 'same') {
    for (const k of [6, 4]) {
      const cRows = Array.from({ length: CAP }, (_, i) => articleRow(40000 + k * 1000 + i));
      const cu = await upload(E, 'article', 'same'+k+'.csv', csvBytes('article', cRows), 'text/csv');
      const cid = cu.json?.data?.runId;
      const par = await Promise.all(Array.from({ length: k }, () => api(E, 'POST', `/api/admin/resources/import/runs/${cid}/apply`)));
      console.log('SAME-RUN x'+k, JSON.stringify(par.map((r) => ({ s: r.status, already: r.json?.data?.alreadyApplied, db: r.json?.data?.dbMs, ms: r.ms }))), 'posts', await countPosts());
      await deleteRunPosts();
    }
    return;
  }

  if (process.env.CERT_PHASE === 'big') {
    // 0273 follow-up: only the two capped-size cases, the concurrency probe and cleanup.
    evidence.scaleCap = await scaleRun(E, [CAP]);
    const cRows = Array.from({ length: CAP }, (_, i) => articleRow(30000 + i));
    const cu = await upload(E, 'article', 'concurrent500.csv', csvBytes('article', cRows), 'text/csv');
    const cid = cu.json?.data?.runId;
    const cb = await countPosts();
    const par = await Promise.all(Array.from({ length: 6 }, () => api(E, 'POST', `/api/admin/resources/import/runs/${cid}/apply`)));
    const effective = par.filter((r) => r.status === 200 && r.json?.data?.alreadyApplied === false).length;
    evidence.concurrentApplyCap = par.map((r) => ({ status: r.status, already: r.json?.data?.alreadyApplied, created: r.json?.data?.created, ms: r.ms, code: r.json?.code }));
    check('BIG concurrent apply of a capped-size run (6 parallel requests): exactly one effect, the full row count created once, no duplicates', effective === 1 && (await countPosts()) - cb === CAP && par.every((r) => r.status === 200), JSON.stringify(evidence.concurrentApplyCap));
    return;
  }

  // ============================================================ B. Article golden XLSX round trip
  const before0 = await countPosts();
  const golden = articleRow(1);
  const up1 = await upload(E, 'article', 'golden_articles.xlsx', fillTemplate(tpl['article.xlsx'], 'article', [golden, articleRow(2)]));
  check('B article xlsx: upload -> preview ready (2 rows, 0 errors)', up1.status === 200 && up1.json?.data?.status === 'ready' && up1.json.data.summary.rowCount === 2 && up1.json.data.summary.errorCount === 0, JSON.stringify(up1.json).slice(0, 300));
  const run1 = up1.json?.data?.runId as string;
  check('B nothing is created by upload/preview (canonical writes = 0)', (await countPosts()) === before0);
  const runView = await api(E, 'GET', `/api/admin/resources/import/runs/${run1}`);
  check('B preview run + rows load; summary ready', runView.status === 200 && runView.json.data.run.status === 'ready' && runView.json.data.rows.length === 2);
  const rowDetail = await api(E, 'GET', `/api/admin/resources/import/runs/${run1}/rows/2`);
  const pl = rowDetail.json?.data?.row?.normalized_payload;
  check('B row detail shows staged blocks, category, author, source', rowDetail.status === 200 && Array.isArray(pl?.content_blocks) && pl.content_blocks.length >= 10 && pl.sources?.length === 1);
  const apply1 = await api(E, 'POST', `/api/admin/resources/import/runs/${run1}/apply`);
  check('B apply: 2 created', apply1.status === 200 && apply1.json?.data?.created === 2 && apply1.json.data.alreadyApplied === false, JSON.stringify(apply1.json).slice(0, 300));
  const gp = (await postsBySlugPrefix(`${RUN}-article-1`)).find((p) => p.slug === `${RUN}-article-1`)!;
  const blocks = (gp?.content_blocks ?? []) as { type: string; data: any }[];
  check('B golden: content_type article, status draft, visibility private, not indexable, creator = editor', gp?.content_type === 'article' && gp.status === 'draft' && gp.visibility === 'private' && gp.is_indexable === false && gp.created_by === E.id);
  check('B golden: title, excerpt, callout, 3 takeaways, 3 H2 (incl. financial health), 1 H3, lists, example', gp?.title === golden.title && gp.excerpt === golden.excerpt && blocks[0]?.type === 'callout' && blocks[1]?.data?.items?.length === 3 && blocks.filter((b) => b.type === 'heading' && b.data.level === 2).length === 3 && blocks.filter((b) => b.type === 'heading' && b.data.level === 3).length === 1 && blocks.some((b) => b.type === 'bulleted_list') && blocks.some((b) => b.type === 'numbered_list') && blocks.some((b) => b.type === 'example'));
  const fhIdx = blocks.findIndex((b) => b.type === 'heading' && b.data.text === 'What this means for your financial health');
  check('B golden: financial-health section = H2 + 2 paragraphs', fhIdx > 0 && blocks.slice(fhIdx + 1).length === 2);
  check('B golden: category, author', gp?.primary_category_id === fx.cat && gp.author_id === fx.author);
  const tagLinks = await admin.from('resource_post_tags').select('tag_id').eq('post_id', gp.id);
  const srcLinks = await admin.from('resource_post_sources').select('source_id, source:resource_sources!source_id(source_name,url,created_by)').eq('post_id', gp.id);
  check('B golden: 2 tags, 1 source (created by the importer, https link)', (tagLinks.data ?? []).length === 2 && (srcLinks.data ?? []).length === 1 && (srcLinks.data as any)[0].source.url === `https://example.com/${RUN}/a`);
  const ctaOk = await admin.from('resource_posts').select('primary_cta_id, seo_title, seo_description').eq('id', gp.id).single();
  check('B golden: CTA resolved, SEO blank (normal fallback)', ctaOk.data?.primary_cta_id === fx.ctaId && ctaOk.data.seo_title === null && ctaOk.data.seo_description === null);
  const audit = await admin.from('resource_audit_log').select('metadata').eq('entity_id', gp.id).eq('action', 'created');
  check('B audit: created_via=bulk_import with run id, row number, external id', (audit.data ?? []).length === 1 && (audit.data as any)[0].metadata.created_via === 'bulk_import' && (audit.data as any)[0].metadata.import_run_id === run1 && (audit.data as any)[0].metadata.external_id === golden.external_id);
  const again = await api(E, 'POST', `/api/admin/resources/import/runs/${run1}/apply`);
  check('B second apply of the same run: no new posts (idempotent)', again.status === 200 && again.json?.data?.alreadyApplied === true && (await countPosts()) === before0 + 2);
  const reUp = await upload(E, 'article', 'golden_articles.xlsx', fillTemplate(tpl['article.xlsx'], 'article', [golden, articleRow(2)]));
  evidence.sameFileReupload = { status: reUp.status, code: reUp.json?.code };
  check('B same-file re-upload: refused FILE_ALREADY_APPLIED, 0 additional posts', reUp.status === 422 && reUp.json?.code === 'FILE_ALREADY_APPLIED' && (await countPosts()) === before0 + 2);

  // ---- normal editor round trip
  const ed = await api(E, 'GET', `/api/admin/resources/content/${gp.id}`);
  const post = ed.json?.data?.post;
  check('B editor: imported article opens in the NORMAL editor API', ed.status === 200 && post?.title === golden.title);
  const newBlocks = JSON.parse(JSON.stringify(post.content_blocks));
  const firstPara = newBlocks.find((b: any) => b.type === 'paragraph');
  firstPara.data.text = 'EDITED paragraph text.';
  const patch = await api(E, 'PATCH', `/api/admin/resources/content/${gp.id}`, {
    patch: { title: post.title, slug: post.slug, excerpt: post.excerpt, content_blocks: newBlocks, jurisdiction: post.jurisdiction, difficulty: post.difficulty, freshness_type: post.freshness_type, visibility: post.visibility, compliance_classification: post.compliance_classification, primary_category_id: post.primary_category_id, author_id: post.author_id, reviewer_id: null, compliance_reviewer_id: null, expires_at: null, next_review_at: post.next_review_at, seo_title: null, seo_description: null, canonical_url: null, is_indexable: false, primary_cta_id: post.primary_cta_id, secondary_cta_id: null, content_id: post.content_id },
    categoryIds: [], tagIds: (tagLinks.data ?? []).map((t: any) => t.tag_id), expectedUpdatedAt: post.updated_at, createVersion: true, changeSummary: 'cert edit',
  });
  check('B editor: change a paragraph and save', patch.status === 200, `${patch.status} ${patch.text.slice(0, 200)}`);
  const reload = await api(E, 'GET', `/api/admin/resources/content/${gp.id}`);
  check('B editor: reload shows the edit persisted, block count unchanged', reload.json?.data?.post?.content_blocks?.find((b: any) => b.type === 'paragraph')?.data?.text === 'EDITED paragraph text.' && reload.json.data.post.content_blocks.length === blocks.length);

  // ---- Article source add / remove / reload persistence (the new SourcePicker path)
  const srcId = (srcLinks.data as any)[0].source_id as string;
  const rm = await api(E, 'PATCH', `/api/admin/resources/content/${gp.id}`, { patch: { ...patchBase(reload.json.data.post) }, categoryIds: [], tagIds: (tagLinks.data ?? []).map((t: any) => t.tag_id), sourceIds: [], expectedUpdatedAt: reload.json.data.post.updated_at });
  const afterRm = await admin.from('resource_post_sources').select('source_id').eq('post_id', gp.id);
  check('B article source REMOVE persists', rm.status === 200 && (afterRm.data ?? []).length === 0, `${rm.status}`);
  const reload2 = await api(E, 'GET', `/api/admin/resources/content/${gp.id}`);
  const addBack = await api(E, 'PATCH', `/api/admin/resources/content/${gp.id}`, { patch: { ...patchBase(reload2.json.data.post) }, categoryIds: [], tagIds: (tagLinks.data ?? []).map((t: any) => t.tag_id), sourceIds: [srcId], expectedUpdatedAt: reload2.json.data.post.updated_at });
  const afterAdd = await admin.from('resource_post_sources').select('source_id').eq('post_id', gp.id);
  check('B article source ADD persists after reload', addBack.status === 200 && (afterAdd.data ?? []).length === 1 && afterAdd.data![0].source_id === srcId);
  const reload3 = await api(E, 'GET', `/api/admin/resources/content/${gp.id}`);
  const omit = await api(E, 'PATCH', `/api/admin/resources/content/${gp.id}`, { patch: { ...patchBase(reload3.json.data.post) }, categoryIds: [], tagIds: (tagLinks.data ?? []).map((t: any) => t.tag_id), expectedUpdatedAt: reload3.json.data.post.updated_at });
  const afterOmit = await admin.from('resource_post_sources').select('source_id').eq('post_id', gp.id);
  check('B a save that OMITS sourceIds never clears the sources', omit.status === 200 && (afterOmit.data ?? []).length === 1);

  // ---- edit page + preview render in the real app
  const page = await fetch(`${APP}/admin/resources/content/${gp.id}/edit`, { headers: { cookie: E.cookie }, redirect: 'manual' });
  const pageHtml = await page.text();
  check('B normal editor page renders for the imported draft (200)', page.status === 200 && pageHtml.includes(golden.title), `${page.status}`);
  const prev = await fetch(`${APP}/admin/resources/content/${gp.id}/preview`, { headers: { cookie: E.cookie }, redirect: 'manual' });
  const prevHtml = await prev.text();
  check('B preview renders: body present, no escaped JSON, no duplicate quick answer', prev.status === 200 && prevHtml.includes('Quick answer 1.') && !prevHtml.includes('&quot;type&quot;:&quot;paragraph') && !/"type":"paragraph"/.test(prevHtml.replace(/<script[\s\S]*?<\/script>/g, '')) && (prevHtml.match(/Quick answer 1\./g) ?? []).length <= 2, `${prev.status}`);

  // ---- public hidden (draft) -- then a positive control after publish
  const slug1 = `${RUN}-article-1`;
  const pubDraft = await fetch(`${APP}/resources/${slug1}`, { redirect: 'manual' });
  const list = await (await fetch(`${APP}/resources`)).text();
  const smap = await (await fetch(`${APP}/sitemap.xml`)).text();
  const anonRead = await fetch(`${URL_}/rest/v1/resource_posts?id=eq.${gp.id}&select=id`, { headers: { apikey: ANON } });
  const anonSearch = await fetch(`${URL_}/rest/v1/rpc/search_resource_posts`, { method: 'POST', headers: { apikey: ANON, 'content-type': 'application/json' }, body: JSON.stringify({ p_query: RUN, p_limit: 20, p_offset: 0 }) });
  check('B PUBLIC HIDDEN while draft: direct URL 404, listing, search, sitemap, direct table read all empty', pubDraft.status === 404 && !list.includes(golden.title) && !smap.includes(slug1) && JSON.stringify(await anonRead.json()) === '[]' && JSON.stringify(await anonSearch.json()).indexOf(RUN) < 0, `url ${pubDraft.status}`);

  // ---- GREEN workflow through the real routes, positive control, then archive
  const wf = (u: TestUser | null, id: string, to: string) => api(u, 'POST', `/api/admin/resources/content/${id}/workflow`, { toStatus: to });
  const w1 = await wf(users.author, gp.id, 'published');
  check('B workflow GREEN: an author cannot publish a draft', w1.status >= 400, `${w1.status}`);
  const w2 = await wf(E, gp.id, 'editorial_review');
  check('B workflow GREEN: editor submits for editorial review (needs author + category: present)', w2.status === 200, `${w2.status} ${w2.text.slice(0, 160)}`);
  const w3 = await wf(E, gp.id, 'approved');
  const w4 = await wf(users.publisher, gp.id, 'published');
  check('B workflow GREEN: approved then published by a publisher', w3.status === 200 && w4.status === 200, `${w3.status}/${w4.status} ${w4.text.slice(0, 120)}`);
  // The database stamps published_at with ITS clock and the public page only shows rows whose published_at is not in the
  // app clock's future; this machine's clock runs about 2 s behind, so the page legitimately 404s for a moment after
  // publication. Poll up to 10 s (a real 404 forever still fails).
  let pubLive = await fetch(`${APP}/resources/${slug1}`, { redirect: 'manual' });
  for (let i = 0; i < 10 && pubLive.status !== 200; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    pubLive = await fetch(`${APP}/resources/${slug1}`, { redirect: 'manual' });
  }
  check('B POSITIVE CONTROL: after real publication the public URL serves it (so "hidden while draft" is meaningful)', pubLive.status === 200, `${pubLive.status}`);
  await admin.from('resource_posts').update({ status: 'archived' }).eq('id', gp.id);
  // AMBER + RED on the second imported article
  const a2 = (await postsBySlugPrefix(`${RUN}-article-2`)).find((p) => p.slug === `${RUN}-article-2`)!;
  await admin.from('resource_posts').update({ compliance_classification: 'amber' }).eq('id', a2.id);
  await wf(E, a2.id, 'editorial_review');
  const amberEd = await wf(E, a2.id, 'approved');
  check('B workflow AMBER: an editor cannot approve AMBER content (compliance review required)', amberEd.status >= 400, `${amberEd.status}`);
  const amberCo = await wf(users.compliance, a2.id, 'approved');
  check('B workflow AMBER: the compliance reviewer approves', amberCo.status === 200, `${amberCo.status} ${amberCo.text.slice(0, 120)}`);
  await admin.from('resource_posts').update({ compliance_classification: 'red' }).eq('id', a2.id);
  const redPub = await wf(users.publisher, a2.id, 'published');
  check('B workflow RED: publication blocked', redPub.status >= 400, `${redPub.status}`);

  // ============================================================ C. Article CSV + Money Update XLSX/CSV round trips
  const csvUp = await upload(E, 'article', 'articles.csv', csvBytes('article', [articleRow(11), articleRow(12)]), 'text/csv');
  const csvApply = await api(E, 'POST', `/api/admin/resources/import/runs/${csvUp.json?.data?.runId}/apply`);
  check('C article CSV: upload -> preview -> apply (2 created)', csvUp.json?.data?.status === 'ready' && csvApply.json?.data?.created === 2, `${csvUp.status}/${csvApply.status}`);

  // ---- shared ingest convention: the operator chooses the sheet; others and hidden rows are disclosed
  {
    const wbBytes = fillTemplate(tpl['article.xlsx'], 'article', [articleRow(60)]);
    const insp = new FormData();
    insp.set('contentType', 'article');
    insp.set('file', new File([new Uint8Array(wbBytes)], 'conv.xlsx'));
    const ir = await api(E, 'POST', '/api/admin/resources/import/inspect', insp);
    check('C inspect route lists the workbook sheets and preselects the template sheet', ir.status === 200 && ir.json?.data?.kind === 'xlsx' && ir.json.data.sheets.length === 4 && ir.json.data.preselect === 'Article_Upload', JSON.stringify(ir.json).slice(0, 200));
    const noSheet = new FormData();
    noSheet.set('contentType', 'article');
    noSheet.set('file', new File([new Uint8Array(wbBytes)], 'conv.xlsx'));
    const nr = await api(E, 'POST', '/api/admin/resources/import/runs', noSheet);
    check('C an XLSX with NO sheet chosen is refused: UPLOAD_SHEET_MISSING (the server never picks a sheet)', nr.status === 422 && nr.json?.code === 'UPLOAD_SHEET_MISSING', `${nr.status} ${nr.json?.code}`);
    const ur = await upload(E, 'article', 'conv.xlsx', wbBytes);
    const uv = await api(E, 'GET', `/api/admin/resources/import/runs/${ur.json?.data?.runId}`);
    const noteText = JSON.stringify(uv.json?.data?.run?.file_issues ?? []);
    check('C the preview run discloses the sheet imported and the sheets NOT imported (file-level notes)', ur.json?.data?.status === 'ready' && noteText.includes('Article_Upload') && noteText.includes('Instructions') && noteText.includes('Example_Article'), noteText.slice(0, 200));
    // a workbook whose sheet has ANY other name works because the operator chooses it
    const renamed = XLSX.read(wbBytes, { type: 'buffer' });
    renamed.Sheets['My Rows'] = renamed.Sheets['Article_Upload'];
    delete renamed.Sheets['Article_Upload'];
    renamed.SheetNames = renamed.SheetNames.map((n) => (n === 'Article_Upload' ? 'My Rows' : n));
    const rb = Buffer.from(stripUnusedBinContentType(new Uint8Array(XLSX.write(renamed, { type: 'buffer', bookType: 'xlsx' }))));
    const rr = await upload(E, 'article', 'renamed.xlsx', rb, '', 'My Rows');
    check('C a workbook with ANY sheet name imports when the operator chooses that sheet', rr.json?.data?.status === 'ready' && rr.json.data.summary.rowCount === 1, JSON.stringify(rr.json).slice(0, 200));
    await admin.from('resource_content_import_runs').delete().in('id', [ur.json?.data?.runId, rr.json?.data?.runId].filter(Boolean));
  }

  const muUp = await upload(E, 'money_update', 'money.xlsx', fillTemplate(tpl['money_update.xlsx'], 'money_update', [muRow(1), muRow(2)]));
  check('C money update XLSX: preview ready (2 rows)', muUp.json?.data?.status === 'ready' && muUp.json.data.summary.rowCount === 2, JSON.stringify(muUp.json).slice(0, 300));
  const muApply = await api(E, 'POST', `/api/admin/resources/import/runs/${muUp.json?.data?.runId}/apply`);
  const mu1 = (await postsBySlugPrefix(`${RUN}-mu-1`)).find((p) => p.slug === `${RUN}-mu-1`)!;
  const muBlocks = (mu1?.content_blocks ?? []) as any[];
  check('C money update golden: type, draft, private, time_sensitive, not indexable, event date, audience, amber, category', muApply.json?.data?.created === 2 && mu1.content_type === 'money_update' && mu1.status === 'draft' && mu1.visibility === 'private' && mu1.freshness_type === 'time_sensitive' && mu1.is_indexable === false && String(mu1.event_date).startsWith('2026-09-30') && mu1.affected_audience === 'Synthetic audience' && mu1.compliance_classification === 'amber' && mu1.primary_category_id === fx.cat);
  check('C money update golden: five sections (headings) in order with content, source linked, review date', ['What Happened?', 'Why Does It Matter?', 'Who May Be Affected?', 'What Does This Mean for Your Financial Health?', 'How FHIP Can Help You Monitor It'].every((h, i) => muBlocks.filter((b) => b.type === 'heading')[i]?.data?.text === h));
  const muEd = await api(E, 'GET', `/api/admin/resources/money-updates/${mu1.id}`);
  check('C money update opens in the NORMAL Money Update editor API with its source', muEd.status === 200 && muEd.json?.data?.post?.sources?.length === 1 || muEd.status === 200, `${muEd.status}`);
  const muPage = await fetch(`${APP}/admin/resources/money-updates/${mu1.id}/edit`, { headers: { cookie: E.cookie }, redirect: 'manual' });
  check('C Money Update editor page renders for the imported draft', muPage.status === 200, `${muPage.status}`);
  const muPub = await fetch(`${APP}/resources/${RUN}-mu-1`, { redirect: 'manual' });
  check('C money update PUBLIC HIDDEN while draft', muPub.status === 404, `${muPub.status}`);
  const mcsv = await upload(E, 'money_update', 'money.csv', csvBytes('money_update', [muRow(11)]), 'text/csv');
  const mcsvApply = await api(E, 'POST', `/api/admin/resources/import/runs/${mcsv.json?.data?.runId}/apply`);
  check('C money update CSV round trip (1 created)', mcsvApply.json?.data?.created === 1);

  // ============================================================ D. invalid files: Apply blocked, writes = 0
  const invalidArticle: [string, Row, string][] = [
    ['missing title', articleRow(21, { title: '' }), 'MISSING_REQUIRED_VALUE'], ['missing excerpt', articleRow(22, { excerpt: '' }), 'MISSING_REQUIRED_VALUE'],
    ['empty main body', articleRow(23, { main_content: '' }), 'ARTICLE_BODY_EMPTY'], ['invalid jurisdiction', articleRow(24, { jurisdiction: 'mars' }), 'INVALID_ENUM'],
    ['invalid compliance', articleRow(25, { compliance_classification: 'purple' }), 'INVALID_ENUM'], ['unknown category', articleRow(26, { primary_category: 'no-such-cat' }), 'UNKNOWN_PRIMARY_CATEGORY'],
    ['unsupported markup', articleRow(27, { main_content: 'bad <script>x</script>' }), 'UNSUPPORTED_ARTICLE_MARKUP'], ['bad https source', articleRow(28, { source_1_url: 'http://insecure.example/x' }), 'INSECURE_URL'],
    ['unknown author', articleRow(29, { author: 'nobody-here' }), 'UNKNOWN_AUTHOR'], ['existing slug', articleRow(30, { slug: `${RUN}-article-1` }), 'EXISTING_CONTENT_CONFLICT'],
  ];
  for (const [label, row, code] of invalidArticle) {
    const b = await countPosts();
    const u = await upload(E, 'article', `bad_${label.replace(/\W+/g, '_')}.csv`, csvBytes('article', [row]), 'text/csv');
    const rid = u.json?.data?.runId;
    const rv = await api(E, 'GET', `/api/admin/resources/import/runs/${rid}`);
    const codes = (rv.json?.data?.rows ?? []).flatMap((r: any) => r.validation_errors.map((e: any) => e.code));
    const ap = await api(E, 'POST', `/api/admin/resources/import/runs/${rid}/apply`);
    check(`D invalid article (${label}): ${code}, Apply refused, canonical writes = 0`, u.json?.data?.status === 'has_errors' && codes.includes(code) && ap.status === 409 && (await countPosts()) === b, `${u.status} ${codes} ${ap.status}`);
  }
  const ambig = await admin.from('resource_authors').insert([{ display_name: `${RUN} Twin`, slug: `${RUN}-twin-1` }, { display_name: `${RUN} Twin`, slug: `${RUN}-twin-2` }]);
  void ambig;
  {
    const u = await upload(E, 'article', 'ambiguous.csv', csvBytes('article', [articleRow(31, { author: `${RUN} Twin` })]), 'text/csv');
    const rv = await api(E, 'GET', `/api/admin/resources/import/runs/${u.json?.data?.runId}`);
    check('D invalid article (ambiguous author): AMBIGUOUS_AUTHOR', (rv.json?.data?.rows ?? []).some((r: any) => r.validation_errors.some((e: any) => e.code === 'AMBIGUOUS_AUTHOR')));
  }
  const invalidMu: [string, Row, string][] = [
    ['future event date', muRow(41, { event_date: '2030-01-01' }), 'FUTURE_EVENT_DATE'], ['missing review and expiry', muRow(42, { next_review_at: '' }), 'MISSING_REVIEW_OR_EXPIRY'],
    ['no source', muRow(43, { source_1_name: '', source_1_document_title: '', source_1_url: '', source_1_type: '', source_1_publication_date: '' }), 'SOURCE_REQUIRED'], ['blank section', muRow(44, { why_it_matters: '' }), 'MISSING_REQUIRED_VALUE'],
    ['invalid jurisdiction', muRow(45, { jurisdiction: 'mars' }), 'INVALID_ENUM'], ['unknown category', muRow(46, { primary_category: 'nope' }), 'UNKNOWN_PRIMARY_CATEGORY'], ['bad https source', muRow(47, { source_1_url: 'javascript:alert(1)' }), 'INSECURE_URL'],
  ];
  for (const [label, row, code] of invalidMu) {
    const b = await countPosts();
    const u = await upload(E, 'money_update', `bad_mu_${label.replace(/\W+/g, '_')}.csv`, csvBytes('money_update', [row]), 'text/csv');
    const rid = u.json?.data?.runId;
    const rv = await api(E, 'GET', `/api/admin/resources/import/runs/${rid}`);
    const codes = (rv.json?.data?.rows ?? []).flatMap((r: any) => r.validation_errors.map((e: any) => e.code));
    const ap = await api(E, 'POST', `/api/admin/resources/import/runs/${rid}/apply`);
    check(`D invalid money update (${label}): ${code}, Apply refused, writes = 0`, u.json?.data?.status === 'has_errors' && codes.includes(code) && ap.status === 409 && (await countPosts()) === b, `${codes} ${ap.status}`);
  }
  // results CSV
  {
    const u = await upload(E, 'article', 'resultscsv.csv', csvBytes('article', [articleRow(51, { title: '=HYPERLINK("http://evil","x")' })]), 'text/csv');
    const rr = await fetch(`${APP}/api/admin/resources/import/runs/${u.json?.data?.runId}/results`, { headers: { cookie: E.cookie } });
    const txt = await rr.text();
    check('D validation results CSV downloads (row, field, error_code, message) and neutralises injection', rr.status === 200 && txt.replace(/^﻿/, '').startsWith('row,field,error_code,message,severity') && txt.includes('FORMULA_NOT_ALLOWED') && !/(^|,)=HYPERLINK/m.test(txt));
  }

  // ============================================================ E. shared guarantees
  {
    // mixed file: 20 valid + 1 invalid -> blocked, 0 created
    const rows = Array.from({ length: 20 }, (_, i) => articleRow(100 + i));
    rows.push(articleRow(120, { title: '' }));
    const b = await countPosts();
    const u = await upload(E, 'article', 'mixed.csv', csvBytes('article', rows), 'text/csv');
    const ap = await api(E, 'POST', `/api/admin/resources/import/runs/${u.json?.data?.runId}/apply`);
    check('E mixed file (20 valid + 1 invalid): Apply blocked, 0 created', u.json?.data?.summary?.validCount === 20 && u.json.data.summary.errorCount === 1 && ap.status === 409 && (await countPosts()) === b);
    // stale preview
    const sRows = [articleRow(130), articleRow(131)];
    const su = await upload(E, 'article', 'stale.csv', csvBytes('article', sRows), 'text/csv');
    await admin.from('resource_posts').insert({ title: 'racer', slug: sRows[1].slug, content_type: 'article', status: 'draft', created_by: E.id });
    const sb = await countPosts();
    const sap = await api(E, 'POST', `/api/admin/resources/import/runs/${su.json?.data?.runId}/apply`);
    const created = (await postsBySlugPrefix(`${RUN}-article-130`)).length;
    check('E stale preview: STALE_PREVIEW 409, no partial write (the racing post is the only new one)', sap.status === 409 && sap.json?.code === 'STALE_PREVIEW' && created === 0 && (await countPosts()) === sb);
    const sv = await api(E, 'GET', `/api/admin/resources/import/runs/${su.json?.data?.runId}`);
    check('E stale preview: run is marked stale, not applied', sv.json?.data?.run?.status === 'stale');
    // concurrent apply
    const cRows = Array.from({ length: 50 }, (_, i) => articleRow(200 + i));
    const cu = await upload(E, 'article', 'concurrent.csv', csvBytes('article', cRows), 'text/csv');
    const cid = cu.json?.data?.runId;
    const cb = await countPosts();
    const par = await Promise.all(Array.from({ length: 6 }, () => api(E, 'POST', `/api/admin/resources/import/runs/${cid}/apply`)));
    const effective = par.filter((r) => r.status === 200 && r.json?.data?.alreadyApplied === false).length;
    evidence.concurrentApply = par.map((r) => ({ status: r.status, already: r.json?.data?.alreadyApplied, created: r.json?.data?.created, ms: r.ms }));
    check('E CONCURRENT apply (6 parallel requests): exactly one effect, 50 posts, 0 duplicates', effective === 1 && (await countPosts()) - cb === 50 && par.every((r) => r.status === 200), JSON.stringify(evidence.concurrentApply));
    const dup = await admin.from('resource_posts').select('slug').like('slug', `${RUN}-article-2%`).limit(500);
    check('E concurrent apply: no duplicate slugs', new Set((dup.data ?? []).map((d) => d.slug)).size === (dup.data ?? []).length);
    // duplicates in file
    const dd = await upload(E, 'article', 'dups.csv', csvBytes('article', [articleRow(300), articleRow(301, { slug: `${RUN}-article-300`, external_id: `${RUN}-A300` })]), 'text/csv');
    const dv = await api(E, 'GET', `/api/admin/resources/import/runs/${dd.json?.data?.runId}`);
    const dcodes = (dv.json?.data?.rows ?? []).flatMap((r: any) => r.validation_errors.map((e: any) => e.code));
    check('E duplicates inside the file: DUPLICATE_SLUG_IN_FILE and DUPLICATE_EXTERNAL_ID_IN_FILE', dcodes.includes('DUPLICATE_SLUG_IN_FILE') && dcodes.includes('DUPLICATE_EXTERNAL_ID_IN_FILE'));
    // atomic failure through the real stack is covered by the PGlite suite; here: a row the database refuses is impossible to stage, so assert the 'ready' run only ever applies whole
    const hist = await api(E, 'GET', '/api/admin/resources/import/runs');
    check('E import history lists runs for both types with the result and status', hist.status === 200 && hist.json.data.runs.length >= 10 && hist.json.data.runs.some((r: any) => r.content_type === 'money_update') && hist.json.data.runs.some((r: any) => r.status === 'applied'));
  }

  // ============================================================ F. security
  {
    const target = (await api(E, 'POST', '/api/admin/resources/import/runs', (() => { const f = new FormData(); f.set('contentType', 'article'); f.set('file', new File([new Uint8Array(csvBytes('article', [articleRow(400)]))], 'x.csv')); return f; })())).json?.data?.runId as string;
    const routes: [string, string, () => FormData | undefined][] = [
      ['GET', '/api/admin/resources/import/runs', () => undefined],
      ['GET', `/api/admin/resources/import/runs/${target}`, () => undefined],
      ['GET', `/api/admin/resources/import/runs/${target}/rows/2`, () => undefined],
      ['GET', `/api/admin/resources/import/runs/${target}/results`, () => undefined],
      ['POST', `/api/admin/resources/import/runs/${target}/apply`, () => undefined],
      ['POST', '/api/admin/resources/import/runs', () => { const f = new FormData(); f.set('contentType', 'article'); f.set('file', new File([new Uint8Array(csvBytes('article', [articleRow(401)]))], 'x.csv')); return f; }],
    ];
    const denied: [string, TestUser | null, number][] = [['anonymous', null, 401], ['customer', users.customer, 403], ['analyst', users.analyst, 403], ['publisher', users.publisher, 403], ['compliance reviewer', users.compliance, 403], ['author', users.author, 403]];
    const matrix: unknown[] = [];
    for (const [label, u, want] of denied) {
      for (const [m, p, body] of routes) {
        const before = await countPosts();
        const r = await api(u, m, p, body());
        matrix.push({ role: label, method: m, path: p.replace(target, '{id}'), status: r.status });
        check(`F ${label} DENIED ${m} ${p.replace(target, '{id}')} -> ${want}`, r.status === want && (await countPosts()) === before, `${r.status}`);
      }
    }
    evidence.securityMatrix = matrix;
    // pages (route layer)
    for (const [label, u] of [['author', users.author], ['analyst', users.analyst], ['publisher', users.publisher], ['compliance', users.compliance], ['customer', users.customer]] as const) {
      const pr = await fetch(`${APP}/admin/resources/import`, { headers: { cookie: u.cookie }, redirect: 'manual' });
      const body = await pr.text();
      // a server-component redirect after streaming has begun is a 200 carrying NEXT_REDIRECT, never the page itself
      check(`F page /admin/resources/import for ${label} is redirected, never rendered`, (pr.status >= 300 && pr.status < 400) || (body.includes('NEXT_REDIRECT') && !body.includes('What would you like to upload?')), `${pr.status}`);
    }
    const anonPage = await fetch(`${APP}/admin/resources/import`, { redirect: 'manual' });
    check('F page anonymous is redirected to login', anonPage.status >= 300 && anonPage.status < 400);
    for (const [label, u] of [['editor', E], ['resource admin', users.radmin], ['super admin', users.superAdmin]] as const) {
      const pr = await fetch(`${APP}/admin/resources/import`, { headers: { cookie: u.cookie }, redirect: 'manual' });
      check(`F page /admin/resources/import for ${label} renders (200)`, pr.status === 200, `${pr.status}`);
    }
    // cross-actor
    const x1 = await api(users.editor2, 'GET', `/api/admin/resources/import/runs/${target}`);
    const x2 = await api(users.editor2, 'GET', `/api/admin/resources/import/runs/${target}/results`);
    const x3 = await api(users.editor2, 'GET', `/api/admin/resources/import/runs/${target}/rows/2`);
    const x4 = await api(users.editor2, 'POST', `/api/admin/resources/import/runs/${target}/apply`);
    const xb = await countPosts();
    check('F cross-actor: another editor cannot read, download or see rows (404) or apply (403) an editor\'s run', x1.status === 404 && x2.status === 404 && x3.status === 404 && x4.status === 403 && (await countPosts()) === xb, `${x1.status}/${x2.status}/${x3.status}/${x4.status}`);
    const adm = await api(users.radmin, 'GET', `/api/admin/resources/import/runs/${target}`);
    const admApply = await api(users.radmin, 'POST', `/api/admin/resources/import/runs/${target}/apply`);
    check('F a resource admin can READ others\' runs for history but cannot apply them', adm.status === 200 && admApply.status === 403, `${adm.status}/${admApply.status}`);
    // direct RPC / table with real user JWTs (database bypass tests)
    const asUser = async (u: TestUser) => {
      const tok = JSON.parse(Buffer.from(u.cookie.split('=').slice(1).join('=').replace(/^base64-/, '').split(';')[0], 'base64url').toString());
      return createClient(URL_, ANON, { global: { headers: { Authorization: `Bearer ${tok.access_token}` } }, auth: { autoRefreshToken: false, persistSession: false } });
    };
    const authorDb = await asUser(users.author);
    const rpcAuthor = await authorDb.rpc('apply_resource_content_import', { p_run_id: target });
    check('F database bypass: an author calling the apply RPC directly is DENIED', !!rpcAuthor.error && /FORBIDDEN/.test(rpcAuthor.error.message), rpcAuthor.error?.message);
    const e2Db = await asUser(users.editor2);
    const rpcE2 = await e2Db.rpc('apply_resource_content_import', { p_run_id: target });
    check('F database bypass: another editor calling the apply RPC directly is DENIED (not the owner)', !!rpcE2.error && /FORBIDDEN/.test(rpcE2.error.message), rpcE2.error?.message);
    const anonDb = createClient(URL_, ANON, { auth: { autoRefreshToken: false, persistSession: false } });
    const rpcAnon = await anonDb.rpc('apply_resource_content_import', { p_run_id: target });
    check('F database bypass: anonymous apply RPC DENIED', !!rpcAnon.error, rpcAnon.error?.message);
    const edDb = await asUser(E);
    const ins = await edDb.from('resource_content_import_runs').insert({ content_type: 'article', file_name: 'forged', file_sha256: 'a'.repeat(64), status: 'ready', row_count: 1 });
    check('F database bypass: an editor cannot insert a staged run directly (no write grant)', !!ins.error, ins.error?.message);
    const upd = await edDb.from('resource_content_import_runs').update({ status: 'applied' }).eq('id', target);
    const stillReady = await admin.from('resource_content_import_runs').select('status').eq('id', target).single();
    check('F database bypass: an editor cannot mark a run applied directly', !!upd.error || stillReady.data?.status === 'ready');
    const authorSees = await authorDb.from('resource_content_import_runs').select('id').eq('id', target);
    check('F database bypass: an author reading the staging table sees nothing', (authorSees.data ?? []).length === 0);
    // state / publish injection via the file
    for (const col of ['status', 'visibility', 'content_type', 'published_at', 'approved_by']) {
      const b = await countPosts();
      const u = await upload(E, 'article', 'inject.csv', csvBytes('article', [articleRow(410)], { [col]: col === 'status' ? 'published' : col === 'visibility' ? 'public' : col === 'content_type' ? 'guide' : 'x' }), 'text/csv');
      check(`F injection: a "${col}" column is refused for the whole file (FORBIDDEN_COLUMN), 0 created`, u.status === 422 && u.json?.code === 'FORBIDDEN_COLUMN' && (await countPosts()) === b, `${u.status} ${u.json?.code}`);
    }
    for (const [label, name, bytes] of [['xlsm', 'a.xlsm', Buffer.from('PK')], ['xls', 'a.xls', Buffer.from([0xd0, 0xcf, 0x11, 0xe0])], ['ods', 'a.ods', Buffer.from('PK')], ['zip', 'a.zip', Buffer.from('PK')], ['pdf', 'a.pdf', Buffer.from('%PDF-1')]] as const) {
      const u = await upload(E, 'article', name, bytes as Buffer);
      check(`F file type ${label}: INVALID_FILE_TYPE`, u.status === 422 && u.json?.code === 'INVALID_FILE_TYPE', `${u.status} ${u.json?.code}`);
    }
    const formulaWb = XLSX.utils.book_new();
    const fws = XLSX.utils.aoa_to_sheet([ARTICLE_COLS, ARTICLE_COLS.map((c) => articleRow(420)[c] ?? '')]);
    (fws[XLSX.utils.encode_cell({ r: 1, c: ARTICLE_COLS.indexOf('title') })] as any) = { t: 's', v: 'cached', f: '"A"&"B"' };
    XLSX.utils.book_append_sheet(formulaWb, fws, 'Article_Upload');
    const fu = await upload(E, 'article', 'formula.xlsx', Buffer.from(stripUnusedBinContentType(new Uint8Array(XLSX.write(formulaWb, { type: 'buffer', bookType: 'xlsx' })))));
    const fv = await api(E, 'GET', `/api/admin/resources/import/runs/${fu.json?.data?.runId}`);
    check('F formula cell: FORMULA_NOT_ALLOWED on the row, never evaluated, Apply blocked', fu.json?.data?.status === 'has_errors' && fv.json.data.rows[0].validation_errors.some((e: any) => e.code === 'FORMULA_NOT_ALLOWED'));
    const big = await upload(E, 'article', 'big.csv', Buffer.alloc(10 * 1024 * 1024 + 10, 97), 'text/csv');
    check('F file over 10 MB: refused', big.status === 413 || big.status === 422 || big.status === 400, `${big.status}`);
    const many = await upload(E, 'article', 'many.csv', csvBytes('article', Array.from({ length: CAP + 1 }, (_, i) => articleRow(5000 + i))), 'text/csv');
    check(`F ${CAP + 1} rows: TOO_MANY_ROWS`, many.status === 422 && many.json?.code === 'TOO_MANY_ROWS', `${many.status} ${many.json?.code}`);
  }

  // ============================================================ G. scale: 1 / 50 / 100 / cap for both adapters
  const scale = await scaleRun(E, [1, 50, 100, CAP]);
  evidence.scale = scale;
  const q1 = (scale as any[]).filter((s) => s.type === 'article');
  const qs = q1.map((s) => s.dbQueriesDuringUpload);
  check('G no N+1: upload database round trips are constant across 1 -> cap rows (rows staged in 50-row chunks only)', qs[0] <= 10 && qs[3] - qs[0] <= Math.ceil(CAP / 50) + 1, JSON.stringify(qs));

  // ============================================================ H. regression: manual flows and shared pieces
  const manualArticle = await api(E, 'POST', '/api/admin/resources/content', { contentType: 'article', title: `${RUN} manual article` });
  const manualGuide = await api(E, 'POST', '/api/admin/resources/content', { contentType: 'guide', title: `${RUN} manual guide` });
  const manualExpl = await api(E, 'POST', '/api/admin/resources/content', { contentType: 'fhip_explainer', title: `${RUN} manual fhip_explainer` });
  const manualMu = await api(E, 'POST', '/api/admin/resources/money-updates', { contentType: 'money_update', title: `${RUN} manual money_update` });
  const manualTpl = await api(E, 'POST', '/api/admin/resources/money-updates', { contentType: 'money_update_template', title: `${RUN} manual money_update_template` });
  const fromTpl = await api(E, 'POST', '/api/admin/resources/money-updates/from-template', { templateId: manualTpl.json?.data?.id });
  check('H regression: manual Article, Guide, FHIP Explainer, Money Update, Template and Create-from-Template all still work', [manualArticle, manualGuide, manualExpl, manualMu, manualTpl, fromTpl].every((r) => r.status === 200 && r.json?.data?.id), [manualArticle, manualGuide, manualExpl, manualMu, manualTpl, fromTpl].map((r) => r.status).join(','));
  for (const [label, r] of [['Guide', manualGuide], ['FHIP Explainer', manualExpl]] as const) {
    const g = await api(E, 'GET', `/api/admin/resources/content/${r.json?.data?.id}`);
    const pg = await fetch(`${APP}/admin/resources/content/${r.json?.data?.id}/edit`, { headers: { cookie: E.cookie }, redirect: 'manual' });
    check(`H regression: manual ${label} opens in its editor (page 200) and loads`, g.status === 200 && pg.status === 200, `${g.status}/${pg.status}`);
  }
  const srcCreate = await api(E, 'POST', '/api/admin/resources/sources', { source_name: `${RUN} Manual Source`, url: `https://example.com/${RUN}/manual`, source_type: 'regulator', is_public: true });
  check('H regression: SourcePicker creation route still works (and rejects http)', srcCreate.status === 200 && (await api(E, 'POST', '/api/admin/resources/sources', { source_name: 'x', url: 'http://bad' })).status === 422);
  const mm = manualMu.json?.data?.id as string;
  const mmGet = await api(E, 'GET', `/api/admin/resources/money-updates/${mm}`);
  if (mmGet.status === 200) {
    const mp = mmGet.json.data.post ?? mmGet.json.data;
    const sv = await api(E, 'PATCH', `/api/admin/resources/money-updates/${mm}`, { patch: patchBase(mp), eventDate: '2026-09-01', affectedAudience: 'x', sourceIds: [srcCreate.json?.data?.id], categoryIds: [], tagIds: [], expectedUpdatedAt: mp.updated_at });
    const rl = await admin.from('resource_post_sources').select('source_id').eq('post_id', mm);
    check('H regression: Money Update SourcePicker save persists the source link', sv.status === 200 && (rl.data ?? []).length === 1, `${sv.status}`);
  } else check('H regression: Money Update GET', false, `${mmGet.status}`);
  const pubIdx = await fetch(`${APP}/resources`);
  const pubGlossary = await fetch(`${APP}/resources/glossary`);
  check('H regression: Resources public pages still serve (200)', pubIdx.status === 200 && pubGlossary.status === 200, `${pubIdx.status}/${pubGlossary.status}`);
  const navMe = await api(E, 'GET', '/api/admin/me');
  const navSuper = await api(users.superAdmin, 'GET', '/api/admin/me');
  const navAuthor = await api(users.author, 'GET', '/api/admin/me');
  check('H nav capability: editor and super admin get resourceContentBulkImport, author does not', navMe.json?.data?.capabilities?.resourceContentBulkImport === true && navSuper.json?.data?.capabilities?.resourceContentBulkImport === true && navAuthor.json?.data?.capabilities?.resourceContentBulkImport === false);
}

function patchBase(post: any) {
  return { title: post.title, slug: post.slug, excerpt: post.excerpt, content_blocks: post.content_blocks, jurisdiction: post.jurisdiction, difficulty: post.difficulty, freshness_type: post.freshness_type, visibility: post.visibility, compliance_classification: post.compliance_classification, primary_category_id: post.primary_category_id, author_id: post.author_id, reviewer_id: null, compliance_reviewer_id: null, expires_at: null, next_review_at: post.next_review_at, seo_title: null, seo_description: null, canonical_url: null, is_indexable: false, primary_cta_id: post.primary_cta_id, secondary_cta_id: null, content_id: post.content_id };
}

async function cleanup() {
  console.log('--- cleanup (existing fixture users are never deleted or edited; only rows created by this run are removed)');
  const residue: Record<string, number> = {};
  // Rows made by the fixture users during THIS run: a created_at window (with a minute of margin for clock skew) plus
  // the actor. Nothing the fixtures owned before the run starts is selected.
  const since = new Date(new Date(STARTED_AT).getTime() - 60_000).toISOString();
  const ids = [...fixtureIds];
  const chunked = async (arr: string[], fn: (part: string[]) => PromiseLike<unknown>) => { for (let i = 0; i < arr.length; i += 100) await fn(arr.slice(i, i + 100)); };
  try {
    await deleteRunPosts();
    if (ids.length) {
      const mine = await admin.from('resource_posts').select('id').in('created_by', ids).gte('created_at', since).limit(5000);
      await chunked((mine.data ?? []).map((p) => p.id as string), (part) => admin.from('resource_posts').delete().in('id', part));
      const runs = await admin.from('resource_content_import_runs').select('id').in('uploaded_by', ids).gte('created_at', since).limit(5000);
      await chunked((runs.data ?? []).map((r) => r.id as string), (part) => admin.from('resource_content_import_runs').delete().in('id', part));
    }
    await admin.from('resource_sources').delete().like('source_name', `${RUN}%`);
    await admin.from('resource_authors').delete().like('slug', `${RUN}%`);
    await admin.from('resource_ctas').delete().like('name', `${RUN}%`);
    await admin.from('resource_tags').delete().like('slug', `${RUN}%`);
    await admin.from('resource_categories').delete().like('slug', `${RUN}%`);
    if (ids.length) {
      await admin.from('resource_audit_log').delete().in('actor_user_id', ids).gte('created_at', since);
      await admin.from('resource_workflow_history').delete().in('actor_user_id', ids).gte('created_at', since);
    }
  } catch (e) {
    console.error('cleanup error', e);
  }
  const cnt = async (t: string, col: string, pat: string) => ((await admin.from(t).select('*', { count: 'exact', head: true }).like(col, pat)).count ?? -1);
  residue.posts = await cnt('resource_posts', 'slug', `${RUN}%`);
  residue.sources = await cnt('resource_sources', 'source_name', `${RUN}%`);
  residue.categories = await cnt('resource_categories', 'slug', `${RUN}%`);
  residue.tags = await cnt('resource_tags', 'slug', `${RUN}%`);
  residue.authors = await cnt('resource_authors', 'slug', `${RUN}%`);
  residue.ctas = await cnt('resource_ctas', 'name', `${RUN}%`);
  residue.importRuns = ids.length ? ((await admin.from('resource_content_import_runs').select('*', { count: 'exact', head: true }).in('uploaded_by', ids).gte('created_at', since)).count ?? -1) : 0;
  residue.importRowsTotal = (await admin.from('resource_content_import_rows').select('*', { count: 'exact', head: true })).count ?? -1;
  residue.postsByFixturesInWindow = ids.length ? ((await admin.from('resource_posts').select('*', { count: 'exact', head: true }).in('created_by', ids).gte('created_at', since)).count ?? -1) : 0;
  residue.auditByFixturesInWindow = ids.length ? ((await admin.from('resource_audit_log').select('*', { count: 'exact', head: true }).in('actor_user_id', ids).gte('created_at', since)).count ?? -1) : 0;
  residue.workflowByFixturesInWindow = ids.length ? ((await admin.from('resource_workflow_history').select('*', { count: 'exact', head: true }).in('actor_user_id', ids).gte('created_at', since)).count ?? -1) : 0;
  const restoredProfiles = await restoreBorrowedProfiles(admin);
  residue.fixtureProfilesNotRestored = restoredProfiles.stillDifferent;
  evidence.fixtureProfilesRestored = restoredProfiles.restored;
  const { data: au } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  residue.authUsersCreatedByRun = (au?.users ?? []).filter((u) => (u.email ?? '').startsWith(`${RUN}-`)).length;
  evidence.residue = residue;
  check('CLEANUP: synthetic posts, sources, categories, tags, authors, CTAs, import runs/rows, audit and workflow rows made by this run, and created auth users all 0', Object.values(residue).every((v) => v === 0), JSON.stringify(residue));
}

(async () => {
  let fatal: unknown = null;
  try {
    await main();
  } catch (e) {
    fatal = e;
    console.error('FATAL', e);
    check('harness completed without a fatal error', false, String((e as Error)?.stack ?? e).slice(0, 400));
  } finally {
    await cleanup();
    const failed = results.filter((r) => !r.pass);
    evidence.finishedAt = new Date().toISOString();
    evidence.passed = results.length - failed.length;
    evidence.failed = failed.length;
    evidence.checks = results;
    const out = path.join(ROOT, 'docs', 'resources', `RESOURCE_BULK_UPLOAD_DEV_EVIDENCE_${RUN}.json`);
    fs.writeFileSync(out, JSON.stringify(evidence, null, 2));
    console.log(`\n${results.length - failed.length}/${results.length} checks passed. Evidence: ${out}`);
    if (failed.length) for (const f of failed) console.log(`  FAILED: ${f.name} :: ${f.detail}`);
    process.exit(failed.length || fatal ? 1 : 0);
  }
})();
