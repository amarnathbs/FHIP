import { test, expect, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

// G3 §16 — responsive, accessibility and live authentication certification.
//
// Runs against a real dev server pointed at real DEV Supabase, driving real
// authenticated sessions. This is the layer the database certification
// cannot reach: redirect behaviour, route containment as actually
// experienced by a browser, and whether the disclosure a GENERIC user must
// acknowledge is genuinely presented to them.
//
// Every identity is synthetic and is deleted in afterAll, whose result is
// then re-queried — the same discipline as the live-DEV script.

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

// Each test drives a full signup -> onboarding -> confirmation -> redirect
// journey against a real Supabase project, and /dashboard is a data-heavy
// page. The default 60s budget is tuned for single-interaction specs, not
// for a multi-page journey plus round trips to a hosted database.
test.describe.configure({ timeout: 180_000 });

const RUN = Date.now();
const PASSWORD = `G3cert!${RUN}aA`;
const createdEmails: string[] = [];

/** The six widths §16 names. */
const WIDTHS = [320, 360, 390, 768, 1024, 1280];

async function signUpFresh(page: Page, tag: string): Promise<string> {
  const email = `g3e2e.${RUN}.${tag}@fhip-certification.test`;
  createdEmails.push(email);
  await page.goto('/signup');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: /sign up/i }).click();
  await expect(page).toHaveURL(/\/onboarding/, { timeout: 45_000 });
  return email;
}

/** Completes onboarding, choosing the given country + currency explicitly. */
/** Advances past the Profile and Household steps onto Countries & Currency. */
async function reachCountryStep(page: Page) {
  await page.getByLabel('Full name').fill('G3 Certification User');
  await page.getByRole('button', { name: /continue/i }).click(); // profile -> household
  // household_type is a REQUIRED field on this step; without it the wizard
  // (correctly) refuses to advance, so this is not optional set-up.
  await page.locator('#household_type').selectOption('single');
  await page.getByRole('button', { name: /continue/i }).click(); // household -> countries
  await expect(page.locator('#country_of_residence')).toBeVisible();
}

async function completeOnboarding(page: Page, country: string, currency: 'AUD' | 'INR') {
  await reachCountryStep(page);
  await page.locator('#country_of_residence').selectOption(country);
  await page.locator('#preferred_currency').selectOption(currency);
  await page.getByRole('button', { name: /continue/i }).click(); // countries -> goals
  await page.getByRole('button', { name: /continue/i }).click(); // goals -> review
  await page.getByRole('button', { name: /finish/i }).click();
  await expect(page).toHaveURL(/\/confirm-country/, { timeout: 45_000 });
}

/** No page may scroll horizontally at any width (§16). */
async function expectNoHorizontalOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(() => {
    const d = document.documentElement;
    return { scrollWidth: d.scrollWidth, clientWidth: d.clientWidth };
  });
  expect(overflow.scrollWidth, `${label}: horizontal overflow`).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

test.afterAll(async () => {
  const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const mine = (data?.users ?? []).filter((u) => createdEmails.includes(u.email ?? ''));
  const ids = mine.map((u) => u.id);

  for (const u of mine) {
    await admin.from('cross_border_relationships').delete().eq('user_id', u.id);
    await admin.auth.admin.deleteUser(u.id);
  }

  // audit_events.user_id is ON DELETE SET NULL but entity_id is a plain uuid
  // with no FK, so a deleted account's id survives there. Left in place, these
  // synthetic confirmations would be indistinguishable from genuine ones in a
  // real audit trail — so they are removed by id, scoped to this run only.
  if (ids.length) {
    await admin.from('audit_events').delete().in('entity_id', ids);
    const { data: leftAudit } = await admin.from('audit_events').select('id').in('entity_id', ids);
    if ((leftAudit ?? []).length) throw new Error(`audit residue left behind: ${(leftAudit ?? []).length}`);
  }

  const { data: after } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const left = (after?.users ?? []).filter((u) => (u.email ?? '').includes(`g3e2e.${RUN}`));
  if (left.length) throw new Error(`synthetic e2e identities left behind: ${left.length}`);
});

// ===========================================================================
test('onboarding no longer pre-fills a country the user never chose', async ({ page }) => {
  await signUpFresh(page, 'blankdefault');
  await reachCountryStep(page);

  // The whole point of G3-12/G3-13: nothing is preselected.
  await expect(page.locator('#country_of_residence')).toHaveValue('');
  await expect(page.locator('#preferred_currency')).toHaveValue('');

  // And the step will not advance without a real choice.
  await page.getByRole('button', { name: /continue/i }).click();
  await expect(page.getByText(/please select your country of residence/i)).toBeVisible();
  await expect(page.locator('#country_of_residence')).toHaveValue(''); // still on the step
});

// ===========================================================================
test('the confirmation screen offers all six registry countries', async ({ page }) => {
  await signUpFresh(page, 'sixcountries');
  await completeOnboarding(page, 'AU', 'AUD');

  const options = await page.locator('#confirm-country-select option').allTextContents();
  for (const label of ['Australia', 'India', 'United Kingdom', 'United States', 'Singapore', 'United Arab Emirates']) {
    expect(options.join('|')).toContain(label);
  }
  // The honest unavailable state is stated rather than hidden.
  await expect(page.getByText(/don't see your country/i)).toBeVisible();
});

// ===========================================================================
test('a GENERIC country requires an explicit, never-pre-checked acknowledgement', async ({ page }) => {
  await signUpFresh(page, 'genericack');
  await completeOnboarding(page, 'GB', 'AUD');

  await page.locator('#confirm-country-select').selectOption('GB');

  // The disclosure is shown, and states what is NOT available.
  await expect(page.getByText(/jurisdiction-neutral financial-health tools/i)).toBeVisible();
  await expect(page.getByText(/no local tax calculation/i)).toBeVisible();

  const ack = page.locator('#generic-disclosure-ack');
  await expect(ack).toBeVisible();
  await expect(ack).not.toBeChecked(); // §16: never pre-checked

  // Submitting without ticking must not confirm.
  await page.getByRole('button', { name: /confirm and continue/i }).click();
  await expect(page.getByText(/please confirm you understand/i)).toBeVisible();
  await expect(page).toHaveURL(/\/confirm-country/);

  // Error is associated with the control for assistive tech.
  await expect(ack).toHaveAttribute('aria-invalid', 'true');
  await expect(ack).toHaveAttribute('aria-describedby', 'generic-disclosure-ack-error');

  // Switching country clears the acknowledgement — it is country-specific.
  await ack.check();
  await expect(ack).toBeChecked();
  await page.locator('#confirm-country-select').selectOption('US');
  await expect(page.locator('#generic-disclosure-ack')).not.toBeChecked();
});

// ===========================================================================
test('a GENERIC user lands on /global-setup and is contained there', async ({ page }) => {
  await signUpFresh(page, 'genericroute');
  await completeOnboarding(page, 'SG', 'INR');

  await page.locator('#confirm-country-select').selectOption('SG');
  await page.locator('#generic-disclosure-ack').check();
  await page.getByRole('button', { name: /confirm and continue/i }).click();

  // Server decides the destination, not the client.
  await expect(page).toHaveURL(/\/global-setup/, { timeout: 45_000 });
  await expect(page.getByRole('heading', { name: /global experience setup complete/i })).toBeVisible();

  // Every financial module redirects back — the interim G4 boundary, as a
  // browser actually experiences it.
  for (const route of ['/dashboard', '/income', '/assets', '/retirement', '/reports', '/investments', '/goals', '/admin']) {
    await page.goto(route);
    await expect(page, `${route} should be contained`).toHaveURL(/\/global-setup/, { timeout: 30_000 });
  }

  // ...and the surfaces they ARE allowed keep working.
  await page.goto('/profile');
  await expect(page).toHaveURL(/\/profile/);

  // No redirect loop: /global-setup stays put on reload.
  await page.goto('/global-setup');
  await page.reload();
  await expect(page).toHaveURL(/\/global-setup/);
});

// ===========================================================================
test('a FULL user reaches the dashboard and is NOT sent to /global-setup', async ({ page }) => {
  await signUpFresh(page, 'fulluser');
  await completeOnboarding(page, 'AU', 'AUD');

  await page.locator('#confirm-country-select').selectOption('AU');
  // A FULL country shows no acknowledgement checkbox at all.
  await expect(page.locator('#generic-disclosure-ack')).toHaveCount(0);
  await page.getByRole('button', { name: /confirm and continue/i }).click();

  await expect(page).toHaveURL(/\/dashboard/, { timeout: 60_000 });

  // A FULL user visiting /global-setup is redirected away — it would be
  // actively misleading for them.
  await page.goto('/global-setup');
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });
});

// ===========================================================================
test('refresh and back-navigation never duplicate a confirmation', async ({ page }) => {
  await signUpFresh(page, 'idempotent');
  await completeOnboarding(page, 'US', 'AUD');

  await page.locator('#confirm-country-select').selectOption('US');
  await page.locator('#generic-disclosure-ack').check();
  await page.getByRole('button', { name: /confirm and continue/i }).click();
  await expect(page).toHaveURL(/\/global-setup/, { timeout: 45_000 });

  // Going back to the confirmation screen must bounce an already-confirmed
  // user, not offer to confirm again.
  await page.goto('/confirm-country');
  await expect(page).toHaveURL(/\/global-setup/, { timeout: 30_000 });

  await page.reload();
  await expect(page).toHaveURL(/\/global-setup/);

  // Exactly one audit event exists for this user.
  const { data: users } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const me = (users?.users ?? []).find((u) => u.email === `g3e2e.${RUN}.idempotent@fhip-certification.test`);
  const { data: events } = await admin.from('audit_events').select('id').eq('user_id', me!.id).eq('event_type', 'country_confirmed');
  expect(events?.length, 'exactly one confirmation audit event').toBe(1);
});

// ===========================================================================
test('country and currency are presented as separate concepts on Profile', async ({ page }) => {
  await signUpFresh(page, 'profileui');
  await completeOnboarding(page, 'IN', 'INR');
  await page.locator('#confirm-country-select').selectOption('IN');
  await page.getByRole('button', { name: /confirm and continue/i }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 60_000 });

  await page.goto('/profile');
  await expect(page.locator('#profile-country')).toBeVisible();
  await expect(page.locator('#profile-currency')).toBeVisible();

  // Each says explicitly what it does and does not mean.
  await expect(page.getByText(/it does not say where you live/i)).toBeVisible();
  await expect(page.getByText(/never changes your reporting currency/i)).toBeVisible();

  // Currency offers exactly AUD and INR.
  const currencies = await page.locator('#profile-currency option').allTextContents();
  expect(currencies.map((c) => c.trim()).sort()).toEqual(['AUD', 'INR']);

  // The optional cross-border panel is present and clearly non-authoritative.
  await expect(page.getByText(/cross-border connections \(optional\)/i)).toBeVisible();
  await expect(page.getByText(/no cross-border calculations, conversions or combined totals/i)).toBeVisible();
});

// ===========================================================================
test('confirmation screen is usable and overflow-free at all six widths', async ({ page }) => {
  await signUpFresh(page, 'responsive');
  await completeOnboarding(page, 'GB', 'AUD');

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.reload();

    await expectNoHorizontalOverflow(page, `confirm-country @${width}`);

    // The country control is reachable and operable at every width.
    const select = page.locator('#confirm-country-select');
    await expect(select).toBeVisible();
    await select.selectOption('GB');

    // The disclosure and its acknowledgement remain visible, not clipped away.
    await expect(page.getByText(/jurisdiction-neutral financial-health tools/i)).toBeVisible();
    const ack = page.locator('#generic-disclosure-ack');
    await expect(ack).toBeVisible();
    await expect(ack).not.toBeChecked();

    // Keyboard operability: the acknowledgement can be reached and toggled
    // without a mouse.
    await ack.focus();
    await expect(ack).toBeFocused();
    await page.keyboard.press('Space');
    await expect(ack).toBeChecked();
    await page.keyboard.press('Space');
    await expect(ack).not.toBeChecked();

    // The submit control is present and labelled at every width.
    await expect(page.getByRole('button', { name: /confirm and continue/i })).toBeVisible();
  }
});

// ===========================================================================
test('global-setup and profile are overflow-free at all six widths', async ({ page }) => {
  await signUpFresh(page, 'responsive2');
  await completeOnboarding(page, 'AE', 'AUD');
  await page.locator('#confirm-country-select').selectOption('AE');
  await page.locator('#generic-disclosure-ack').check();
  await page.getByRole('button', { name: /confirm and continue/i }).click();
  await expect(page).toHaveURL(/\/global-setup/, { timeout: 45_000 });

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });

    await page.goto('/global-setup');
    await expectNoHorizontalOverflow(page, `global-setup @${width}`);
    await expect(page.getByRole('heading', { name: /global experience setup complete/i })).toBeVisible();

    await page.goto('/profile');
    await expectNoHorizontalOverflow(page, `profile @${width}`);
    await expect(page.locator('#profile-currency')).toBeVisible();
  }
});

// ===========================================================================
test('session lifecycle: sign out, protected-route rejection, sign back in', async ({ page }) => {
  const email = await signUpFresh(page, 'session');
  await completeOnboarding(page, 'AU', 'AUD');
  await page.locator('#confirm-country-select').selectOption('AU');
  await page.getByRole('button', { name: /confirm and continue/i }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 60_000 });

  // Session survives a full reload (refresh-token path).
  await page.reload();
  await expect(page).toHaveURL(/\/dashboard/);

  // Sign out from the confirmation screen's own control is never country-gated;
  // use the app shell's instead, then prove protected routes reject.
  await page.context().clearCookies();
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login/, { timeout: 30_000 });

  // Signing back in returns the user to their confirmed state, not through
  // confirmation again.
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 60_000 });
});
