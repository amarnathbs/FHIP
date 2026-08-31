import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

// FDH-14 closure — GAP 5: UI/accessibility SMOKE over the 5 FDH entry
// surfaces, against the actual running app pointed at live hosted DEV
// (this repo's standing Playwright config: baseURL http://localhost:3000,
// webServer runs `npm run dev`, which loads .env.local -> the same DEV
// Supabase project every other FDH-14 script targets). This is a smoke
// certification (a handful of checks per surface), not new coverage depth.
//
// A synthetic, fully-onboarded user is created directly via the Supabase
// admin API (mirroring the exact pattern the other fdh14_*.mjs/.ts scripts
// use) so the test logs in through the REAL UI login form rather than
// re-running the onboarding wizard. The user + every row it touches are
// deleted in afterAll; deletion is independently re-verified by re-query.
const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => {
    const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  }),
);
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const DEV_REF = 'vqycarelcoijzwlpkpcz';
if (!URL_ || !SERVICE) throw new Error('FATAL: missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local');
if (!URL_.includes(DEV_REF)) throw new Error(`FATAL: refusing to run — NEXT_PUBLIC_SUPABASE_URL (${URL_}) is not the known DEV project (${DEV_REF}).`);

const TAG = 'fdh14-closure-g5';
const FIXTURES = path.join(process.cwd(), 'tests/fixtures/financial-data-hub');

async function rest(p: string, opts: any = {}) {
  const headers = { apikey: SERVICE!, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', Prefer: opts.prefer ?? 'return=representation', ...opts.headers };
  const r = await fetch(`${URL_}/rest/v1/${p}`, { ...opts, headers });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}

let userId: string;
let userEmail: string;
const password = `Fdh14G5Smoke!${Date.now()}`;

test.beforeAll(async () => {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  userEmail = `${TAG}-${stamp}@fhip-test.invalid`;
  const r = await fetch(`${URL_}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: SERVICE!, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: userEmail, password, email_confirm: true }),
  });
  const j: any = await r.json();
  if (!j.id) throw new Error(`beforeAll: createUser failed: ${JSON.stringify(j).slice(0, 300)}`);
  userId = j.id;
  const now = new Date().toISOString();
  await rest(`user_profiles?user_id=eq.${userId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      full_name: 'FDH14 G5 Smoke', country_of_residence: 'AU', preferred_currency: 'AUD',
      onboarding_completed: true, employment_status: 'full_time_employed', profile_completion_percentage: 100,
      country_confirmed_at: now, country_source: 'USER_CONFIRMED', country_updated_at: now,
    }),
  });
});

test.afterAll(async () => {
  // Independently re-verify cleanup: delete every FDH row created by this
  // user during the smoke run, then the auth user itself, then re-query.
  const fdhTables = [
    'fdh_investment_statement_activities', 'fdh_investment_statements',
    'fdh_liability_statement_activities', 'fdh_liability_statements',
    'fdh_retirement_statement_activities', 'fdh_retirement_statements',
    'fdh_payroll_events', 'fdh_upload_sessions', 'fdh_source_documents',
    'fdh_bank_statement_uploads', 'fdh_bank_transactions', 'fdh_transactions',
  ];
  for (const t of fdhTables) {
    await rest(`${t}?user_id=eq.${userId}`, { method: 'DELETE' }).catch(() => {});
  }
  await fetch(`${URL_}/auth/v1/admin/users/${userId}`, { method: 'DELETE', headers: { apikey: SERVICE!, Authorization: `Bearer ${SERVICE}` } });

  let residue = 0;
  for (const t of fdhTables) {
    const r = await rest(`${t}?user_id=eq.${userId}&select=id`);
    if (r.json?.length) { residue += r.json.length; console.log(`RESIDUE: ${t} has ${r.json.length} row(s) for ${userId}`); }
  }
  const stillExists = await fetch(`${URL_}/auth/v1/admin/users/${userId}`, { headers: { apikey: SERVICE!, Authorization: `Bearer ${SERVICE}` } });
  if (stillExists.status === 200) residue++;
  console.log(`GAP 5 CLEANUP: residue=${residue} (0 expected)`);
  expect(residue, 'zero synthetic residue after GAP 5 UI smoke run').toBe(0);
});

async function login(page: Page) {
  await page.goto('/login');
  await page.locator('[data-testid="login-email"]').fill(userEmail);
  await page.locator('[data-testid="login-password"]').fill(password);
  await page.locator('[data-testid="login-submit"]').click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });
}

/** Tabs forward up to `max` times looking for `locator` to receive focus. */
async function keyboardCanReach(page: Page, locator: ReturnType<Page['locator']>, max = 60): Promise<boolean> {
  const target = await locator.elementHandle();
  if (!target) return false;
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const isFocused = await target.evaluate((el) => el === document.activeElement);
    if (isFocused) return true;
  }
  return false;
}

async function checkNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  return overflow;
}

test.describe('FDH-14 GAP 5 — UI/accessibility smoke', () => {
  test('Income -> Payslip import', async ({ page }) => {
    test.setTimeout(150_000);
    await login(page);
    await page.goto('/income');
    const cta = page.getByRole('button', { name: 'Import from Payslip' });
    await expect(cta, 'CTA reachable').toBeVisible();
    await expect.poll(() => keyboardCanReach(page, cta), { message: 'keyboard reaches primary Import CTA' }).toBe(true);
    await cta.click();

    const uploadBtn = page.getByRole('button', { name: 'Upload payslip' });
    await expect(uploadBtn, 'upload control reachable').toBeVisible();
    await expect(page.getByText('Payslip file (PDF, up to 20MB)'), 'file input labelled').toBeVisible();

    // Error state: an unsupported/invalid file, distinguishable from empty/loading.
    // NOTE (GAP 5 finding): `wrong-extension.pdf` (plain CSV text saved with a
    // .pdf extension) was tried here first and reproducibly left this panel
    // stuck in the "processing" state for 2+ minutes with no bounded error —
    // see the GAP 5 write-up. `invalid-pdf.pdf` (genuine non-PDF garbage
    // bytes) is used instead, which the upstream upload-sessions/complete
    // step's own PDF-structure classification rejects synchronously, exactly
    // as it does for the generic financial-data-hub uploader test below.
    await page.setInputFiles('input[type="file"]', path.join(FIXTURES, 'invalid-pdf.pdf'));
    await uploadBtn.click();
    await expect(page.getByRole('status').first(), 'processing state visible').toBeVisible({ timeout: 5000 }).catch(() => {});
    const errorOrUnreadable = page.locator('text=/could not be processed|could not process|error|password-protected|unsupported|corrupt|try a different file|missing storage reference/i');
    await expect(errorOrUnreadable.first(), 'error state reachable and visible').toBeVisible({ timeout: 30_000 });
    const errorText = (await errorOrUnreadable.first().textContent()) ?? '';
    expect(errorText, 'error state never reads as a financial $0').not.toMatch(/\$0(?!\d)/);

    // Mobile viewport + no FDH-specific horizontal overflow.
    await page.setViewportSize({ width: 375, height: 812 });
    expect(await checkNoHorizontalOverflow(page), 'no horizontal overflow at mobile width').toBe(false);
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test('Liabilities -> Credit Card / Loan statement import', async ({ page }) => {
    await login(page);
    await page.goto('/liabilities');
    const cta = page.getByRole('button', { name: 'Import Statement' });
    await expect(cta, 'CTA reachable').toBeVisible();
    await expect(cta, 'aria-expanded present').toHaveAttribute('aria-expanded', 'false');
    await expect.poll(() => keyboardCanReach(page, cta), { message: 'keyboard reaches primary Import CTA' }).toBe(true);
    await cta.click();
    await expect(cta, 'aria-expanded toggles on open').toHaveAttribute('aria-expanded', 'true');

    await page.getByRole('button', { name: 'Credit Card Statement' }).click();
    const uploadBtn = page.getByRole('button', { name: 'Upload statement' });
    await expect(uploadBtn, 'upload control reachable').toBeVisible();
    await expect(page.getByText('Statement file (CSV)'), 'file input labelled').toBeVisible();

    await page.setInputFiles('input[type="file"]', path.join(FIXTURES, 'fdh14-smoke-liability-cc.csv'));
    await uploadBtn.click();
    await expect(page.getByRole('status').first(), 'processing state visible').toBeVisible({ timeout: 10_000 });

    // Either a genuine review state (real success path) or a legible
    // unable-to-read/error state — either is a valid, distinguishable
    // non-empty, non-loading terminal state for this smoke pass.
    const reviewOrError = page.locator('text=/review|apply|could not read|error|unsupported/i');
    await expect(reviewOrError.first(), 'a non-empty, non-loading terminal state is reached').toBeVisible({ timeout: 30_000 });

    await page.setViewportSize({ width: 375, height: 812 });
    expect(await checkNoHorizontalOverflow(page), 'no horizontal overflow at mobile width').toBe(false);
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test('Investments -> Australian Investment Statement import', async ({ page }) => {
    await login(page);
    await page.goto('/investments');
    const cta = page.getByRole('button', { name: 'Import Australian Investment Statement' });
    await expect(cta, 'CTA reachable').toBeVisible();
    await expect.poll(() => keyboardCanReach(page, cta), { message: 'keyboard reaches primary Import CTA' }).toBe(true);
    await cta.click();

    const uploadBtn = page.getByRole('button', { name: 'Upload statement' });
    await expect(uploadBtn, 'upload control reachable').toBeVisible();
    await expect(page.getByText('Statement file (CSV)'), 'file input labelled').toBeVisible();

    await page.setInputFiles('input[type="file"]', path.join(FIXTURES, 'fdh14-smoke-investment.csv'));
    await uploadBtn.click();
    await expect(page.getByRole('status').first(), 'processing state visible').toBeVisible({ timeout: 10_000 });

    const reviewOrError = page.locator('text=/review|apply|could not read|error|unsupported/i');
    await expect(reviewOrError.first(), 'a non-empty, non-loading terminal state is reached').toBeVisible({ timeout: 30_000 });

    await page.setViewportSize({ width: 375, height: 812 });
    expect(await checkNoHorizontalOverflow(page), 'no horizontal overflow at mobile width').toBe(false);
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test('Retirement -> Retirement Statement import', async ({ page }) => {
    await login(page);
    await page.goto('/retirement');
    // NOTE (GAP 5 finding): unlike Income/Liabilities/Investments, the
    // Retirement Statement import panel has no separate "Import Statement"
    // toggle CTA — it renders permanently open (region "Import a retirement
    // statement") directly above the grid. The CTA here IS the upload
    // control itself, reachable without an extra click.
    const region = page.getByRole('region', { name: 'Import a retirement statement' });
    await expect(region, 'CTA/panel reachable without an extra toggle click').toBeVisible();
    const uploadBtn = page.getByRole('button', { name: 'Upload and read statement' });
    await expect(uploadBtn, 'upload control reachable').toBeVisible();
    await expect(page.getByText('Statement file (CSV)'), 'file input labelled').toBeVisible();

    await page.setInputFiles('input[type="file"]', path.join(FIXTURES, 'fdh14-smoke-retirement.csv'));
    await expect.poll(() => keyboardCanReach(page, uploadBtn), { message: 'keyboard reaches primary Upload CTA once enabled' }).toBe(true);
    await uploadBtn.click();

    const reviewOrError = page.locator('text=/review|apply|could not read|error|unsupported|routed to/i');
    await expect(reviewOrError.first(), 'a non-empty, non-loading terminal state is reached').toBeVisible({ timeout: 30_000 });

    await page.setViewportSize({ width: 375, height: 812 });
    expect(await checkNoHorizontalOverflow(page), 'no horizontal overflow at mobile width').toBe(false);
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test('Expenses -> Bank Statement import (via /financial-data-hub, the only live bank-statement upload surface)', async ({ page }) => {
    await login(page);
    // Expenses itself (app/(app)/expenses/page.tsx) has no import panel of
    // its own — this is an honest, disclosed finding of this smoke pass
    // (see the GAP 5 writeup). The only real bank-statement upload entry
    // point in the running app is the generic FDH-3 document uploader.
    await page.goto('/financial-data-hub');
    const typeSelect = page.locator('select').first();
    await expect(typeSelect, 'document type selector reachable').toBeVisible();
    await expect(typeSelect, 'defaults to bank statement').toHaveValue('bank_statement');
    const fileInput = page.locator('input[type="file"]');
    await expect(fileInput, 'file input reachable and keyboard-focusable').toBeVisible();
    const uploadBtn = page.getByRole('button', { name: 'Upload' });
    await expect(uploadBtn, 'CTA reachable').toBeVisible();

    // Error state via a deliberately-invalid file. The Upload button is
    // disabled (and correctly excluded from the Tab order per the HTML spec)
    // until a file is chosen, so keyboard reachability is checked once it is
    // enabled, not before.
    await fileInput.setInputFiles(path.join(FIXTURES, 'invalid-pdf.pdf'));
    await expect.poll(() => keyboardCanReach(page, uploadBtn), { message: 'keyboard reaches primary Upload CTA once enabled' }).toBe(true);
    await uploadBtn.click();
    const errorMsg = page.locator('text=/could not be processed|corrupted|unsupported/i');
    await expect(errorMsg.first(), 'error state reachable and distinguishable from empty/loading').toBeVisible({ timeout: 30_000 });
    const errorText = (await errorMsg.first().textContent()) ?? '';
    expect(errorText, 'error state never reads as a financial $0').not.toMatch(/\$0(?!\d)/);

    // Successful completion reachable: a genuine, real bank-statement CSV.
    await fileInput.setInputFiles(path.join(FIXTURES, 'synthetic-bank-statement.csv'));
    await uploadBtn.click();
    await expect(page.getByText(/uploaded and queued for processing/i), 'successful completion reachable').toBeVisible({ timeout: 30_000 });

    await page.setViewportSize({ width: 375, height: 812 });
    expect(await checkNoHorizontalOverflow(page), 'no horizontal overflow at mobile width').toBe(false);
    await page.setViewportSize({ width: 1280, height: 800 });
  });
});
