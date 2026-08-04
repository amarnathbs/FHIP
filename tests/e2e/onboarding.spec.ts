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
  await page.getByRole('button', { name: /continue/i }).click(); // household -> countries
  await page.getByRole('button', { name: /continue/i }).click(); // countries -> goals
  await page.getByRole('button', { name: /continue/i }).click(); // goals -> review
  await page.getByRole('button', { name: /finish/i }).click();

  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByText(/welcome/i)).toBeVisible();
});
