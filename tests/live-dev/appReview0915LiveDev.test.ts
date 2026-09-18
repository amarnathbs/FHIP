// App Review 2026-09-15 — LIVE DEV verification for the items that touch
// computed data end to end: items 4, 5 and 6.
//
// Run against real hosted DEV (vqycarelcoijzwlpkpcz) through the exact
// functions the app's own routes call — generateReport()
// (lib/services/reportsData.ts) and buildForecastReportData()
// (lib/services/forecastReportData.ts) — with real synthetic users, real rows,
// full cleanup and an independent zero-residue re-check.
//
// Reproduces the reviewer's own sequence: a report generated while only
// Income and Expenses existed, then assets/liabilities/investments/retirement
// and an active goal entered afterwards. Before this branch, the report never
// changed again.
//
// Run with: npx vitest run --config vitest.livedev.config.ts tests/live-dev/appReview0915LiveDev.test.ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { generateReport } from '@/lib/services/reportsData';
import { buildForecastReportData } from '@/lib/services/forecastReportData';

const URL = 'https://vqycarelcoijzwlpkpcz.supabase.co';
if (!/vqycarelcoijzwlpkpcz/.test(URL)) throw new Error('REFUSING: not the DEV project');

function serviceKey(): string | undefined {
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) return process.env.SUPABASE_SERVICE_ROLE_KEY;
  const envPath = path.resolve(__dirname, '..', '..', '.env.local');
  if (!fs.existsSync(envPath)) return undefined;
  const raw = fs.readFileSync(envPath, 'utf8').replace(/^﻿/, '');
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^SUPABASE_SERVICE_ROLE_KEY=(.*)$/);
    if (m) return m[1].trim();
  }
  return undefined;
}

type DQRow = { area: string; status: string; lastUpdated: string | null; reportTreatment: string };

describe('App Review 2026-09-15 — live DEV (items 4, 5, 6)', () => {
  it(
    'a report regenerates against data entered after it was first generated, and the retirement Final Target is no longer $25',
    async () => {
      const SERVICE_KEY = serviceKey();
      if (!SERVICE_KEY) {
        console.warn('SKIPPED: SUPABASE_SERVICE_ROLE_KEY not available.');
        return;
      }
      const admin = createClient(URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
      const RUN = `ar0915-${Date.now().toString(36)}`;
      const userIds: string[] = [];
      const reportIds: string[] = [];

      const email = `${RUN}@example.com`;
      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email,
        password: `Test-${Math.random().toString(36).slice(2)}-Aa1!`,
        email_confirm: true,
      });
      if (createErr) throw new Error(`createUser: ${createErr.message}`);
      const userId = created.user!.id;
      userIds.push(userId);

      try {
        await admin
          .from('user_profiles')
          .update({
            country_of_residence: 'AU',
            preferred_currency: 'AUD',
            country_confirmed_at: new Date().toISOString(),
            country_source: 'USER_CONFIRMED',
            onboarding_completed: true,
          })
          .eq('user_id', userId);

        // ---- Phase 1: only Income and Expenses exist (the reviewer's
        // starting state, which produced "29% complete" = 2 of 7). ----
        await admin.from('income_sources').insert({
          user_id: userId, source_name: `${RUN} salary`, income_type: 'salary', amount: 9000, frequency: 'monthly', currency_code: 'AUD', is_active: true,
        });
        await admin.from('expense_items').insert({
          user_id: userId, expense_name: `${RUN} living costs`, expense_category: 'housing', amount: 4000, frequency: 'monthly', is_essential: true, currency_code: 'AUD', is_active: true,
        });

        const first = await generateReport({ userId, reportType: 'net_worth', client: admin as never });
        reportIds.push(first.report.id);
        expect(first.report.status).toBe('ready');

        const firstDq = first.sections.find((s) => s.sectionCode === 'data_quality')!;
        const firstRows = firstDq.sectionData.rows as DQRow[];
        const firstByArea = Object.fromEntries(firstRows.map((r) => [r.area, r]));
        console.log('Phase 1 data quality:', firstRows.map((r) => `${r.area}=${r.status}`).join(' '));
        console.log('Phase 1 completeness:', firstDq.sectionData.dataCompletenessPct);

        // The reviewer's exact starting symptom, reproduced live.
        for (const area of ['Assets', 'Liabilities', 'Investments', 'Retirement']) {
          expect(firstByArea[area].status, `${area} genuinely has no rows yet`).toBe('missing');
          expect(firstByArea[area].lastUpdated).toBeNull();
        }
        // The reviewer's reported headline: 29% complete (2 of 7). Reproduced
        // exactly, which also proves the change does not regress a household
        // that has entered data but confirmed nothing.
        expect(Math.round(firstDq.sectionData.dataCompletenessPct as number)).toBe(29);

        const firstGoals = first.sections.find((s) => s.sectionCode === 'goals')!;
        expect(firstGoals.narrativeText).toBe('You have no active financial goals.');

        // ---- Phase 2: the household enters everything. ----
        await admin.from('assets').insert([
          { user_id: userId, asset_name: `${RUN} Principal Residence`, current_value: 750000, asset_class: 'property', country_code: 'AU', currency_code: 'AUD', is_active: true },
          { user_id: userId, asset_name: `${RUN} Savings Account`, current_value: 900, asset_class: 'cash', country_code: 'AU', currency_code: 'AUD', is_active: true },
          { user_id: userId, asset_name: `${RUN} Motor Vehicle`, current_value: 26000, asset_class: 'vehicle', country_code: 'AU', currency_code: 'AUD', is_active: true },
        ]);
        await admin.from('liabilities').insert([
          { user_id: userId, liability_name: `${RUN} Home Loan`, balance: 520904, interest_rate: 6.2, monthly_repayment: 3400, debt_type: 'mortgage', country_code: 'AU', currency_code: 'AUD', is_active: true },
          { user_id: userId, liability_name: `${RUN} SMSF property loan`, balance: 365000, interest_rate: 7.25, monthly_repayment: 2500, debt_type: 'mortgage', country_code: 'AU', currency_code: 'AUD', is_active: true },
        ]);
        await admin.from('investments').insert([
          { user_id: userId, investment_name: `${RUN} International Shares`, current_value: 25000, investment_type: 'shares', country_code: 'AU', currency_code: 'AUD', is_active: true },
          { user_id: userId, investment_name: `${RUN} Residential Investment Property`, current_value: 565000, investment_type: 'property', country_code: 'AU', currency_code: 'AUD', is_active: true },
        ]);
        const { error: retErr } = await admin.from('retirement_accounts').insert({
          user_id: userId, account_name: `${RUN} SMSF`, current_balance: 138000, country_code: 'AU', currency_code: 'AUD', is_active: true,
          account_type: 'super', master_item_key: 'smsf',
        });
        expect(retErr, JSON.stringify(retErr)).toBeNull();
        const { error: goalErr } = await admin.from('user_goals').insert({
          user_id: userId, goal_name: 'Emergency fund', goal_type: 'emergency_fund', target_amount: 30000, current_amount: 15000, currency_code: 'AUD', status: 'active',
          target_date: '2026-12-01', planned_contribution_amount: 541.67, contribution_frequency: 'monthly',
        });
        expect(goalErr, JSON.stringify(goalErr)).toBeNull();

        // ---- Phase 3: ask for the same month's report again. ----
        const second = await generateReport({ userId, reportType: 'net_worth', client: admin as never });
        reportIds.push(second.report.id);

        // ITEM 4 + 5 ROOT CAUSE: before this branch, this call returned the
        // Phase 1 report verbatim and every assertion below failed.
        expect(second.alreadyExisted, 'the stale report must NOT be returned as-is').toBe(false);
        expect(second.report.id, 'a new version was produced').not.toBe(first.report.id);
        expect(second.report.revises_report_id).toBe(first.report.id);
        expect(second.report.version_number).toBe(2);

        const { data: supersededOriginal } = await admin.from('reports').select('status').eq('id', first.report.id).single();
        expect(supersededOriginal?.status, 'the original is superseded, not deleted — lineage preserved').toBe('superseded');

        const secondDq = second.sections.find((s) => s.sectionCode === 'data_quality')!;
        const secondRows = secondDq.sectionData.rows as DQRow[];
        const byArea = Object.fromEntries(secondRows.map((r) => [r.area, r]));
        console.log('Phase 3 data quality:', secondRows.map((r) => `${r.area}=${r.status} (${r.lastUpdated ? 'dated' : 'not provided'})`).join(' '));
        console.log('Phase 3 completeness:', secondDq.sectionData.dataCompletenessPct);

        // ITEM 4 acceptance, verbatim.
        for (const area of ['Assets', 'Liabilities', 'Investments', 'Retirement']) {
          expect(byArea[area].status, `${area} no longer Missing`).not.toBe('missing');
          expect(byArea[area].lastUpdated, `${area} Last Updated is a real date`).toBeTruthy();
          expect(byArea[area].reportTreatment, `${area} is included in calculations`).toContain('Included');
        }
        expect(secondDq.sectionData.dataCompletenessPct as number, 'completion % rises').toBeGreaterThan(
          firstDq.sectionData.dataCompletenessPct as number
        );

        // ITEM 5 acceptance, verbatim.
        const goalsSection = second.sections.find((s) => s.sectionCode === 'goals')!;
        const goalRows = goalsSection.sectionData.goals as { goalName: string; targetAmount: number; currentAmount: number; trackStatus: string }[];
        console.log('Phase 3 goals section:', JSON.stringify(goalRows));
        expect(goalsSection.narrativeText).not.toContain('No active goals');
        expect(goalRows.map((g) => g.goalName)).toContain('Emergency fund');
        const emergency = goalRows.find((g) => g.goalName === 'Emergency fund')!;
        expect(emergency.targetAmount, 'target amount carried into the report').toBe(30000);
        expect(emergency.currentAmount, 'funded amount carried into the report').toBe(15000);
        expect(emergency.trackStatus, 'status carried into the report').toBeTruthy();

        // ---- ITEM 6: the retirement Final Target ----
        // This household has essential expenses recorded, so a target IS
        // derivable and must be a sane corpus, never $25.
        const forecast = await buildForecastReportData(userId, undefined, admin as never);
        const retirementRow = forecast.variances.find((v) => v.forecastCategory === 'retirement');
        console.log('Item 6 retirement variance:', JSON.stringify(retirementRow));
        if (retirementRow) {
          expect(retirementRow.actualBasis, 'the row names the register it is summed from').toContain('retirement_accounts');
          expect(retirementRow.finalTargetBasis).toBeTruthy();
          if (retirementRow.finalTarget !== null) {
            // 4,000/month essential * 12 / 4% = 1,200,000.
            expect(retirementRow.finalTarget, 'a real corpus, not the 1/0.04 = 25 artefact').toBeGreaterThan(100000);
          }
          if (retirementRow.actualTillDate !== null) {
            expect(retirementRow.actualTillDate, 'actual = sum of retirement_accounts.current_balance').toBe(138000);
          }
        }

        // A second call now that a retirement forecast run exists: the target
        // is readable, and it is the REAL required corpus.
        const forecast2 = await buildForecastReportData(userId, undefined, admin as never);
        const retirement2 = forecast2.variances.find((v) => v.forecastCategory === 'retirement')!;
        console.log('Item 6 retirement variance (run established):', JSON.stringify(retirement2));
        // $4,000/month essential x 12 / 4% withdrawal rate = $1,200,000.
        expect(retirement2.finalTarget, 'the real required corpus, not the 1/0.04 = 25 artefact').toBe(1200000);
        expect(retirement2.actualTillDate, 'actual = sum of retirement_accounts.current_balance').toBe(138000);
        expect(retirement2.finalTargetGap, 'gap is consistent with the target').toBeCloseTo(1200000 - (retirement2.revisedForecast ?? 0), 2);

        // ---- ITEM 6, the $25 artefact itself ----
        // A household with NO essential expenses recorded is the exact case
        // that produced Math.max(1, 0 * 12) = 1, then 1 / 0.04 = 25. It must
        // now produce no target at all.
        const bare = await admin.auth.admin.createUser({
          email: `${RUN}-bare@example.com`,
          password: `Test-${Math.random().toString(36).slice(2)}-Aa1!`,
          email_confirm: true,
        });
        if (bare.error) throw new Error(`createUser bare: ${bare.error.message}`);
        const bareUserId = bare.data.user!.id;
        userIds.push(bareUserId);
        await admin
          .from('user_profiles')
          .update({ country_of_residence: 'AU', preferred_currency: 'AUD', country_confirmed_at: new Date().toISOString(), country_source: 'USER_CONFIRMED', onboarding_completed: true })
          .eq('user_id', bareUserId);
        await admin.from('retirement_accounts').insert({
          user_id: bareUserId, account_name: `${RUN} bare super`, current_balance: 271000, country_code: 'AU', currency_code: 'AUD', is_active: true, account_type: 'super',
        });
        // Non-essential expenses only -> dashboard.essentialMonthlyExpenses = 0.
        await admin.from('expense_items').insert({
          user_id: bareUserId, expense_name: `${RUN} discretionary`, expense_category: 'lifestyle', amount: 500, frequency: 'monthly', is_essential: false, currency_code: 'AUD', is_active: true,
        });
        // First call establishes the run; second reads its target back.
        await buildForecastReportData(bareUserId, undefined, admin as never);
        const bareForecast = await buildForecastReportData(bareUserId, undefined, admin as never);
        const bareRetirement = bareForecast.variances.find((v) => v.forecastCategory === 'retirement')!;
        console.log('Item 6 no-essential-expenses retirement variance:', JSON.stringify(bareRetirement));
        expect(bareRetirement.finalTarget, 'never the 1 / 0.04 = 25 artefact').not.toBe(25);
        expect(bareRetirement.finalTarget, 'no derivable target at all — shown as em dash with an explanation').toBeNull();
        expect(bareRetirement.finalTargetGap, 'and therefore no nonsensical remaining gap either').toBeNull();
      } finally {
        for (const reportId of reportIds) {
          await admin.from('report_snapshots').delete().eq('report_id', reportId);
          await admin.from('report_sections').delete().eq('report_id', reportId);
        }
        await admin.from('reports').delete().in('user_id', userIds);
        await admin.from('report_generation_runs').delete().in('user_id', userIds);
        for (const table of [
          'goal_snapshots', 'goal_forecasts', 'goal_funding_sources', 'user_goals',
          'forecast_explanations', 'forecast_results', 'forecast_runs', 'forecast_scenarios',
          'financial_snapshots', 'assets', 'liabilities', 'investments', 'retirement_accounts',
          'income_sources', 'expense_items',
        ]) {
          await admin.from(table).delete().in('user_id', userIds);
        }
        for (const id of userIds) {
          const { error } = await admin.auth.admin.deleteUser(id);
          if (error) console.error(`FAILED to delete user ${id}: ${error.message}`);
        }
        let residue = 0;
        for (const id of userIds) {
          const { data: stillThere } = await admin.auth.admin.getUserById(id);
          if (stillThere?.user) { residue++; console.error(`RESIDUE: user ${id} still exists`); }
        }
        for (const table of ['assets', 'liabilities', 'investments', 'retirement_accounts', 'income_sources', 'expense_items', 'user_goals', 'reports']) {
          const { count } = await admin.from(table).select('id', { count: 'exact', head: true }).in('user_id', userIds);
          if (count && count > 0) { residue++; console.error(`RESIDUE: ${count} rows remain in ${table}`); }
        }
        console.log(residue === 0 ? 'Zero residue confirmed.' : `${residue} RESIDUE ITEMS REMAIN.`);
        expect(residue, 'zero synthetic residue after cleanup').toBe(0);
      }
    },
    180_000
  );
});
