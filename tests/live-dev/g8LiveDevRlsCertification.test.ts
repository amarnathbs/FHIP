// G8 live-DEV RLS certification — closes 3 real, named coverage gaps from
// docs/country-programme/g8-discovery-batch5-pricing-auth-rls-mobile.md
// (G8.051), each previously "inferred from schema" or covered only for a
// SIBLING table, never live-attacked directly for the table named here:
//
//   1. business_entity_liabilities — sibling business_entity_assets (same
//      migration 0134, identical RLS policy shape) has a cross-tenant
//      forgery test; this table never did, despite directly affecting a
//      user's reported net worth.
//   2. report_access_events — every other report_* sibling (report_sections/
//      report_snapshots/report_exports/report_generation_runs) has a
//      cross-tenant forgery test; this per-user audit table appeared in
//      zero scripts anywhere.
//   3. user_entitlements.plan_tier — has a SELECT-own policy and (by
//      omission, per migration 0070) NO INSERT/UPDATE policy for
//      `authenticated` at all, so a raw client-side write should fail
//      closed by default-deny. Only ever inferred from schema before —
//      never actually attempted against the real table's RLS.
//
// Same discipline as every other live-DEV test in this programme: real
// disposable synthetic DEV users, real authenticated (never service_role)
// sessions for the actual assertions, full cleanup + independent
// zero-residue re-check in a finally block.
//
// Run with: npx vitest run tests/live-dev/g8LiveDevRlsCertification.test.ts
import { describe, it, expect } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { generateReport } from '@/lib/services/reportsData';

const URL = 'https://vqycarelcoijzwlpkpcz.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!/vqycarelcoijzwlpkpcz/.test(URL)) throw new Error('REFUSING: not the DEV project');

describe('G8.051 live-DEV RLS certification — business_entity_liabilities, report_access_events, user_entitlements.plan_tier', () => {
  it(
    'proves cross-tenant isolation on business_entity_liabilities and report_access_events, and default-deny direct writes on user_entitlements.plan_tier, against real DEV infrastructure',
    async () => {
      if (!SERVICE_KEY || !ANON_KEY) {
        console.warn('SKIPPED: SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_ANON_KEY not present in this environment.');
        return;
      }
      const admin = createClient(URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
      const RUN = `g8ld-${Date.now().toString(36)}`;
      const createdUserIds: string[] = [];
      const createdReportIds: string[] = [];

      async function createSyntheticUser(label: string) {
        const email = `${RUN}-${label}@example.com`;
        const password = `Test-${Math.random().toString(36).slice(2)}-Aa1!`;
        const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
        if (error) throw new Error(`createUser ${email}: ${error.message}`);
        const userId = data.user!.id;
        createdUserIds.push(userId);
        return { userId, email, password };
      }

      async function signIn(email: string, password: string) {
        const client = createClient(URL, ANON_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
        const { error } = await client.auth.signInWithPassword({ email, password });
        if (error) throw new Error(`signIn ${email}: ${error.message}`);
        return client;
      }

      console.log(`Run tag: ${RUN}`);

      const owner = await createSyntheticUser('owner');
      const attacker = await createSyntheticUser('attacker');

      try {
        const ownerClient = await signIn(owner.email, owner.password);
        const attackerClient = await signIn(attacker.email, attacker.password);

        // =====================================================================
        // 1. business_entity_liabilities cross-tenant forgery test.
        // =====================================================================
        const { data: entity, error: entityErr } = await ownerClient
          .from('business_entities')
          .insert({ user_id: owner.userId, name: `${RUN} co`, entity_type: 'company', ownership_percentage: 100, valuation_mode: 'detailed', currency_code: 'AUD' })
          .select('id')
          .single();
        expect(entityErr, JSON.stringify(entityErr)).toBeNull();

        const { data: liability, error: liabilityErr } = await ownerClient
          .from('business_entity_liabilities')
          .insert({ user_id: owner.userId, business_entity_id: entity!.id, label: `${RUN} loan`, value: 50000, currency_code: 'AUD' })
          .select('id')
          .single();
        expect(liabilityErr, JSON.stringify(liabilityErr)).toBeNull();

        // Positive control: owner can read their own liability row.
        const { data: ownRead } = await ownerClient.from('business_entity_liabilities').select('id').eq('id', liability!.id);
        expect(ownRead?.length, 'positive control: owner reading own business_entity_liabilities row').toBe(1);

        // Cross-tenant read.
        const { data: crossRead } = await attackerClient.from('business_entity_liabilities').select('id').eq('id', liability!.id);
        expect(crossRead?.length, 'business_entity_liabilities: cross-tenant READ returns 0 rows').toBe(0);

        // Cross-tenant write (update another tenant's row by guessed id).
        const { error: crossUpdErr, count: crossUpdCount } = await attackerClient
          .from('business_entity_liabilities')
          .update({ value: 999999 }, { count: 'exact' })
          .eq('id', liability!.id);
        expect(!!crossUpdErr || crossUpdCount === 0, 'business_entity_liabilities: cross-tenant UPDATE affects 0 rows').toBe(true);

        // Cross-tenant impersonation-insert: attacker attaches a liability to
        // the OWNER's own real entity id, forging user_id = owner.
        const { error: forgeErr, data: forgeData } = await attackerClient
          .from('business_entity_liabilities')
          .insert({ user_id: owner.userId, business_entity_id: entity!.id, label: 'forged', value: 1, currency_code: 'AUD' })
          .select();
        expect(!!forgeErr || (Array.isArray(forgeData) && forgeData.length === 0), 'business_entity_liabilities: cross-tenant impersonation-INSERT is blocked').toBe(true);

        // =====================================================================
        // 2. report_access_events cross-tenant forgery test.
        // =====================================================================
        const reportResult = await generateReport({ userId: owner.userId, reportType: 'net_worth', client: admin as never });
        createdReportIds.push(reportResult.report.id);

        const { data: accessEvent, error: accessEventErr } = await admin
          .from('report_access_events')
          .insert({ report_id: reportResult.report.id, user_id: owner.userId, event_type: 'viewed' })
          .select('id')
          .single();
        expect(accessEventErr, JSON.stringify(accessEventErr)).toBeNull();

        const { data: ownAccessRead } = await ownerClient.from('report_access_events').select('id').eq('id', accessEvent!.id);
        expect(ownAccessRead?.length, 'positive control: owner reading own report_access_events row').toBe(1);

        const { data: crossAccessRead } = await attackerClient.from('report_access_events').select('id').eq('id', accessEvent!.id);
        expect(crossAccessRead?.length, 'report_access_events: cross-tenant READ returns 0 rows').toBe(0);

        // No INSERT policy exists at all for `authenticated` since migration
        // 0070 (server-side/service_role only) -- even the OWNER'S OWN
        // authenticated client should be unable to insert a new access event
        // directly, let alone a forged cross-tenant one.
        const { error: ownInsertErr, data: ownInsertData } = await ownerClient
          .from('report_access_events')
          .insert({ report_id: reportResult.report.id, user_id: owner.userId, event_type: 'printed' })
          .select();
        expect(!!ownInsertErr || (Array.isArray(ownInsertData) && ownInsertData.length === 0), 'report_access_events: even the OWNER\'S OWN authenticated client cannot INSERT directly (service_role/server-only by design since migration 0070)').toBe(true);

        const { error: forgedAccessErr, data: forgedAccessData } = await attackerClient
          .from('report_access_events')
          .insert({ report_id: reportResult.report.id, user_id: owner.userId, event_type: 'downloaded' })
          .select();
        expect(!!forgedAccessErr || (Array.isArray(forgedAccessData) && forgedAccessData.length === 0), 'report_access_events: cross-tenant forged-user_id INSERT is blocked').toBe(true);

        // =====================================================================
        // 3. user_entitlements.plan_tier direct-write RLS boundary.
        // =====================================================================
        const { data: beforeRow } = await admin.from('user_entitlements').select('plan_tier').eq('user_id', owner.userId).single();
        expect(beforeRow?.plan_tier, 'owner starts on the real default plan_tier (free)').toBe('free');

        // Positive control: owner CAN read their own entitlement row.
        const { data: ownEntitlementRead } = await ownerClient.from('user_entitlements').select('plan_tier').eq('user_id', owner.userId);
        expect(ownEntitlementRead?.length, 'positive control: owner reading own user_entitlements row').toBe(1);

        // The actual attack: a raw client-side self-upgrade write against the
        // table directly (not through any application route or webhook).
        const { error: selfUpgradeErr, count: selfUpgradeCount } = await ownerClient
          .from('user_entitlements')
          .update({ plan_tier: 'premium' }, { count: 'exact' })
          .eq('user_id', owner.userId);
        expect(!!selfUpgradeErr || selfUpgradeCount === 0, 'user_entitlements: raw authenticated self-upgrade UPDATE affects 0 rows (default-deny, no UPDATE policy exists)').toBe(true);

        const { data: afterRow } = await admin.from('user_entitlements').select('plan_tier').eq('user_id', owner.userId).single();
        expect(afterRow?.plan_tier, 'user_entitlements.plan_tier genuinely unchanged after the attempted self-upgrade').toBe('free');

        // Cross-tenant variant: attacker attempts to upgrade the OWNER's row.
        const { error: crossEntitlementErr, count: crossEntitlementCount } = await attackerClient
          .from('user_entitlements')
          .update({ plan_tier: 'premium' }, { count: 'exact' })
          .eq('user_id', owner.userId);
        expect(!!crossEntitlementErr || crossEntitlementCount === 0, 'user_entitlements: cross-tenant UPDATE of another user\'s plan_tier affects 0 rows').toBe(true);
        const { data: crossEntitlementRead } = await attackerClient.from('user_entitlements').select('plan_tier').eq('user_id', owner.userId);
        expect(crossEntitlementRead?.length, 'user_entitlements: cross-tenant READ of another user\'s entitlement row returns 0 rows').toBe(0);
      } finally {
        // ===================================================================
        // Cleanup — delete everything created, independently re-verify gone.
        // ===================================================================
        for (const reportId of createdReportIds) {
          await admin.from('report_access_events').delete().eq('report_id', reportId);
          await admin.from('report_snapshots').delete().eq('report_id', reportId);
          await admin.from('report_sections').delete().eq('report_id', reportId);
        }
        await admin.from('reports').delete().in('id', createdReportIds);
        await admin.from('report_generation_runs').delete().in('user_id', createdUserIds);
        for (const table of ['business_entity_liabilities', 'business_entity_assets', 'business_entities']) {
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
        for (const table of ['business_entity_liabilities', 'business_entity_assets', 'business_entities']) {
          const { count } = await admin.from(table).select('id', { count: 'exact', head: true }).in('user_id', createdUserIds);
          if (count && count > 0) { residue++; console.error(`RESIDUE: ${count} rows remain in ${table}`); }
        }
        const { count: reportResidue } = await admin.from('reports').select('id', { count: 'exact', head: true }).in('id', createdReportIds);
        if (reportResidue && reportResidue > 0) { residue++; console.error(`RESIDUE: ${reportResidue} report rows remain`); }
        // user_entitlements rows are deleted automatically by the auth.users
        // cascade (on delete cascade), not independently -- no separate
        // cleanup call needed, but worth re-confirming nothing is orphaned.
        const { count: entitlementResidue } = await admin.from('user_entitlements').select('user_id', { count: 'exact', head: true }).in('user_id', createdUserIds);
        if (entitlementResidue && entitlementResidue > 0) { residue++; console.error(`RESIDUE: ${entitlementResidue} user_entitlements rows remain`); }
        console.log(residue === 0 ? 'Zero residue confirmed -- all synthetic users, reports and rows independently re-verified gone.' : `${residue} RESIDUE ITEMS REMAIN.`);
        expect(residue, 'zero synthetic residue after cleanup').toBe(0);
      }
    },
    120_000
  );
});
