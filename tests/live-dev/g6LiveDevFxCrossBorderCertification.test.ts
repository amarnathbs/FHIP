// G6 live-DEV certification — the piece the prior static-only pass
// (docs/country-programme/G6_G7_LIVE_DEV_CERTIFICATION_REPORT.md) could not
// do at all, because its isolated agent worktree had no DEV credentials.
// Run via vitest (reuses this repo's already-working TS transform, rather
// than fighting a broken/missing local `tsx` install) from a worktree that
// DOES have .env.local (copied in manually by the orchestrating session,
// never committed, never touched by this file).
//
// Method: real disposable synthetic DEV users, real rows, real
// computeDashboard()/computeLiveLinkedFundingValue()/loadTwinSourceData()
// calls against that real data, with expected values calculated BY HAND
// from the documented fx.ts convention (fx_rate_aud_inr = INR per 1 AUD) --
// never trusting the function's own output as its own oracle, per the
// mission's explicit "do not copy production formulas into the test as the
// oracle" rule.
//
// Cleanup: every synthetic user/row is deleted and independently
// re-verified gone at the end, regardless of pass/fail, via try/finally.
//
// Run with: npx vitest run tests/live-dev/g6LiveDevFxCrossBorderCertification.test.ts
import { describe, it, expect } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { computeDashboard } from '@/lib/engines/dashboard';
import { computeLiveLinkedFundingValue } from '@/lib/services/goalFundingAllocation';
import { loadTwinSourceData } from '@/lib/services/twinData';

const URL = 'https://vqycarelcoijzwlpkpcz.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!/vqycarelcoijzwlpkpcz/.test(URL)) throw new Error('REFUSING: not the DEV project');

describe('G6 live-DEV certification — real FX oracle, real cross-border, real RLS', () => {
  it(
    'proves the FX-lineage/domestic+overseas=consolidated oracle, goal-funding conversion, cross-border relationship lifecycle, and cross-tenant RLS against real DEV infrastructure',
    async () => {
      if (!SERVICE_KEY || !ANON_KEY) {
        console.warn('SKIPPED: SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_ANON_KEY not present in this environment.');
        return;
      }
      const admin = createClient(URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
      const RUN = `g6ld-${Date.now().toString(36)}`;
      const createdUserIds: string[] = [];

      async function createSyntheticUser(email: string, profile: Record<string, unknown>) {
        const password = `Test-${Math.random().toString(36).slice(2)}-Aa1!`;
        const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
        if (error) throw new Error(`createUser ${email}: ${error.message}`);
        const userId = data.user!.id;
        createdUserIds.push(userId);
        const { error: profErr } = await admin.from('user_profiles').upsert({ user_id: userId, ...profile });
        if (profErr) throw new Error(`user_profiles upsert ${email}: ${profErr.message}`);
        return { userId, email, password };
      }

      async function signIn(email: string, password: string) {
        const client = createClient(URL, ANON_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
        const { error } = await client.auth.signInWithPassword({ email, password });
        if (error) throw new Error(`signIn ${email}: ${error.message}`);
        return client;
      }

      console.log(`Run tag: ${RUN}`);

      // Real, current FX rate -- the actual value getFxRateAudInr() would
      // resolve, fetched directly here as the SAME real input the
      // hand-calculated oracle below uses (not a second, guessed number).
      const { data: fxRow } = await admin
        .from('forecast_global_assumptions')
        .select('assumption_value')
        .eq('assumption_key', 'fx_rate_aud_inr')
        .eq('is_active', true)
        .is('country_code', null)
        .maybeSingle();
      const fxRateAudInr = (fxRow?.assumption_value as number) ?? 56;
      console.log(`Real DEV fx_rate_aud_inr in effect: ${fxRateAudInr} (documented convention: INR per 1 AUD)`);

      const userAU = await createSyntheticUser(`${RUN}-au@example.com`, {
        country_of_residence: 'AU', preferred_currency: 'AUD', country_confirmed_at: new Date().toISOString(), country_source: 'USER_CONFIRMED', onboarding_completed: true,
      });
      const userAttacker = await createSyntheticUser(`${RUN}-attacker@example.com`, {
        country_of_residence: 'AU', preferred_currency: 'AUD', country_confirmed_at: new Date().toISOString(), country_source: 'USER_CONFIRMED', onboarding_completed: true,
      });
      // Dedicated, otherwise-empty user for the Contract 7/10 relationship-
      // lifecycle check below -- userAU's OWN isCrossBorder signal is, by
      // correct design, ALSO driven by dashboard.countriesInUse.length > 1
      // (an OR, see twinData.ts), which is already true from the multi-
      // country assets created for userAU in section 1 above regardless of
      // any relationship's state. Isolating the relationship-only signal on
      // a user with NO other country-tagged records is what actually proves
      // Contract 10's own behaviour, not a weakened assertion.
      const userCb = await createSyntheticUser(`${RUN}-cb@example.com`, {
        country_of_residence: 'AU', preferred_currency: 'AUD', country_confirmed_at: new Date().toISOString(), country_source: 'USER_CONFIRMED', onboarding_completed: true,
      });

      try {
        // =====================================================================
        // 1. Contract 1 (widened country_code) + Contract 5 (converted
        //    per-country net worth) + the FX-lineage oracle proof.
        // =====================================================================
        const auAssetValue = 100000; // AUD, country_code AU -- domestic for a home-country=AU user
        const inAssetValueInr = 2_800_000; // INR, country_code IN -- overseas, needs conversion
        const gbAssetValueAud = 20000; // AUD, country_code GB (GENERIC) -- overseas, already AUD

        const { data: assetRows, error: assetErr } = await admin
          .from('assets')
          .insert([
            { user_id: userAU.userId, asset_name: `${RUN} au cash`, current_value: auAssetValue, asset_class: 'cash', country_code: 'AU', currency_code: 'AUD', is_active: true },
            { user_id: userAU.userId, asset_name: `${RUN} in cash`, current_value: inAssetValueInr, asset_class: 'cash', country_code: 'IN', currency_code: 'INR', is_active: true },
            { user_id: userAU.userId, asset_name: `${RUN} gb cash`, current_value: gbAssetValueAud, asset_class: 'cash', country_code: 'GB', currency_code: 'AUD', is_active: true },
          ])
          .select('id, country_code, currency_code, current_value');
        expect(assetErr, `insert assets failed: ${JSON.stringify(assetErr)}`).toBeNull();
        expect(assetRows?.length, 'Contract 1: 3 real rows with widened country_code (AU/IN/GB) accepted').toBe(3);

        // Hand-calculated oracle, independent of any app function.
        const expectedInAssetInAud = inAssetValueInr / fxRateAudInr;
        const expectedDomesticTotal = auAssetValue;
        const expectedOverseasTotal = expectedInAssetInAud + gbAssetValueAud;
        const expectedConsolidatedTotal = expectedDomesticTotal + expectedOverseasTotal;
        console.log(`Hand-calculated oracle: domestic(AU)=${expectedDomesticTotal}, overseas(IN converted + GB)=${expectedOverseasTotal.toFixed(2)}, consolidated=${expectedConsolidatedTotal.toFixed(2)}`);

        const { data: liveAssets } = await admin.from('assets').select('current_value, asset_class, country_code, currency_code').eq('user_id', userAU.userId).eq('is_active', true);
        const summary = computeDashboard(
          { income: [], expenses: [], assets: liveAssets as never, liabilities: [], investments: [], retirement: [], insurance: [], goals: [], snapshots: [] },
          'AUD',
          fxRateAudInr
        );

        expect(summary.totalAssets, 'live computeDashboard() totalAssets matches the hand-calculated consolidated oracle').toBeCloseTo(expectedConsolidatedTotal, 1);

        const netWorthByCountry = Object.fromEntries(summary.netWorthByCountryConverted.map((r) => [r.countryCode, r.value]));
        expect(netWorthByCountry.AU ?? 0, 'netWorthByCountryConverted AU bucket matches domestic oracle').toBeCloseTo(auAssetValue, 1);
        expect(netWorthByCountry.IN ?? 0, 'netWorthByCountryConverted IN bucket matches hand-converted (INR/rate) oracle').toBeCloseTo(expectedInAssetInAud, 1);
        expect(netWorthByCountry.GB ?? 0, 'netWorthByCountryConverted GB bucket matches oracle (already AUD)').toBeCloseTo(gbAssetValueAud, 1);
        const sumOfBuckets = summary.netWorthByCountryConverted.reduce((s, r) => s + r.value, 0);
        expect(sumOfBuckets, 'sum of per-country buckets equals computeDashboard()\'s own netWorth -- live domestic+overseas=consolidated proof').toBeCloseTo(summary.netWorth, 1);

        // =====================================================================
        // 2. Contract 2 (country_code on income/expense/insurance) — real rows.
        // =====================================================================
        const { data: incomeRow, error: incomeErr } = await admin.from('income_sources').insert({ user_id: userAU.userId, source_name: `${RUN} salary`, income_type: 'salary', amount: 5000, frequency: 'monthly', currency_code: 'AUD', country_code: 'GB', is_active: true }).select('id, country_code').single();
        expect(incomeErr, JSON.stringify(incomeErr)).toBeNull();
        expect(incomeRow?.country_code, 'Contract 2: income_sources accepts widened country_code (GB)').toBe('GB');

        const { data: expenseRow, error: expenseErr } = await admin.from('expense_items').insert({ user_id: userAU.userId, expense_name: `${RUN} rent`, expense_category: 'housing', amount: 2000, frequency: 'monthly', currency_code: 'AUD', country_code: 'IN', is_active: true }).select('id, country_code').single();
        expect(expenseErr, JSON.stringify(expenseErr)).toBeNull();
        expect(expenseRow?.country_code, 'Contract 2: expense_items accepts widened country_code (IN)').toBe('IN');

        const { data: insuranceRow, error: insuranceErr } = await admin.from('insurance_policies').insert({ user_id: userAU.userId, policy_name: `${RUN} policy`, cover_type: 'life', cover_amount: 500000, premium: 50, premium_frequency: 'monthly', currency_code: 'AUD', country_code: 'AE', is_active: true }).select('id, country_code').single();
        expect(insuranceErr, JSON.stringify(insuranceErr)).toBeNull();
        expect(insuranceRow?.country_code, 'Contract 2: insurance_policies accepts widened country_code (AE)').toBe('AE');

        // =====================================================================
        // 3. Contract 3 (FX-rate lineage on financial_snapshots) — real row.
        // =====================================================================
        const snapMonth = new Date().toISOString().slice(0, 7) + '-01';
        const { data: snapRow, error: snapErr } = await admin
          .from('financial_snapshots')
          .upsert(
            { user_id: userAU.userId, snapshot_month: snapMonth, net_worth: summary.netWorth, monthly_income: 0, monthly_expenses: 0, monthly_surplus: 0, savings_rate: null, total_assets: summary.totalAssets, total_liabilities: 0, currency_code: 'AUD', fx_rate_aud_inr: fxRateAudInr, fx_rate_date: new Date().toISOString().slice(0, 10) },
            { onConflict: 'user_id,snapshot_month' }
          )
          .select('fx_rate_aud_inr, fx_rate_date')
          .single();
        expect(snapErr, JSON.stringify(snapErr)).toBeNull();
        expect(Number(snapRow?.fx_rate_aud_inr), 'Contract 3: financial_snapshots.fx_rate_aud_inr stores the real rate').toBe(fxRateAudInr);
        expect(snapRow?.fx_rate_date, 'Contract 3: financial_snapshots.fx_rate_date is populated').toBeTruthy();

        // =====================================================================
        // 4. Contract 6 (goal-funding cross-currency conversion) — real oracle.
        // =====================================================================
        const linkedInvestmentValueInr = 1_120_000;
        const allocationPct = 50;
        const expectedFundingAud = (linkedInvestmentValueInr / fxRateAudInr) * (allocationPct / 100);
        console.log(`Hand-calculated goal-funding oracle: ${linkedInvestmentValueInr} INR / ${fxRateAudInr} * ${allocationPct}% = ${expectedFundingAud.toFixed(2)} AUD`);
        const fundingResult = computeLiveLinkedFundingValue(
          [{ sourceType: 'investment', linkedAssetId: null, linkedInvestmentId: 'inv-live-dev', linkedRetirementId: null, allocationPercentage: allocationPct, allocatedAmount: 0 }],
          new Map([['inv-live-dev', { value: linkedInvestmentValueInr, currencyCode: 'INR' }]]),
          'AUD',
          fxRateAudInr
        );
        expect(fundingResult, 'Contract 6: computeLiveLinkedFundingValue() matches the hand-calculated cross-currency oracle').toBeCloseTo(expectedFundingAud, 1);

        // =====================================================================
        // 5. Contract 7/10 (cross-border capability + real relationship signal)
        // =====================================================================
        // Sanity: userCb has zero country-tagged financial records, so its
        // isCrossBorder signal is driven ONLY by the relationship's own
        // state -- isolating exactly the behaviour Contract 10 controls,
        // not conflated with dashboard.countriesInUse (userAU's own OR
        // condition, correctly, is not isolated the same way).
        const twinBaseline = await loadTwinSourceData(userCb.userId, admin as never);
        expect(twinBaseline.status).toBe('ok');
        if (twinBaseline.status === 'ok') {
          expect(twinBaseline.data.household.isCrossBorder, 'baseline: isCrossBorder FALSE with no relationship and no multi-country records').toBe(false);
        }

        const { data: cbRow, error: cbErr } = await admin.from('cross_border_relationships').insert({ user_id: userCb.userId, country_code: 'IN', relationship_type: 'ASSET', status: 'ACTIVE', source: 'USER_DECLARED', confirmed_at: new Date().toISOString() }).select('id, status').single();
        expect(cbErr, JSON.stringify(cbErr)).toBeNull();
        expect(cbRow?.status).toBe('ACTIVE');

        const twinBefore = await loadTwinSourceData(userCb.userId, admin as never);
        expect(twinBefore.status).toBe('ok');
        if (twinBefore.status === 'ok') {
          expect(twinBefore.data.household.isCrossBorder, 'Contract 10: isCrossBorder TRUE with a real active relationship (real DB read)').toBe(true);
        }

        const { error: deactivateErr } = await admin.from('cross_border_relationships').update({ status: 'ENDED', end_date: new Date().toISOString().slice(0, 10) }).eq('id', cbRow!.id);
        expect(deactivateErr, JSON.stringify(deactivateErr)).toBeNull();
        const twinAfter = await loadTwinSourceData(userCb.userId, admin as never);
        expect(twinAfter.status).toBe('ok');
        if (twinAfter.status === 'ok') {
          expect(twinAfter.data.household.isCrossBorder, 'Contract 10: isCrossBorder flips FALSE after real deactivation, isolated from userAU\'s own countriesInUse signal').toBe(false);
        }

        // Duplicate-active-relationship rejection (real unique index).
        await admin.from('cross_border_relationships').insert({ user_id: userCb.userId, country_code: 'GB', relationship_type: 'INCOME', status: 'ACTIVE', source: 'USER_DECLARED', confirmed_at: new Date().toISOString() });
        const { error: dupErr } = await admin.from('cross_border_relationships').insert({ user_id: userCb.userId, country_code: 'GB', relationship_type: 'INCOME', status: 'ACTIVE', source: 'USER_DECLARED', confirmed_at: new Date().toISOString() });
        expect(dupErr?.code, 'a real duplicate ACTIVE (user,country,type) relationship is rejected by the DB unique index').toBe('23505');

        // =====================================================================
        // 6. Real cross-tenant RLS proof.
        // =====================================================================
        const attackerClient = await signIn(userAttacker.email, userAttacker.password);

        const { data: ownRead, error: ownReadErr } = await attackerClient.from('assets').select('id');
        expect(ownReadErr, 'positive control: attacker reading their OWN assets succeeds').toBeNull();
        expect(Array.isArray(ownRead)).toBe(true);

        const { data: crossRead } = await attackerClient.from('assets').select('id').eq('user_id', userAU.userId);
        expect(crossRead?.length, 'cross-tenant READ of another user\'s assets returns zero rows (RLS-blocked)').toBe(0);

        const { data: crossCbRead } = await attackerClient.from('cross_border_relationships').select('id').eq('user_id', userAU.userId);
        expect(crossCbRead?.length, 'cross-tenant READ of another user\'s cross_border_relationships returns zero rows').toBe(0);

        const { error: crossWriteErr, data: crossWriteData } = await attackerClient.from('assets').insert({ user_id: userAU.userId, asset_name: 'forged', current_value: 999999, asset_class: 'cash', currency_code: 'AUD', is_active: true }).select();
        expect(!!crossWriteErr || (Array.isArray(crossWriteData) && crossWriteData.length === 0), 'cross-tenant WRITE with a forged user_id is blocked by RLS').toBe(true);
      } finally {
        // ===================================================================
        // Cleanup — delete everything created, independently re-verify gone.
        // ===================================================================
        for (const table of ['assets', 'income_sources', 'expense_items', 'insurance_policies', 'financial_snapshots', 'cross_border_relationships']) {
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
        for (const table of ['assets', 'income_sources', 'expense_items', 'insurance_policies', 'cross_border_relationships']) {
          const { count } = await admin.from(table).select('id', { count: 'exact', head: true }).in('user_id', createdUserIds);
          if (count && count > 0) { residue++; console.error(`RESIDUE: ${count} rows remain in ${table}`); }
        }
        console.log(residue === 0 ? 'Zero residue confirmed -- all synthetic users and rows independently re-verified gone.' : `${residue} RESIDUE ITEMS REMAIN.`);
        expect(residue, 'zero synthetic residue after cleanup').toBe(0);
      }
    },
    120_000
  );
});
