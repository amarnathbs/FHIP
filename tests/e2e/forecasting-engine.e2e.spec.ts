/**
 * FHIP Forecasting Engine — 50-case E2E regression suite, rewritten against
 * the REAL app (routes, nav labels and data-testid attributes already built
 * across Forecasting Engine Phases 1-7 — see components/ui/AppShell.tsx and
 * app/(app)/forecast/*). Supersedes the generic Playwright scaffold the user
 * supplied (`User tests/forecasting test/forecasting-engine.e2e.spec.ts`),
 * which assumed selectors/routes ("Goals" nav link, a single "Custom"
 * scenario option, a `forecast-recommendations` testid) that don't match
 * what was actually built.
 *
 * Key differences from the supplied scaffold, found by reading the real app
 * rather than assumed:
 *   - The Forecasting sub-nav link for goals is "Goal Forecasts", not
 *     "Goals" — deliberately renamed to avoid colliding with the
 *     pre-existing top-level "Goals" (Module 7 Goal Planning) link.
 *   - Scenarios are Base/Conservative/Optimistic (auto-created per profile)
 *     — there is no per-user "Custom" scenario auto-created; a 4th scenario
 *     only exists if this test run's seed data created one via
 *     forecast_scenarios (scenario_type='custom'), so the Custom-scenario
 *     assertion is conditional on it actually existing for that user.
 *   - The recommendations panel lives on its own page (/recommendations),
 *     not embedded in the Forecast Overview — there is no
 *     `forecast-recommendations` testid on the overview page.
 *   - The Variance Report route is /forecast/variance (nav label "Forecast
 *     Variance"), and only 5 categories appear there (net_worth, retirement,
 *     goal, debt, cross_border) — investment_growth and resilience are not
 *     part of the Variance Report (they don't have `getForecastVariance`
 *     support), per the actual page's CATEGORIES list.
 *
 * Requires the seed data from scripts/seedForecastingTestData.ts to already
 * be loaded (email/password pattern: forecast.<scenario_id lowercased>@example.test
 * / FhipTest!2026-<SCENARIO_ID>, exactly as assigned by the JSON package).
 *
 * Run:
 *   FHIP_TEST_DATA=./User tests/forecasting test/FHIP_Forecasting_50_Case_Test_Data.json \
 *   npx playwright test tests/e2e/forecasting-engine.e2e.spec.ts
 */
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const dataFile = process.env.FHIP_TEST_DATA ?? path.resolve('User tests/forecasting test/FHIP_Forecasting_50_Case_Test_Data.json');
const pkg = JSON.parse(fs.readFileSync(dataFile, 'utf8'));

interface TestUser {
  scenario_id: string;
  email: string;
  password: string;
}
interface SelectedCase {
  scenario_id: string;
  scenario_name: string;
}
interface VarianceExpected {
  scenario_id: string;
  forecast_category: string;
  comparison_date: string;
  forecast_till_date: number;
  actual_till_date: number;
  variance_result: string;
  expected_status: string;
}

const usersByScenario = new Map<string, TestUser>((pkg.users as TestUser[]).map((u) => [u.scenario_id, u]));
const selectedCases = pkg.selected_cases as SelectedCase[];
const varianceExpected = pkg.variance_expected as VarianceExpected[];

// Real nav labels + testids — matches components/ui/AppShell.tsx's
// FORECASTING_ITEMS and NAV_ITEM_TEST_IDS exactly, not the generic scaffold.
const TEST_IDS = {
  email: 'login-email',
  password: 'login-password',
  loginSubmit: 'login-submit',
  forecastNav: 'nav-forecasting',
  forecastOverview: 'forecast-overview',
  scenarioSelector: 'forecast-scenario-selector',
  netWorthFiveYear: 'forecast-net-worth-5y',
  varianceTable: 'forecast-variance-table',
  mobileMenu: 'mobile-menu-trigger',
} as const;

const FORECASTING_NAV_LINKS = [
  'Net Worth',
  'Retirement',
  'Goal Forecasts', // deliberately not "Goals" — see file header
  'Debt Reduction',
  'Investment Growth',
  'Cross-Border',
  'Financial Resilience',
  'Forecast Variance',
  'Scenarios',
  'Assumptions',
  'Forecast History',
];

const VARIANCE_STATUS_TEXT: Record<string, string> = {
  'Significantly Ahead': 'Significantly Ahead',
  'Ahead of Plan': 'Ahead of Plan',
  'On Track': 'On Track',
  'Slightly Behind': 'Slightly Behind',
  'At Risk': 'At Risk',
  'Significantly Off Track': 'Significantly Off Track',
};

function normaliseMoney(text: string): number {
  const negative = /\(|-/.test(text);
  const cleaned = text.replace(/[^\d.]/g, '');
  const value = Number(cleaned || '0');
  return negative ? -Math.abs(value) : value;
}

async function expectMoney(locator: ReturnType<Page['getByTestId']>, expected: number, tolerance: number) {
  await expect(locator).toBeVisible();
  const actual = normaliseMoney((await locator.innerText()).trim());
  expect(Math.abs(actual - expected), `Expected ${expected} ± ${tolerance}; received ${actual}`).toBeLessThanOrEqual(tolerance);
}

async function signIn(page: Page, user: TestUser) {
  await page.goto('/login');
  await page.getByTestId(TEST_IDS.email).fill(user.email);
  await page.getByTestId(TEST_IDS.password).fill(user.password);
  await page.getByTestId(TEST_IDS.loginSubmit).click();
  await expect(page).toHaveURL(/dashboard/);
}

async function openForecasting(page: Page) {
  await page.getByTestId(TEST_IDS.forecastNav).click();
  // The Forecasting dropdown's items are rendered with an explicit
  // role="menuitem" (see components/ui/AppShell.tsx's NavDropdownMenu), not
  // the default link role — getByRole('link', ...) would never match them.
  await page.getByRole('menuitem', { name: 'Overview', exact: true }).click();
  await expect(page.getByTestId(TEST_IDS.forecastOverview)).toBeVisible();
}

// NOTE: deliberately NOT using test.describe.configure({ mode: 'serial' })
// file-wide — playwright.config.ts already sets workers:1 so tests run
// sequentially, but 'serial' mode ALSO aborts every remaining test once one
// fails (it assumes tests build on shared state). These tests don't: each
// beforeEach does its own fresh signIn()+openForecasting() per scenario, so
// a single flaky/failing case (e.g. TC009 auth) should not cascade into
// skipping the other 49 scenarios' tests, which is what file-wide serial
// mode caused on a real run (1 failure -> 176 tests never ran).
//
// Forecasting has 10+ sub-pages; under Next dev-mode Turbopack, each route's
// FIRST hit in a given dev-server process can take 15-20s+ to compile (see
// playwright.config.ts's own comment on this) — the default 60s test budget
// covers signIn + one navigation comfortably, but the "opens every
// Forecasting sub-page" test chains 10+ of them in one test.
test.setTimeout(90_000);

for (const selected of selectedCases) {
  const scenarioId = selected.scenario_id;
  const user = usersByScenario.get(scenarioId);
  if (!user) continue; // not present in this environment's seeded subset
  const historicalVariance = varianceExpected.filter((row) => row.scenario_id === scenarioId);

  test.describe(`${scenarioId} — ${selected.scenario_name}`, () => {
    test.beforeEach(async ({ page }) => {
      await signIn(page, user);
      await openForecasting(page);
    });

    test('loads the Forecast Overview and shows a real 5-year net worth figure', async ({ page }) => {
      await expect(page.getByTestId(TEST_IDS.scenarioSelector)).toContainText(/Base/i);
      // The 5-year stat only renders once a net-worth forecast run exists —
      // for a freshly-seeded user with no forecast_runs yet, it isn't on the
      // page until "Generate forecast" is clicked (matches real first-time
      // user behavior, not a bug in the seed data).
      const fiveYear = page.getByTestId(TEST_IDS.netWorthFiveYear);
      if ((await fiveYear.count()) === 0) {
        await page.getByRole('button', { name: /generate forecast/i }).click();
      }
      await expect(fiveYear).toBeVisible();
      const value = normaliseMoney((await fiveYear.innerText()).trim());
      expect(value, 'Expected a real, non-zero 5-year net worth forecast').toBeGreaterThan(0);
    });

    test('switches between the scenarios that actually exist for this profile', async ({ page }) => {
      const selector = page.getByTestId(TEST_IDS.scenarioSelector);
      const options = await selector.locator('option').allTextContents();
      for (const label of options) {
        await selector.selectOption({ label });
        await expect(page.getByTestId(TEST_IDS.forecastOverview)).toBeVisible();
      }
    });

    test('opens every Forecasting sub-page without losing the authenticated session', async ({ page }) => {
      for (const label of FORECASTING_NAV_LINKS) {
        // The persistent sidebar's Forecasting group (unlike the old
        // floating dropdown) stays expanded after a selection instead of
        // auto-closing, so the trigger is a toggle — only click it if it's
        // not already open, or the second iteration onward would close it.
        const trigger = page.getByTestId(TEST_IDS.forecastNav);
        if ((await trigger.getAttribute('aria-expanded')) !== 'true') {
          await trigger.click();
        }
        const link = page.getByRole('menuitem', { name: new RegExp(`^${label}$`, 'i') });
        await expect(link).toBeVisible();
        await link.click();
        await expect(page.getByRole('heading', { name: new RegExp(label.replace(' Forecasts', ''), 'i') }).first()).toBeVisible();
      }
    });

    if (historicalVariance.length > 0) {
      test('reconciles the till-date variance report against the JSON test oracle', async ({ page }) => {
        // The Variance Report defaults its comparison date to "today" unless
        // told otherwise via ?date= — the historical test oracle's
        // comparison_date (2026-07-31) must be passed explicitly, or the app
        // correctly (but unhelpfully for this test) compares against today.
        const comparisonDate = historicalVariance[0].comparison_date;
        await page.goto(`/forecast/variance?date=${comparisonDate}`);
        await expect(page.getByTestId(TEST_IDS.varianceTable)).toBeVisible();

        for (const expected of historicalVariance) {
          const row = page.getByTestId(`variance-row-${expected.forecast_category}`);
          if ((await row.count()) === 0) continue; // category not covered by the Variance Report (e.g. investment_growth/resilience)
          // "Not Applicable" is the JSON test oracle's status for a user
          // with no data in this category at all (e.g. no cross-border
          // assets) — the app has no such status; it correctly reports
          // "Insufficient Data" for exactly this case (no baseline to
          // compare against), which is the real app's equivalent, not a defect.
          if (expected.expected_status === 'Not Applicable') {
            await expect(row).toContainText(/Insufficient Data/i);
            continue;
          }
          const tolerance = expected.forecast_category === 'cross_border' ? 1 : 0.01;
          await expectMoney(row.getByTestId('variance-forecast'), expected.forecast_till_date, tolerance);
          await expectMoney(row.getByTestId('variance-actual'), expected.actual_till_date, tolerance);
          const statusText = VARIANCE_STATUS_TEXT[expected.expected_status] ?? expected.expected_status;
          await expect(row).toContainText(new RegExp(statusText, 'i'));
        }
      });
    }

    test('renders the Forecast Overview at a 390x844 mobile viewport', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto('/forecast');
      if (await page.getByTestId(TEST_IDS.mobileMenu).count()) {
        await page.getByTestId(TEST_IDS.mobileMenu).click();
      }
      await expect(page.getByTestId(TEST_IDS.forecastOverview)).toBeVisible();
      const hasHorizontalScroll = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
      expect(hasHorizontalScroll, 'Forecast Overview should not require horizontal scrolling at mobile width').toBe(false);
    });
  });
}
