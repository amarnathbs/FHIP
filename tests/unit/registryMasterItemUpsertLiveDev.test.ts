// Regression test for the registry.ts save() partial-index defect.
//
// Migration 0042 relaxed investments' table-wide unique(user_id,
// master_item_key) to a PARTIAL unique index scoped to
// `where source_type = 'manual'` (uidx_investments_user_master_manual), so
// Investment Intelligence can publish multiple rows sharing a
// master_item_key. PostgREST's upsert onConflict option only ever accepts a
// plain column list — it cannot target a WHERE-scoped index — so a plain
// `.upsert(row, { onConflict: 'user_id,master_item_key' })` against
// `investments` 400s with Postgres 42P10 ("no unique or exclusion
// constraint matching the ON CONFLICT specification") for EVERY row, not
// just retired master items. This is exactly the checkbox-recheck /
// edit-existing-row path app/api/investments/route.ts's POST drives via
// registry.ts's save() for every non-custom investment grid row.
//
// This suite exercises the REAL production code path — registry.ts's
// save() itself, through a genuinely RLS-scoped authenticated Supabase
// client — not a hand-rolled reimplementation of its logic.
//
// OPT-IN, same convention as tests/unit/iiR4LiveIntegration.test.ts.
// Skipped unless REGISTRY_LIVE=1, so the normal suite stays hermetic:
//   REGISTRY_LIVE=1 npx vitest run tests/unit/registryMasterItemUpsertLiveDev.test.ts

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'fs';
import { createClient as createSupabaseClient, type SupabaseClient } from '@supabase/supabase-js';

const LIVE = process.env.REGISTRY_LIVE === '1';
const d = describe.skipIf(!LIVE);

function loadEnv(): Record<string, string> {
  const text = readFileSync('D:/FHIP/.env.local', 'utf-8');
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

const RUN_ID = Date.now();
const state: {
  env: Record<string, string>;
  admin: SupabaseClient;
  userAId: string;
  userBId: string;
} = {} as never;

async function makeTestUser(label: string): Promise<{ userId: string; client: SupabaseClient }> {
  const { env, admin } = state;
  const email = `registry-live-${label}-${RUN_ID}@test.fhip.invalid`;
  const { data: created, error: createErr } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (createErr || !created.user) throw new Error(`Failed to create test user ${label}: ${createErr?.message}`);

  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  if (linkErr || !link.properties?.hashed_token) throw new Error(`Failed to generate link for ${label}: ${linkErr?.message}`);

  const verifyClient = createSupabaseClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  const { data: verified, error: verifyErr } = await verifyClient.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'magiclink' });
  if (verifyErr || !verified.session) throw new Error(`Failed to verify OTP for ${label}: ${verifyErr?.message}`);

  const client = createSupabaseClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    global: { headers: { Authorization: `Bearer ${verified.session.access_token}` } },
  });
  return { userId: created.user.id, client };
}

d('registry.ts save() — investments partial-index upsert (live DEV)', () => {
  let userA: { userId: string; client: SupabaseClient };
  let userB: { userId: string; client: SupabaseClient };
  let registryModule: typeof import('@/lib/services/registry');

  beforeAll(async () => {
    const env = loadEnv();
    state.env = env;
    state.admin = createSupabaseClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);

    userA = await makeTestUser('a');
    userB = await makeTestUser('b');
    state.userAId = userA.userId;
    state.userBId = userB.userId;

    // registry.ts's createClient() (lib/supabase/server) is request-scoped
    // (reads cookies via next/headers) and cannot run outside an actual
    // Next.js request — same limitation documented in
    // tests/unit/resourcesR1_4LiveDev.test.ts. Mock it to return a
    // pre-authenticated client for whichever user the test is driving, so
    // save()'s own logic — the real production code — runs unmodified
    // under real RLS.
    let activeClient: SupabaseClient = userA.client;
    vi.doMock('@/lib/supabase/server', () => ({
      createClient: async () => activeClient,
    }));
    registryModule = await import('@/lib/services/registry');
    (globalThis as unknown as { __setActiveRegistryClient: (c: SupabaseClient) => void }).__setActiveRegistryClient = (c) => {
      activeClient = c;
    };
  }, 30000);

  afterAll(async () => {
    await state.admin.from('investments').delete().eq('user_id', state.userAId);
    await state.admin.from('investments').delete().eq('user_id', state.userBId);
    await state.admin.auth.admin.deleteUser(state.userAId);
    await state.admin.auth.admin.deleteUser(state.userBId);
    vi.doUnmock('@/lib/supabase/server');
  }, 30000);

  function setActiveClient(client: SupabaseClient) {
    (globalThis as unknown as { __setActiveRegistryClient: (c: SupabaseClient) => void }).__setActiveRegistryClient(client);
  }

  it('(c) reproduces the exact bug report scenario end-to-end: an ordinary, still-active master item (australian_shares) now saves successfully', async () => {
    setActiveClient(userA.client);
    const registry = registryModule.makeRegistry('investments', { manualScopedUpsert: true });

    const { data, error } = await registry.save(userA.userId, {
      investment_name: 'Test Australian Shares',
      investment_type: 'shares',
      current_value: 1000,
      currency_code: 'AUD',
      owner: 'self',
      master_item_key: 'australian_shares',
    });

    expect(error, `save() must not error — this is the exact 42P10 regression: ${JSON.stringify(error)}`).toBeNull();
    expect(data).toBeTruthy();
    expect((data as { master_item_key: string }).master_item_key).toBe('australian_shares');
  });

  it('(a) a legitimate manual master-item row can be created and re-saved (checked/unchecked/re-checked) without creating a duplicate', async () => {
    setActiveClient(userA.client);
    const registry = registryModule.makeRegistry('investments', { manualScopedUpsert: true });

    const first = await registry.save(userA.userId, {
      investment_name: 'ETF v1',
      investment_type: 'etf',
      current_value: 5000,
      currency_code: 'AUD',
      owner: 'self',
      master_item_key: 'etfs',
    });
    expect(first.error).toBeNull();
    const firstId = (first.data as { id: string }).id;

    // Edit (checkbox stays checked, value changes).
    const edited = await registry.save(userA.userId, {
      investment_name: 'ETF v2 edited',
      investment_type: 'etf',
      current_value: 6000,
      currency_code: 'AUD',
      owner: 'self',
      master_item_key: 'etfs',
    });
    expect(edited.error).toBeNull();
    expect((edited.data as { id: string }).id).toBe(firstId);
    expect((edited.data as { current_value: number }).current_value).toBe(6000);

    // Uncheck (archive).
    const archived = await registry.archive(userA.userId, firstId);
    expect(archived.error).toBeNull();
    expect((archived.data as { is_active: boolean }).is_active).toBe(false);

    // Re-check.
    const reChecked = await registry.save(userA.userId, {
      investment_name: 'ETF v3 rechecked',
      investment_type: 'etf',
      current_value: 7000,
      currency_code: 'AUD',
      owner: 'self',
      master_item_key: 'etfs',
    });
    expect(reChecked.error).toBeNull();
    expect((reChecked.data as { id: string }).id).toBe(firstId);
    expect((reChecked.data as { is_active: boolean }).is_active).toBe(true);

    const { data: rows } = await state.admin.from('investments').select('id').eq('user_id', userA.userId).eq('master_item_key', 'etfs');
    expect(rows).toHaveLength(1);
  });

  it("(b) the fix doesn't allow a manual row to collide with or overwrite a published row sharing the same master_item_key", async () => {
    const { data: published, error: pubErr } = await state.admin
      .from('investments')
      .insert({
        user_id: userB.userId,
        investment_name: 'II Published Managed Fund',
        investment_type: 'managed_fund',
        current_value: 50000,
        currency_code: 'AUD',
        owner: 'self',
        master_item_key: 'managed_funds',
        source_type: 'investment_intelligence_published',
        is_active: true,
      })
      .select()
      .single();
    expect(pubErr).toBeNull();

    setActiveClient(userB.client);
    const registry = registryModule.makeRegistry('investments', { manualScopedUpsert: true });

    const manualSave = await registry.save(userB.userId, {
      investment_name: 'My Manual Managed Fund',
      investment_type: 'managed_fund',
      current_value: 10000,
      currency_code: 'AUD',
      owner: 'self',
      master_item_key: 'managed_funds',
    });
    expect(manualSave.error).toBeNull();
    const manualRow = manualSave.data as { id: string; source_type: string };
    expect(manualRow.id).not.toBe((published as { id: string }).id);
    expect(manualRow.source_type).toBe('manual');

    const { data: publishedAfter } = await state.admin.from('investments').select('*').eq('id', (published as { id: string }).id).single();
    expect((publishedAfter as { source_type: string }).source_type).toBe('investment_intelligence_published');
    expect(Number((publishedAfter as { current_value: number }).current_value)).toBe(50000);

    // Re-saving must resolve to the manual row again, not the published one.
    const manualSave2 = await registry.save(userB.userId, {
      investment_name: 'My Manual Managed Fund edited',
      investment_type: 'managed_fund',
      current_value: 15000,
      currency_code: 'AUD',
      owner: 'self',
      master_item_key: 'managed_funds',
    });
    expect(manualSave2.error).toBeNull();
    expect((manualSave2.data as { id: string }).id).toBe(manualRow.id);

    const { data: rows } = await state.admin.from('investments').select('id, source_type').eq('user_id', userB.userId).eq('master_item_key', 'managed_funds');
    expect(rows).toHaveLength(2);
  });
});
