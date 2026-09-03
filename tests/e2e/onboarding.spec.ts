import { test, expect } from '@playwright/test';

// Requires a running dev server with NEXT_PUBLIC_SUPABASE_URL/ANON_KEY pointed
// at a real (or local) Supabase project with the foundation + module 1
// migrations applied.
test('new user completes onboarding and reaches dashboard', async ({ page }) => {
  const email = `test+${Date.now()}@example.com`;
  const password = 'Password123!';

  await page.goto('/signup');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /sign up/i }).click();

  await expect(page).toHaveURL(/\/onboarding/);

  await page.getByLabel('Full name').fill('Test User');
  await page.getByRole('button', { name: /continue/i }).click(); // profile -> household

  // household_type is a REQUIRED field on this step (validateStep case 1) and
  // always has been — this spec previously clicked straight past it, which
  // cannot have advanced the wizard.
  await page.locator('#household_type').selectOption('single');
  await page.getByRole('button', { name: /continue/i }).click(); // household -> countries

  // G3: the Countries & Currency step no longer carries a pre-filled AU/AUD
  // default — a country the user never chose is exactly what G3 section 6.2
  // forbids — so this step now requires a genuine selection before it will
  // advance. Previously this spec clicked straight through it.
  await page.locator('#country_of_residence').selectOption('AU');
  await page.locator('#preferred_currency').selectOption('AUD');

  await page.getByRole('button', { name: /continue/i }).click(); // countries -> goals
  await page.getByRole('button', { name: /continue/i }).click(); // goals -> review
  await page.getByRole('button', { name: /finish/i }).click();

  // G3/MCC: onboarding now ends at the compulsory confirmation screen rather
  // than the dashboard. Confirming an AU (FULL) residence needs no coverage
  // acknowledgement, so this is a single explicit step.
  await expect(page).toHaveURL(/\/confirm-country/);
  await page.locator('#confirm-country-select').selectOption('AU');
  await page.getByRole('button', { name: /confirm and continue/i }).click();

  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByText(/welcome/i)).toBeVisible();
});
