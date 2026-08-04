import { test, expect, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

// Reuses the exact signup -> onboarding steps from onboarding.spec.ts so a
// fresh, real, authenticated session exists for every test in this file
// without depending on any pre-existing account or password.
async function signUpAndOnboard(page: Page, email: string, password: string) {
  await page.goto('/signup');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /sign up/i }).click();
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByLabel('Full name').fill('Nav Test User');
  await page.getByRole('button', { name: /continue/i }).click(); // profile -> household
  await page.getByRole('button', { name: /continue/i }).click(); // household -> countries
  await page.getByRole('button', { name: /continue/i }).click(); // countries -> goals
  await page.getByRole('button', { name: /continue/i }).click(); // goals -> review
  await page.getByRole('button', { name: /finish/i }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

const USER_AUTH = path.join(__dirname, '.auth-nav-user.json');
const ADMIN_AUTH = path.join(__dirname, '.auth-nav-admin.json');

const REQUIRED_ORDER = [
  'Dashboard',
  'Input Data',
  'Investments',
  'Insurance',
  'Goals',
  'Scores',
  'DNA',
  'Resilience',
  'Twin / Benchmark',
  'Forecasting',
  'Reports',
];

// Playwright treats each distinct combination of describe-level test.use()
// overrides (viewport, storageState) as its own worker context, so this
// beforeAll actually runs once per such combination in this file, not once
// globally — each run creates its own fresh pair of real Supabase users, all
// self-contained and disposed of via afterAll. storageState: undefined is
// required on these throwaway contexts: without it, Playwright resolves a
// storageState from a later describe's test.use() before this hook's own
// signup has written that file.
test.beforeAll(async ({ browser }) => {
  const userEmail = `nav-test+${Date.now()}@example.com`;
  const userContext = await browser.newContext({ storageState: undefined });
  const userPage = await userContext.newPage();
  await signUpAndOnboard(userPage, userEmail, 'Password123!');
  await userContext.storageState({ path: USER_AUTH });
  await userContext.close();

  // Admin test user — granted admin via the service-role client directly,
  // the same way every admin-governance test earlier in this project did.
  const adminEmail = `nav-admin+${Date.now()}@example.com`;
  const adminContext = await browser.newContext({ storageState: undefined });
  const adminPage = await adminContext.newPage();
  await signUpAndOnboard(adminPage, adminEmail, 'Password123!');

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const admin = createClient(supabaseUrl, serviceKey);
  const { data: userList } = await admin.auth.admin.listUsers();
  const adminUser = userList?.users.find((u) => u.email === adminEmail);
  if (adminUser) {
    await admin.from('admin_users').insert({ user_id: adminUser.id, notes: 'Playwright nav test admin' });
  }

  await adminContext.storageState({ path: ADMIN_AUTH });
  await adminContext.close();
});

test.afterAll(() => {
  for (const f of [USER_AUTH, ADMIN_AUTH]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

test.describe('Desktop navigation', () => {
  test.use({ storageState: USER_AUTH, viewport: { width: 1440, height: 900 } });

  test('renders the required top-level order (non-admin, no Admin item)', async ({ page }) => {
    await page.goto('/dashboard');
    const nav = page.getByRole('navigation', { name: 'Main' });
    const labels = (await nav.locator(':scope > a, :scope > button, :scope > div > button').allTextContents()).map((l) => l.trim());
    expect(labels).toEqual(REQUIRED_ORDER);
  });

  test('Dashboard opens the existing Dashboard page', async ({ page }) => {
    await page.goto('/reports'); // start elsewhere so the click is a real navigation
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Dashboard' }).click();
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByText(/welcome/i)).toBeVisible();
  });

  test('Input Data dropdown contains exactly Income, Expenses, Assets, Liabilities', async ({ page }) => {
    await page.goto('/dashboard');
    await page.getByRole('button', { name: 'Input Data' }).click();
    const menu = page.getByRole('menu', { name: 'Input Data' });
    await expect(menu).toBeVisible();
    const items = (await menu.getByRole('menuitem').allTextContents()).map((t) => t.trim());
    expect(items).toEqual(['Income', 'Expenses', 'Assets', 'Liabilities']);
  });

  for (const item of ['Income', 'Expenses', 'Assets', 'Liabilities']) {
    test(`Input Data > ${item} opens the correct existing page`, async ({ page }) => {
      await page.goto('/dashboard');
      await page.getByRole('button', { name: 'Input Data' }).click();
      await page.getByRole('menuitem', { name: item }).click();
      await expect(page).toHaveURL(new RegExp(`/${item.toLowerCase()}`));
    });
  }

  test('Input Data is highlighted when a child route is active', async ({ page }) => {
    await page.goto('/expenses');
    await expect(page.getByRole('button', { name: 'Input Data' })).toHaveAttribute('aria-current', 'page');
  });

  test('the dropdown opens and closes correctly using a mouse (including click outside)', async ({ page }) => {
    await page.goto('/dashboard');
    const trigger = page.getByRole('button', { name: 'Input Data' });
    const menu = page.getByRole('menu', { name: 'Input Data' });
    await trigger.click();
    await expect(menu).toBeVisible();
    await trigger.click();
    await expect(menu).toBeHidden();
    await trigger.click();
    await expect(menu).toBeVisible();
    await page.mouse.click(10, 400);
    await expect(menu).toBeHidden();
  });

  test('the dropdown opens using Enter and Space from the keyboard', async ({ page }) => {
    await page.goto('/dashboard');
    const trigger = page.getByRole('button', { name: 'Input Data' });
    const menu = page.getByRole('menu', { name: 'Input Data' });
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(menu).toBeVisible();
    await trigger.focus();
    await page.keyboard.press('Enter'); // toggle closed to reset
    await expect(menu).toBeHidden();
    await trigger.focus();
    await page.keyboard.press('Space');
    await expect(menu).toBeVisible();
  });

  test('Escape closes the dropdown and returns focus to the trigger', async ({ page }) => {
    await page.goto('/dashboard');
    const trigger = page.getByRole('button', { name: 'Input Data' });
    const menu = page.getByRole('menu', { name: 'Input Data' });
    await trigger.click();
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('selecting a submenu item closes the dropdown', async ({ page }) => {
    await page.goto('/dashboard');
    await page.getByRole('button', { name: 'Input Data' }).click();
    await page.getByRole('menuitem', { name: 'Assets' }).click();
    await expect(page).toHaveURL(/\/assets/);
    await expect(page.locator('#input-data-menu')).toHaveCount(0);
  });

  test('direct child-route URLs and a browser refresh continue to work', async ({ page }) => {
    await page.goto('/liabilities');
    await expect(page).toHaveURL(/\/liabilities/);
    await page.reload();
    await expect(page).toHaveURL(/\/liabilities/);
  });

  test('Retirement remains accessible from Investments and keeps its own route', async ({ page }) => {
    await page.goto('/investments');
    await expect(page.getByRole('tab', { name: 'Retirement' })).toBeVisible();
    await page.getByRole('tab', { name: 'Retirement' }).click();
    await expect(page).toHaveURL(/\/retirement/);
    await page.reload();
    await expect(page).toHaveURL(/\/retirement/);
    await expect(page.getByRole('tab', { name: 'Investments' })).toBeVisible();
  });

  const OTHER_PAGES: { label: string; urlPattern: RegExp }[] = [
    { label: 'Scores', urlPattern: /\/score/ },
    { label: 'DNA', urlPattern: /\/dna/ },
    { label: 'Resilience', urlPattern: /\/resilience/ },
    { label: 'Twin / Benchmark', urlPattern: /\/financial-twin/ },
    { label: 'Forecasting', urlPattern: /\/goals/ },
    { label: 'Reports', urlPattern: /\/reports/ },
  ];
  for (const { label, urlPattern } of OTHER_PAGES) {
    test(`${label} opens its existing page`, async ({ page }) => {
      await page.goto('/dashboard');
      await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: label, exact: true }).click();
      await expect(page).toHaveURL(urlPattern);
    });
  }

  test('non-admin users never see the Admin nav item', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Admin' })).toHaveCount(0);
  });

  test('sign out clears the session and redirects to login', async ({ page }) => {
    await page.goto('/dashboard');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe('Admin navigation', () => {
  test.use({ storageState: ADMIN_AUTH, viewport: { width: 1440, height: 900 } });

  test('Admin item is visible for an admin user and opens the existing admin page', async ({ page }) => {
    await page.goto('/dashboard');
    const adminLink = page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Admin' });
    await expect(adminLink).toBeVisible();
    await adminLink.click();
    await expect(page).toHaveURL(/\/admin\/benchmarks/);
  });
});

test.describe('Mobile / tablet navigation', () => {
  test.use({ storageState: USER_AUTH, viewport: { width: 375, height: 812 } });

  test('the mobile menu order matches the desktop order', async ({ page }) => {
    // First test after this describe's own beforeAll (two fresh signups) —
    // give the dev server's first /dashboard compile of this run extra
    // headroom rather than fail on cold-start contention.
    test.setTimeout(120_000);
    await page.goto('/dashboard');
    await page.getByRole('button', { name: 'Open menu' }).click();
    const panel = page.locator('#mobile-nav-panel');
    await expect(panel).toBeVisible();
    const labels = (await panel.locator('a, button').allTextContents()).map((l) => l.trim()).filter((l) => l !== 'Sign out');
    expect(labels).toEqual(REQUIRED_ORDER);
  });

  test('Input Data expands and collapses as an accordion showing exactly the four items', async ({ page }) => {
    await page.goto('/dashboard');
    await page.getByRole('button', { name: 'Open menu' }).click();
    const inputDataToggle = page.locator('#mobile-nav-panel').getByRole('button', { name: 'Input Data' });
    await inputDataToggle.click();
    const group = page.locator('#mobile-input-data-group');
    await expect(group).toBeVisible();
    const items = (await group.getByRole('link').allTextContents()).map((t) => t.trim());
    expect(items).toEqual(['Income', 'Expenses', 'Assets', 'Liabilities']);
    await inputDataToggle.click();
    await expect(group).toHaveCount(0);
  });

  test('selecting a route closes the mobile menu', async ({ page }) => {
    await page.goto('/dashboard');
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.locator('#mobile-nav-panel').getByRole('button', { name: 'Input Data' }).click();
    await page.getByRole('link', { name: 'Income' }).click();
    await expect(page).toHaveURL(/\/income/);
    await expect(page.locator('#mobile-nav-panel')).toHaveCount(0);
  });

  test('mobile navigation does not cause horizontal page overflow', async ({ page }) => {
    await page.goto('/dashboard');
    await page.getByRole('button', { name: 'Open menu' }).click();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow).toBe(false);
  });
});

test.describe('Authentication and route protection', () => {
  test('protected pages remain inaccessible without authentication', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login/);
    await page.goto('/admin/benchmarks');
    await expect(page).toHaveURL(/\/login/);
    await context.close();
  });
});
