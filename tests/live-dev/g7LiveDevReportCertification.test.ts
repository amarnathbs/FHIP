// G7 live-DEV certification — real proof of the 6 G7 data contracts
// (docs/country-programme/g7-data-contracts.md), run directly against real
// DEV infrastructure via generateReport() (lib/services/reportsData.ts),
// the exact function every app/api/reports/** route calls. Same discipline
// as tests/live-dev/g6LiveDevFxCrossBorderCertification.test.ts: real
// disposable synthetic DEV users, real rows, real function calls, hand-
// calculated oracles where relevant, full cleanup + independent zero-
// residue re-check in a finally block.
//
// Contracts certified here:
//   1. reports.country_scope populated from the real country_of_residence
//      (not the old hardcoded 'household' literal).
//   3. hasCrossBorderEligibility() — proven via the real cross_border
//      section's status ('included' for a 2-country household, 'omitted'
//      for a 1-country household), not just the pure function in isolation.
//   4. net_worth/cash_flow/executive_summary sections carry a real
//      cross-border blending limitationText for a multi-country household,
//      and carry none for a single-country household.
//   5. report_snapshots.snapshot_metadata_json carries real
//      fxRateAudInr/fxRateDate/countryOfResidence provenance.
// Contracts 2 (locale) and 6 (doc-string + matcher unit test) are pure/
// deterministic and already unit-tested — no live-DEV value added by
// re-running them here.
//
// Run with: npx vitest run tests/live-dev/g7LiveDevReportCertification.test.ts
import { describe, it, expect } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { generateReport } from '@/lib/services/reportsData';

const URL = 'https://vqycarelcoijzwlpkpcz.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!/vqycarelcoijzwlpkpcz/.test(URL)) throw new Error('REFUSING: not the DEV project');

describe('G7 live-DEV certification — real report generation, real cross-border sections, real snapshot provenance', () => {
  it(
    'proves country_scope provenance, cross-border section inclusion/limitationText, and snapshot FX/country provenance against real DEV infrastructure',
    async () => {
      if (!SERVICE_KEY) {
        console.warn('SKIPPED: SUPABASE_SERVICE_ROLE_KEY not present in this environment.');
        return;
      }
      const admin = createClient(URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
      const RUN = `g7ld-${Date.now().toString(36)}`;
      const createdUserIds: string[] = [];
      const createdReportIds: string[] = [];

      async function createSyntheticUser(label: string, countryCode: string) {
        const email = `${RUN}-${label}@example.com`;
        const password = `Test-${Math.random().toString(36).slice(2)}-Aa1!`;
        const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
        if (error) throw new Error(`createUser ${email}: ${error.message}`);
        const userId = data.user!.id;
        createdUserIds.push(userId);
        const { error: profErr } = await admin.from('user_profiles').update({
          country_of_residence: countryCode,
          preferred_currency: 'AUD',
          country_confirmed_at: new Date().toISOString(),
          country_source: 'USER_CONFIRMED',
          onboarding_completed: true,
        }).eq('user_id', userId);
        if (profErr) throw new Error(`user_profiles update ${email}: ${profErr.message}`);
        return { userId, email };
      }

      console.log(`Run tag: ${RUN}`);

      const { data: fxRow } = await admin
        .from('forecast_global_assumptions')
        .select('assumption_value')
        .eq('assumption_key', 'fx_rate_aud_inr')
        .eq('is_active', true)
        .is('country_code', null)
        .maybeSingle();
      const fxRateAudInr = (fxRow?.assumption_value as number) ?? 56;
      console.log(`Real DEV fx_rate_aud_inr in effect: ${fxRateAudInr}`);

      const domestic = await createSyntheticUser('domestic', 'AU');
      const crossBorder = await createSyntheticUser('crossborder', 'AU');

      try {
        // Minimal real data so the sections build with actual content rather
        // than all-excluded placeholders. Domestic: single country (AU).
        // Cross-border: AU + IN, so countriesInUse.length === 2.
        const { error: domAssetErr } = await admin.from('assets').insert({
          user_id: domestic.userId, asset_name: `${RUN} domestic cash`, current_value: 10000, asset_class: 'cash', country_code: 'AU', currency_code: 'AUD', is_active: true,
        });
        expect(domAssetErr, JSON.stringify(domAssetErr)).toBeNull();
        const { error: domIncomeErr } = await admin.from('income_sources').insert({
          user_id: domestic.userId, source_name: `${RUN} salary`, income_type: 'salary', amount: 5000, frequency: 'monthly', currency_code: 'AUD', is_active: true,
        });
        expect(domIncomeErr, JSON.stringify(domIncomeErr)).toBeNull();
        const { error: domExpenseErr } = await admin.from('expense_items').insert({
          user_id: domestic.userId, expense_name: `${RUN} rent`, expense_category: 'housing', amount: 2000, frequency: 'monthly', currency_code: 'AUD', is_active: true,
        });
        expect(domExpenseErr, JSON.stringify(domExpenseErr)).toBeNull();

        const { error: cbAssetAuErr } = await admin.from('assets').insert({
          user_id: crossBorder.userId, asset_name: `${RUN} cb au cash`, current_value: 50000, asset_class: 'cash', country_code: 'AU', currency_code: 'AUD', is_active: true,
        });
        expect(cbAssetAuErr, JSON.stringify(cbAssetAuErr)).toBeNull();
        const { error: cbAssetInErr } = await admin.from('assets').insert({
          user_id: crossBorder.userId, asset_name: `${RUN} cb in cash`, current_value: 1000000, asset_class: 'cash', country_code: 'IN', currency_code: 'INR', is_active: true,
        });
        expect(cbAssetInErr, JSON.stringify(cbAssetInErr)).toBeNull();
        const { error: cbIncomeErr } = await admin.from('income_sources').insert({
          user_id: crossBorder.userId, source_name: `${RUN} cb salary`, income_type: 'salary', amount: 5000, frequency: 'monthly', currency_code: 'AUD', is_active: true,
        });
        expect(cbIncomeErr, JSON.stringify(cbIncomeErr)).toBeNull();
        const { error: cbExpenseErr } = await admin.from('expense_items').insert({
          user_id: crossBorder.userId, expense_name: `${RUN} cb rent`, expense_category: 'housing', amount: 2000, frequency: 'monthly', currency_code: 'AUD', is_active: true,
        });
        expect(cbExpenseErr, JSON.stringify(cbExpenseErr)).toBeNull();

        // reportType 'net_worth' deliberately used (not the default
        // 'monthly_financial_health') to avoid needing a seeded Health
        // Score row -- isEligibleForOfficialMonthlyReport() only gates the
        // 'monthly_financial_health' type; the country_scope/report_sections/
        // report_snapshots writes this test certifies run unconditionally
        // for every report type (see lib/services/reportsData.ts).
        const domResult = await generateReport({ userId: domestic.userId, reportType: 'net_worth', client: admin as never });
        expect(domResult.report.status, 'domestic report generated successfully').toBe('ready');
        createdReportIds.push(domResult.report.id);

        const cbResult = await generateReport({ userId: crossBorder.userId, reportType: 'net_worth', client: admin as never });
        expect(cbResult.report.status, 'cross-border report generated successfully').toBe('ready');
        createdReportIds.push(cbResult.report.id);

        // ---- Contract 1: country_scope real provenance ----
        expect(domResult.report.country_scope, 'Contract 1: domestic report.country_scope = real country_of_residence (AU), not the old hardcoded literal').toBe('AU');
        expect(cbResult.report.country_scope, 'Contract 1: cross-border report.country_scope = real country_of_residence (AU)').toBe('AU');

        // ---- Contract 3: hasCrossBorderEligibility() via the real cross_border section ----
        const domCrossBorderSection = domResult.sections.find((s) => s.sectionCode === 'cross_border');
        const cbCrossBorderSection = cbResult.sections.find((s) => s.sectionCode === 'cross_border');
        expect(domCrossBorderSection?.sectionStatus, 'Contract 3: domestic (1 country) household — cross_border section OMITTED').toBe('omitted');
        expect(cbCrossBorderSection?.sectionStatus, 'Contract 3: cross-border (2 countries) household — cross_border section INCLUDED').toBe('included');

        // ---- Contract 4: real limitationText blending caveat on net_worth/cash_flow/executive_summary ----
        for (const code of ['net_worth', 'cash_flow', 'executive_summary'] as const) {
          const domSection = domResult.sections.find((s) => s.sectionCode === code);
          const cbSection = cbResult.sections.find((s) => s.sectionCode === code);
          expect(domSection?.limitationText ?? '', `Contract 4: domestic (1 country) ${code} section carries NO cross-border blending note`).not.toMatch(/blends figures from/);
          expect(cbSection?.limitationText ?? '', `Contract 4: cross-border (2 countries) ${code} section carries the real blending note`).toMatch(/blends figures from 2 countries/);
        }

        // ---- Contract 5: report_snapshots provenance (real FX rate + country) ----
        const { data: domSnap, error: domSnapErr } = await admin.from('report_snapshots').select('snapshot_metadata_json').eq('report_id', domResult.report.id).eq('snapshot_type', 'financial').single();
        expect(domSnapErr, JSON.stringify(domSnapErr)).toBeNull();
        expect(Number((domSnap?.snapshot_metadata_json as Record<string, unknown>)?.fxRateAudInr), 'Contract 5: domestic report_snapshots metadata carries the real fx_rate_aud_inr').toBe(fxRateAudInr);
        expect((domSnap?.snapshot_metadata_json as Record<string, unknown>)?.countryOfResidence, 'Contract 5: domestic report_snapshots metadata carries the real countryOfResidence').toBe('AU');
        expect((domSnap?.snapshot_metadata_json as Record<string, unknown>)?.fxRateDate, 'Contract 5: domestic report_snapshots metadata carries a populated fxRateDate').toBeTruthy();

        const { data: cbSnap, error: cbSnapErr } = await admin.from('report_snapshots').select('snapshot_metadata_json').eq('report_id', cbResult.report.id).eq('snapshot_type', 'financial').single();
        expect(cbSnapErr, JSON.stringify(cbSnapErr)).toBeNull();
        expect(Number((cbSnap?.snapshot_metadata_json as Record<string, unknown>)?.fxRateAudInr), 'Contract 5: cross-border report_snapshots metadata carries the real fx_rate_aud_inr').toBe(fxRateAudInr);
      } finally {
        // Cleanup — delete everything created, independently re-verify gone.
        for (const reportId of createdReportIds) {
          await admin.from('report_snapshots').delete().eq('report_id', reportId);
          await admin.from('report_sections').delete().eq('report_id', reportId);
        }
        await admin.from('reports').delete().in('id', createdReportIds);
        await admin.from('report_generation_runs').delete().in('user_id', createdUserIds);
        for (const table of ['assets', 'income_sources', 'expense_items']) {
          await admin.from(table).delete().in('user_id', createdUserIds);
        }
        for (const userId of createdUserIds) {
          const { error } = await admin.auth.admin.deleteUser(userId);
          if (error) console.error(`FAILED to delete user ${userId}: ${error.message}`);
        }
        let residue = 0;
        for (const userId of createdUserIds) {
          const { data: stillThere } = await admin.auth.admin.getUserById(userId);
          if (stillThere?.user) { residue++; console.error(`RESIDUE: user ${userId} still exists`); }
        }
        for (const table of ['assets', 'income_sources', 'expense_items']) {
          const { count } = await admin.from(table).select('id', { count: 'exact', head: true }).in('user_id', createdUserIds);
          if (count && count > 0) { residue++; console.error(`RESIDUE: ${count} rows remain in ${table}`); }
        }
        const { count: reportResidue } = await admin.from('reports').select('id', { count: 'exact', head: true }).in('id', createdReportIds);
        if (reportResidue && reportResidue > 0) { residue++; console.error(`RESIDUE: ${reportResidue} report rows remain`); }
        console.log(residue === 0 ? 'Zero residue confirmed -- all synthetic users, reports and rows independently re-verified gone.' : `${residue} RESIDUE ITEMS REMAIN.`);
        expect(residue, 'zero synthetic residue after cleanup').toBe(0);
      }
    },
    120_000
  );
});
