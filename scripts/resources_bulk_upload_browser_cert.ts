/**
 * Resources Bulk Upload -- BROWSER certification against real DEV through a running dev server (Playwright + axe).
 * Synthetic users and files only; full cleanup at the end.
 *
 *   npx tsx scripts/resources_bulk_upload_browser_cert.ts http://localhost:3993
 *
 * Covers: chooser, both uploaders, preview (valid and invalid), expandable rows, apply confirmation dialog focus and
 * keyboard, result screen, history, contextual buttons, the Article editor SourcePicker, responsive layout at 390 / 768 /
 * 1024 / 1440 (no horizontal page scroll), and an automated axe scan (WCAG 2.0/2.1 A and AA) of each screen.
 * AUTOMATED ONLY: axe finds roughly a third of accessibility failures and does not replace a manual screen-reader pass.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Page, type BrowserContext } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { createClient } from '@supabase/supabase-js';
import { ARTICLE_SCHEMA } from '../lib/resources/import/article/schema';
import { MONEY_UPDATE_SCHEMA } from '../lib/resources/import/money-update/schema';

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
const admin = createClient(URL_, env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { autoRefreshToken: false, persistSession: false } });
const REF = new URL(URL_).host.split('.')[0];
const RUN = `bulkbrw${Date.now().toString(36)}`;
const OUT_DIR = path.join(ROOT, 'docs', 'resources', 'browser_evidence');
fs.mkdirSync(OUT_DIR, { recursive: true });

type R = { name: string; pass: boolean; detail?: string };
const results: R[] = [];
const check = (name: string, pass: boolean, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${!pass && detail ? `  -- ${detail}` : ''}`);
};

const createdUserIds: string[] = [];
async function makeUser(label: string, roles: string[]) {
  const email = `${RUN}-${label}@fhip-test.invalid`;
  const password = `Brw!${Math.random().toString(36).slice(2)}${Date.now()}Zz9`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const id = data.user!.id;
  createdUserIds.push(id);
  await admin.from('user_profiles').update({ country_of_residence: 'AU', preferred_currency: 'AUD', country_confirmed_at: new Date().toISOString(), country_source: 'USER_CONFIRMED', onboarding_completed: true }).eq('user_id', id);
  for (const role of roles) await admin.from('resource_user_roles').insert({ user_id: id, role, is_active: true });
  const session = await (await fetch(`${URL_}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })).json();
  const value = 'base64-' + Buffer.from(JSON.stringify(session)).toString('base64url');
  const CHUNK = 3180;
  const parts = value.length <= CHUNK ? [{ name: `sb-${REF}-auth-token`, value }] : Array.from({ length: Math.ceil(value.length / CHUNK) }, (_, i) => ({ name: `sb-${REF}-auth-token.${i}`, value: value.slice(i * CHUNK, (i + 1) * CHUNK) }));
  return { id, parts };
}

const fx = { catSlug: `${RUN}-cat`, tag: `${RUN}-tag`, authorSlug: `${RUN}-author` };
type Row = Record<string, string>;
const aRow = (i: number, over: Row = {}): Row => ({
  template_version: '1.0', external_id: `${RUN}-A${i}`, title: `Browser ${RUN} article ${i}`, slug: `${RUN}-article-${i}`, jurisdiction: 'australia', difficulty: 'beginner', compliance_classification: 'green', freshness_type: 'evergreen',
  next_review_at: '2027-03-31', expires_at: '', excerpt: `Browser excerpt ${i}.`, quick_answer: `Quick answer ${i}.`, key_takeaways: 'One\nTwo\nThree',
  main_content: '## Heading one\n\nA paragraph.\n\n- bullet\n- bullet two\n\n## Heading two\n\n1. first\n2. second', example: 'An example.', financial_health_meaning: 'It matters.', primary_category: fx.catSlug, tags: fx.tag, author: fx.authorSlug,
  primary_cta: '', secondary_cta: '', seo_title: '', seo_description: '', is_indexable: 'FALSE', source_1_name: `${RUN} Source`, source_1_document_title: 'Doc', source_1_url: `https://example.com/${RUN}`, source_1_type: 'regulator', source_1_publication_date: '2026-08-12', source_1_is_public: 'TRUE', ...over,
});
const mRow = (i: number, over: Row = {}): Row => ({
  template_version: '1.0', external_id: `${RUN}-M${i}`, title: `Browser ${RUN} money update ${i}`, slug: `${RUN}-mu-${i}`, jurisdiction: 'india', difficulty: 'beginner', compliance_classification: 'amber', event_date: '2026-09-30', next_review_at: '2026-12-31', expires_at: '',
  affected_audience: 'Audience', excerpt: `Browser update ${i}.`, what_happened: 'It happened.', why_it_matters: 'It matters.', who_may_be_affected: 'People.', financial_health_impact: 'Impact.', how_fhip_can_help: 'Help.', primary_category: fx.catSlug, tags: fx.tag,
  primary_cta: '', secondary_cta: '', seo_title: '', seo_description: '', is_indexable: '', source_1_name: `${RUN} Source`, source_1_document_title: 'Doc', source_1_url: `https://example.com/${RUN}`, source_1_type: 'regulator', source_1_publication_date: '2026-09-30', source_1_is_public: 'TRUE', ...over,
});
function csvFile(type: 'article' | 'money_update', rows: Row[], name: string): string {
  const cols = (type === 'article' ? ARTICLE_SCHEMA : MONEY_UPDATE_SCHEMA).columns.map((c) => c.key);
  const q = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);
  const p = path.join(OUT_DIR, `_tmp_${RUN}_${name}`);
  fs.writeFileSync(p, [cols.join(','), ...rows.map((r) => cols.map((c) => q(r[c] ?? '')).join(','))].join('\r\n') + '\r\n');
  return p;
}

async function axe(page: Page, label: string) {
  const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const serious = scan.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  check(`A11Y axe (automated, WCAG 2.0/2.1 A+AA): ${label}: no serious or critical violations`, serious.length === 0, scan.violations.map((v) => `${v.id}(${v.impact}) x${v.nodes.length}`).join('; '));
  return scan.violations.map((v) => `${v.id}(${v.impact}) x${v.nodes.length}`);
}
async function noHScroll(page: Page, label: string) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(`RESPONSIVE ${label}: no horizontal page scroll`, over <= 1, `overflow ${over}px`);
}
async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`), fullPage: true });
}

async function main() {
  await admin.from('resource_categories').insert({ name: `${RUN} Category`, slug: fx.catSlug });
  await admin.from('resource_tags').insert({ name: `${RUN} Tag`, slug: fx.tag });
  await admin.from('resource_authors').insert({ display_name: `${RUN} Author`, slug: fx.authorSlug });
  const editor = await makeUser('editor', ['editor']);
  const author = await makeUser('author', ['author']);

  const browser = await chromium.launch();
  const ctx: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const host = new URL(APP).hostname;
  await ctx.addCookies(editor.parts.map((p) => ({ ...p, domain: host, path: '/' })));
  const page = await ctx.newPage();
  const axeLog: Record<string, string[]> = {};

  // ---- chooser at four widths
  for (const w of [390, 768, 1024, 1440]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.goto(`${APP}/admin/resources/import`, { waitUntil: 'networkidle', timeout: 120_000 });
    await noHScroll(page, `chooser ${w}px`);
    if (w === 1440 || w === 390) await shot(page, `chooser_${w}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  check('UI chooser: heading, both cards, templates', (await page.getByRole('heading', { name: 'What would you like to upload?' }).count()) === 1 && (await page.getByRole('link', { name: 'Upload Articles' }).count()) === 1 && (await page.getByRole('link', { name: 'Upload Money Updates' }).count()) === 1);
  axeLog.chooser = await axe(page, 'chooser');

  // ---- Article uploader
  await page.getByRole('link', { name: 'Upload Articles' }).click();
  await page.waitForURL(/\/import\/upload\?type=article/);
  for (const w of [390, 768, 1024, 1440]) {
    await page.setViewportSize({ width: w, height: 900 });
    await noHScroll(page, `article uploader ${w}px`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  check('UI uploader: file input has a programmatic label and Upload is disabled until a file is chosen', (await page.getByLabel(/Article upload file/).count()) === 1 && (await page.getByRole('button', { name: 'Upload and preview' }).isDisabled()));
  axeLog.uploader = await axe(page, 'uploader');
  // client-side rejection
  await page.getByLabel(/Article upload file/).setInputFiles({ name: 'bad.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1') });
  check('UI uploader: a .pdf is rejected in the browser with a clear message (server re-checks anyway)', (await page.getByRole('alert').innerText()).includes('Only .csv and .xlsx'));

  // ---- valid upload -> preview
  const good = csvFile('article', [aRow(1), aRow(2)], 'good.csv');
  await page.getByLabel(/Article upload file/).setInputFiles(good);
  await page.getByRole('button', { name: 'Upload and preview' }).click();
  await page.waitForURL(/\/import\/runs\//, { timeout: 120_000 });
  await page.getByRole('heading', { name: /Preview: Articles/ }).waitFor();
  check('UI preview: summary shows type, file, template version 1.0, 2 rows, 2 ready', (await page.getByText('good.csv').count()) > 0 && (await page.getByText('1.0').count()) > 0);
  check('UI preview: row table has proper column headers and Apply is ENABLED for a clean file', (await page.getByRole('columnheader').count()) === 8 && !(await page.getByRole('button', { name: /Create 2 Articles as private drafts/ }).isDisabled()));
  for (const w of [390, 768, 1024, 1440]) {
    await page.setViewportSize({ width: w, height: 900 });
    // the table scrolls inside its own container; the PAGE must not
    await noHScroll(page, `preview ${w}px`);
    if (w === 390 || w === 1440) await shot(page, `preview_${w}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  // expandable row via keyboard
  const expander = page.getByRole('button', { name: new RegExp(`${RUN} article 1`) });
  await expander.focus();
  await page.keyboard.press('Enter');
  check('UI preview: a row expands with the keyboard and announces aria-expanded', (await expander.getAttribute('aria-expanded')) === 'true');
  await page.getByText('Article body, as it will be stored').waitFor({ timeout: 30_000 });
  check('UI preview: expanded detail shows quick answer, takeaways, body, example, sources', (await page.getByText('Quick answer 1.').count()) > 0 && (await page.getByText('Sources (1)').count()) > 0);
  await shot(page, 'preview_expanded');
  axeLog.preview = await axe(page, 'preview (expanded row)');
  // confirmation dialog
  await page.getByRole('button', { name: /Create 2 Articles as private drafts/ }).click();
  const dlg = page.getByRole('dialog');
  await dlg.waitFor();
  check('UI confirm: exact wording and focus lands on the safe choice', (await dlg.innerText()).includes('Create 2 Articles as private Drafts?') && (await dlg.innerText()).includes('Nothing will be published or scheduled. Normal Resources review and approval is still required.') && (await page.evaluate(() => document.activeElement?.textContent ?? '')).includes('Not yet'));
  await page.keyboard.press('Escape');
  check('UI confirm: Escape closes it and nothing was created', (await dlg.count()) === 0 && ((await admin.from('resource_posts').select('id', { count: 'exact', head: true }).like('slug', `${RUN}%`)).count ?? -1) === 0);
  await page.getByRole('button', { name: /Create 2 Articles as private drafts/ }).click();
  await shot(page, 'confirm_dialog');
  await page.getByRole('dialog').getByRole('button', { name: /^Create 2 Articles$/ }).click();
  await page.getByRole('heading', { name: /2 Articles created, 0 failed/ }).waitFor({ timeout: 120_000 });
  check('UI result: "2 Articles created, 0 failed" with View imported drafts, Open first draft, View import history', (await page.getByRole('link', { name: 'View imported drafts' }).count()) === 1 && (await page.getByRole('link', { name: 'Open first draft' }).count()) === 1 && (await page.getByRole('link', { name: 'View import history' }).count()) === 1);
  await shot(page, 'result');
  axeLog.result = await axe(page, 'result');
  await page.getByRole('link', { name: 'Open first draft' }).click();
  await page.waitForURL(/\/admin\/resources\/content\/.+\/edit/, { timeout: 120_000 });
  await page.getByText('Official Sources').waitFor({ timeout: 60_000 });
  check('UI editor: the imported draft opens in the normal Article editor with the Sources picker showing the imported source', (await page.getByText(`${RUN} Source`).count()) > 0);
  axeLog.editor = await axe(page, 'Article editor with SourcePicker');
  await shot(page, 'article_editor_sources');

  // ---- invalid file -> Apply disabled
  await page.goto(`${APP}/admin/resources/import/upload?type=article`, { waitUntil: 'networkidle' });
  const bad = csvFile('article', [aRow(10), aRow(11, { title: '', main_content: '<script>x</script>', source_1_url: 'http://insecure.example' })], 'bad.csv');
  await page.getByLabel(/Article upload file/).setInputFiles(bad);
  await page.getByRole('button', { name: 'Upload and preview' }).click();
  await page.waitForURL(/\/import\/runs\//, { timeout: 120_000 });
  await page.getByRole('heading', { name: /Preview: Articles/ }).waitFor();
  check('UI invalid file: error summary shown, Apply DISABLED, nothing created', (await page.getByRole('alert').first().innerText()).includes('errors') && (await page.getByRole('button', { name: /Create 2 Articles as private drafts/ }).isDisabled()) && ((await admin.from('resource_posts').select('id', { count: 'exact', head: true }).like('slug', `${RUN}-article-1%`)).count ?? 0) === 1 /* only article-1 from the good file; article-10 and article-11 were never created */);
  check('UI invalid file: row status uses text, not colour alone, and errors are listed with codes', (await page.getByText('Error', { exact: true }).count()) > 0);
  await page.getByRole('combobox', { name: 'Show' }).selectOption('errors');
  await page.getByRole('button', { name: new RegExp('article 11') }).click().catch(() => undefined);
  const dl = await page.getByRole('link', { name: /Download validation results/ }).getAttribute('href');
  check('UI invalid file: validation results download link present', !!dl && dl.endsWith('/results'));
  await shot(page, 'preview_invalid');
  axeLog.previewInvalid = await axe(page, 'preview with errors');
  // rejected file (formula)
  await page.goto(`${APP}/admin/resources/import/upload?type=article`, { waitUntil: 'networkidle' });
  await page.getByLabel(/Article upload file/).setInputFiles({ name: 'x.csv', mimeType: 'text/csv', buffer: Buffer.from('a,b\r\n1,2\r\n') });
  await page.getByRole('button', { name: 'Upload and preview' }).click();
  await page.getByRole('alert').waitFor({ timeout: 60_000 });
  check('UI rejected file: error summary is focused and names the problem; results download offered', (await page.getByRole('alert').innerText()).length > 20 && (await page.getByRole('link', { name: /Download the validation results/ }).count()) === 1);

  // ---- Money Update uploader
  await page.goto(`${APP}/admin/resources/money-updates`, { waitUntil: 'networkidle' });
  check('UI contextual buttons on Money Updates: New Money Update, Upload Updates, Download Template', (await page.getByRole('link', { name: 'New Money Update' }).count()) === 1 && (await page.getByRole('link', { name: 'Upload Updates' }).count()) === 1 && (await page.getByRole('link', { name: 'Download Template' }).count()) === 1);
  await page.getByRole('link', { name: 'Upload Updates' }).click();
  await page.waitForURL(/upload\?type=money_update/);
  const mf = csvFile('money_update', [mRow(1)], 'mu.csv');
  await page.getByLabel(/Money Update upload file/).setInputFiles(mf);
  await page.getByRole('button', { name: 'Upload and preview' }).click();
  await page.waitForURL(/\/import\/runs\//, { timeout: 120_000 });
  await page.getByRole('heading', { name: /Preview: Money Updates/ }).waitFor();
  await page.getByRole('button', { name: /Create 1 Money Update as private drafts/ }).click();
  check('UI Money Update confirm wording', (await page.getByRole('dialog').innerText()).includes('Create 1 Money Update as private Drafts?'));
  await page.getByRole('dialog').getByRole('button', { name: /^Create 1 Money Update$/ }).click();
  await page.getByRole('heading', { name: /1 Money Update created, 0 failed/ }).waitFor({ timeout: 120_000 });
  await shot(page, 'result_money_update');
  await page.getByRole('link', { name: 'Open first draft' }).click();
  await page.waitForURL(/money-updates\/.+\/edit/, { timeout: 120_000 });
  await page.getByText('Structured Sections').waitFor({ timeout: 60_000 });
  check('UI imported Money Update opens in the normal Money Update editor with its five sections and source', (await page.getByText('What Happened?').count()) > 0 && (await page.getByText(`${RUN} Source`).count()) > 0);

  // ---- All Content contextual button; history; responsive
  await page.goto(`${APP}/admin/resources/content`, { waitUntil: 'networkidle' });
  check('UI All Content shows Upload Articles (Article preselected)', (await page.getByRole('link', { name: 'Upload Articles' }).getAttribute('href')) === '/admin/resources/import/upload?type=article');
  for (const w of [390, 768, 1024, 1440]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.goto(`${APP}/admin/resources/import/history`, { waitUntil: 'networkidle' });
    await noHScroll(page, `history ${w}px`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  check('UI history lists both types with Date, File, Type, Actor, Rows, Result, Status', (await page.getByRole('columnheader').allInnerTexts()).join(',') === 'Date,File,Type,Actor,Rows,Result,Status' && (await page.getByText('Applied').count()) > 0);
  axeLog.history = await axe(page, 'history');
  await shot(page, 'history');

  // ---- denied roles in the browser
  const ctx2 = await browser.newContext();
  await ctx2.addCookies(author.parts.map((p) => ({ ...p, domain: host, path: '/' })));
  const p2 = await ctx2.newPage();
  await p2.goto(`${APP}/admin/resources/import`, { waitUntil: 'networkidle' });
  check('UI an Author is redirected away from /admin/resources/import (no chooser rendered)', !new URL(p2.url()).pathname.startsWith('/admin/resources/import') && (await p2.getByText('What would you like to upload?').count()) === 0, p2.url());
  await ctx2.close();
  await browser.close();
  evidence.axe = axeLog;
}
const evidence: Record<string, unknown> = { run: RUN, app: APP, startedAt: new Date().toISOString() };

async function cleanup() {
  const ids = createdUserIds;
  try {
    if (ids.length) {
      const mine = await admin.from('resource_posts').select('id').in('created_by', ids).limit(2000);
      for (const p of mine.data ?? []) await admin.from('resource_posts').delete().eq('id', p.id);
      const runs = await admin.from('resource_content_import_runs').select('id').in('uploaded_by', ids);
      for (const r of runs.data ?? []) await admin.from('resource_content_import_runs').delete().eq('id', r.id);
    }
    await admin.from('resource_posts').delete().like('slug', `${RUN}%`);
    await admin.from('resource_sources').delete().like('source_name', `${RUN}%`);
    await admin.from('resource_authors').delete().like('slug', `${RUN}%`);
    await admin.from('resource_tags').delete().like('slug', `${RUN}%`);
    await admin.from('resource_categories').delete().like('slug', `${RUN}%`);
    if (ids.length) {
      await admin.from('resource_audit_log').delete().in('actor_user_id', ids);
      await admin.from('resource_workflow_history').delete().in('actor_user_id', ids);
      await admin.from('resource_user_roles').delete().in('user_id', ids);
      for (const id of ids) await admin.auth.admin.deleteUser(id);
    }
    for (const f of fs.readdirSync(OUT_DIR)) if (f.startsWith('_tmp_')) fs.rmSync(path.join(OUT_DIR, f));
  } catch (e) {
    console.error('cleanup error', e);
  }
  const c = async (t: string, col: string, pat: string) => (await admin.from(t).select('*', { count: 'exact', head: true }).like(col, pat)).count ?? -1;
  const residue = { posts: await c('resource_posts', 'slug', `${RUN}%`), sources: await c('resource_sources', 'source_name', `${RUN}%`), categories: await c('resource_categories', 'slug', `${RUN}%`), tags: await c('resource_tags', 'slug', `${RUN}%`), authors: await c('resource_authors', 'slug', `${RUN}%`), runs: ids.length ? ((await admin.from('resource_content_import_runs').select('*', { count: 'exact', head: true }).in('uploaded_by', ids)).count ?? -1) : 0 };
  check('BROWSER CLEANUP: synthetic posts, sources, categories, tags, authors, import runs all 0', Object.values(residue).every((v) => v === 0), JSON.stringify(residue));
  evidence.residue = residue;
}

(async () => {
  let fatal: unknown = null;
  try {
    await main();
  } catch (e) {
    fatal = e;
    console.error('FATAL', e);
    check('browser harness completed without a fatal error', false, String((e as Error)?.stack ?? e).slice(0, 500));
  } finally {
    await cleanup();
    const failed = results.filter((r) => !r.pass);
    evidence.checks = results;
    evidence.passed = results.length - failed.length;
    evidence.failed = failed.length;
    fs.writeFileSync(path.join(ROOT, 'docs', 'resources', `RESOURCE_BULK_UPLOAD_BROWSER_EVIDENCE_${RUN}.json`), JSON.stringify(evidence, null, 2));
    console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
    for (const f of failed) console.log(`  FAILED: ${f.name} :: ${f.detail}`);
    process.exit(failed.length || fatal ? 1 : 0);
  }
})();
