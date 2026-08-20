// Investment Intelligence R3 — provenance-preservation closure pass
// (docs/investment-intelligence/R3_CLOSURE_REPORT.md). Real, automated,
// assertion-bearing tests for the defect the orchestrating session's own
// live-DEV testing found (investment_name silently lost on unpublish) and
// for the two sibling fields (currency_code, country_code) this closure
// pass's own field-matrix inspection additionally found broken the same
// way. Drives the REAL investmentPublicationService.ts functions
// (publishPosition / refreshPosition / unpublishPosition) end to end
// through a minimal in-memory fake Postgrest client — not a re-
// implementation of the logic under test, just enough of the
// `.from(table).select/insert/update/eq/neq/in/maybeSingle/single` surface
// that this service actually calls to drive real scenarios deterministically
// and fast, without a live DB. Cross-user/RLS behaviour is NOT claimed to be
// covered here (a fake client cannot exercise real Postgres RLS) — that is
// covered separately by the live-DEV SEC-R3C-* pass documented in
// R3_CLOSURE_REPORT.md.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }));
vi.mock('@/lib/services/investment-intelligence/audit', () => ({ emitAuditEvent: vi.fn(async () => ({ error: null })) }));

import { createClient } from '@/lib/supabase/server';
import { emitAuditEvent } from '@/lib/services/investment-intelligence/audit';
import { publishPosition, refreshPosition, unpublishPosition } from '@/lib/services/investment-intelligence/investmentPublicationService';
import { buildPreLinkManualSnapshot, restorableFieldsFromManualSnapshot } from '@/lib/services/investment-intelligence/publicationLogic';

// ---------------------------------------------------------------------------
// Minimal in-memory fake Postgrest-shaped client.
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;
type FakeDb = Record<string, Row[]>;

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

interface ForcedError {
  table: string;
  op: 'insert' | 'update';
  message: string;
}

function makeFakeSupabase(db: FakeDb, opts: { forcedErrors?: ForcedError[] } = {}) {
  const forcedErrors = opts.forcedErrors ?? [];

  function consumeForcedError(table: string, op: 'insert' | 'update'): string | null {
    const idx = forcedErrors.findIndex((f) => f.table === table && f.op === op);
    if (idx === -1) return null;
    const [f] = forcedErrors.splice(idx, 1);
    return f.message;
  }

  function from(table: string) {
    if (!db[table]) db[table] = [];
    const filters: Array<(r: Row) => boolean> = [];
    let pending: { type: 'insert' | 'update'; payload: Row } | null = null;

    function matchRows(): Row[] {
      return db[table].filter((r) => filters.every((f) => f(r)));
    }

    function execute(): { data: unknown; error: { message: string } | null } {
      if (pending?.type === 'insert') {
        const forced = consumeForcedError(table, 'insert');
        if (forced) return { data: null, error: { message: forced } };
        const row: Row = { id: nextId(table), created_at: new Date().toISOString(), ...pending.payload };
        db[table].push(row);
        return { data: [row], error: null };
      }
      if (pending?.type === 'update') {
        const forced = consumeForcedError(table, 'update');
        if (forced) return { data: null, error: { message: forced } };
        const matched = matchRows();
        for (const r of matched) Object.assign(r, pending!.payload);
        return { data: matched, error: null };
      }
      return { data: matchRows(), error: null };
    }

    const api = {
      select() {
        return api;
      },
      eq(col: string, val: unknown) {
        filters.push((r) => r[col] === val);
        return api;
      },
      neq(col: string, val: unknown) {
        filters.push((r) => r[col] !== val);
        return api;
      },
      in(col: string, vals: unknown[]) {
        filters.push((r) => vals.includes(r[col]));
        return api;
      },
      is(col: string, val: null) {
        filters.push((r) => (r[col] ?? null) === val);
        return api;
      },
      insert(payload: Row | Row[]) {
        pending = { type: 'insert', payload: Array.isArray(payload) ? payload[0] : payload };
        return api;
      },
      update(payload: Row) {
        pending = { type: 'update', payload };
        return api;
      },
      maybeSingle() {
        const { data, error } = execute();
        const arr = (data as Row[] | null) ?? [];
        return Promise.resolve({ data: arr[0] ?? null, error });
      },
      single() {
        const { data, error } = execute();
        const arr = (data as Row[] | null) ?? [];
        if (!error && arr.length === 0) return Promise.resolve({ data: null, error: { message: 'no rows' } });
        return Promise.resolve({ data: arr[0] ?? null, error });
      },
      then(resolve: (v: { data: unknown; error: unknown }) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve(execute()).then(resolve, reject);
      },
    };
    return api;
  }

  return { from } as unknown as Awaited<ReturnType<typeof createClient>>;
}

// ---------------------------------------------------------------------------
// Fixture builder: seeds a fake DB with one economic position's full
// dependency chain (account, instrument, snapshot, portfolio-truth,
// household member) plus, optionally, a manual investments row to link to.
// ---------------------------------------------------------------------------
function seedPosition(db: FakeDb, opts: { userId: string; asOfDate: string; value: number; instrumentName: string; snapshotIdSuffix: string; certifiedAt?: string }) {
  const accountId = `acct-${opts.userId}`;
  const instrumentId = `instr-${opts.userId}`;
  const positionId = `pos-${opts.userId}-${opts.snapshotIdSuffix}`;

  if (!db.ii_accounts) db.ii_accounts = [];
  if (!db.ii_accounts.find((r) => r.id === accountId)) {
    db.ii_accounts.push({ id: accountId, user_id: opts.userId, account_type: 'demat', institution_name: 'XYZ AMC', country_code: 'IN', currency_code: 'INR', owner_member_id: `member-${opts.userId}` });
  }
  if (!db.ii_instruments) db.ii_instruments = [];
  if (!db.ii_instruments.find((r) => r.id === instrumentId)) {
    db.ii_instruments.push({ id: instrumentId, instrument_class: 'mutual_fund', instrument_name: opts.instrumentName, amc_name: 'XYZ AMC' });
  } else {
    // A "refresh" with a different instrument name is not realistic (same
    // instrument), but publishPosition always writes instrument.instrument_name
    // — keep it stable across snapshots of the SAME instrument.
  }
  if (!db.household_members) db.household_members = [];
  if (!db.household_members.find((r) => r.id === `member-${opts.userId}`)) {
    db.household_members.push({ id: `member-${opts.userId}`, user_id: opts.userId, relationship: 'self', full_name: 'Test User' });
  }
  if (!db.ii_portfolio_truth_status) db.ii_portfolio_truth_status = [];
  db.ii_portfolio_truth_status.push({ user_id: opts.userId, account_id: accountId, instrument_id: instrumentId, status: 'certified', history_completeness: 'holdings_only' });

  if (!db.ii_holding_snapshots) db.ii_holding_snapshots = [];
  db.ii_holding_snapshots.push({
    id: positionId,
    user_id: opts.userId,
    account_id: accountId,
    instrument_id: instrumentId,
    as_of_date: opts.asOfDate,
    value: opts.value,
    currency_code: 'INR',
    quality_status: 'certified',
    created_at: opts.certifiedAt ?? new Date().toISOString(),
  });

  return { accountId, instrumentId, positionId };
}

function seedManualInvestment(db: FakeDb, opts: { userId: string; investmentName: string; currentValue: number; currencyCode?: string; countryCode?: string | null }) {
  if (!db.investments) db.investments = [];
  const row: Row = {
    id: nextId('inv'),
    user_id: opts.userId,
    investment_name: opts.investmentName,
    investment_type: 'managed_fund',
    current_value: opts.currentValue,
    currency_code: opts.currencyCode ?? 'AUD',
    country_code: opts.countryCode === undefined ? 'AU' : opts.countryCode,
    institution: 'Original Manual Institution',
    cost_base: 480000,
    owner: 'self',
    master_item_key: 'managed_funds',
    annual_contribution: 12000,
    risk_profile: 'balanced',
    source_type: 'manual',
    is_active: true,
    pre_publication_manual_snapshot: null,
    ii_publication_id: null,
    ii_canonical_account_id: null,
    ii_canonical_instrument_id: null,
    ii_source_quality_status: null,
    ii_linked_at: null,
    ii_last_refreshed_at: null,
  };
  db.investments.push(row);
  return row;
}

describe('R3 closure — provenance snapshot pure functions', () => {
  it('buildPreLinkManualSnapshot captures investment_name, currency_code, and country_code (the fields the original defect missed)', () => {
    const snap = buildPreLinkManualSnapshot(
      { investment_name: 'Original Manual Investment', investment_type: 'managed_fund', current_value: 500000, currency_code: 'AUD', country_code: 'AU', institution: 'Bank', cost_base: 480000, owner: 'self', master_item_key: 'managed_funds', annual_contribution: 12000, risk_profile: 'balanced' },
      '2026-01-01T00:00:00.000Z'
    );
    expect(snap.investment_name).toBe('Original Manual Investment');
    expect(snap.currency_code).toBe('AUD');
    expect(snap.country_code).toBe('AU');
    expect(snap.current_value).toBe(500000);
    expect(snap.captured_at).toBe('2026-01-01T00:00:00.000Z');
  });

  it('restorableFieldsFromManualSnapshot drops captured_at and every other non-column key', () => {
    const out = restorableFieldsFromManualSnapshot({ investment_name: 'X', current_value: 1, currency_code: 'AUD', country_code: 'AU', cost_base: null, institution: null, owner: 'self', investment_type: 'managed_fund', master_item_key: 'managed_funds', annual_contribution: null, risk_profile: 'balanced', captured_at: '2026-01-01', some_unrelated_key: 'zzz' });
    expect(out).not.toHaveProperty('captured_at');
    expect(out).not.toHaveProperty('some_unrelated_key');
    expect(out.investment_name).toBe('X');
  });

  it('PROV-R3C-009 (schema-verified): investment_name is NOT NULL in the real investments table (migration 0003) — a genuinely null original name is not a real possible input. Empty-string/whitespace/Unicode ARE valid and must round-trip exactly', () => {
    const cases = ['', '   ', 'निवेश योजना 🇮🇳', 'A'.repeat(500), "O'Brien's Fund — \"Class A\""];
    for (const name of cases) {
      const snap = buildPreLinkManualSnapshot({ investment_name: name, investment_type: 'managed_fund', current_value: 1, currency_code: 'AUD', country_code: 'AU', institution: null, cost_base: null, owner: 'self', master_item_key: 'managed_funds', annual_contribution: null, risk_profile: null }, 'now');
      const restored = restorableFieldsFromManualSnapshot(snap);
      expect(restored.investment_name).toBe(name);
    }
  });

  it('a pre-fix snapshot (missing investment_name/currency_code/country_code keys entirely) restores those keys as undefined, which JSON.stringify drops — never fabricates a value', () => {
    const oldFormatSnapshot = { current_value: 500000, cost_base: 480000, institution: 'Old Bank', owner: 'self', investment_type: 'managed_fund', master_item_key: 'managed_funds', annual_contribution: 12000, risk_profile: 'balanced', captured_at: '2026-01-01' };
    const restored = restorableFieldsFromManualSnapshot(oldFormatSnapshot);
    expect(restored.investment_name).toBeUndefined();
    expect(restored.currency_code).toBeUndefined();
    expect(restored.country_code).toBeUndefined();
    expect(JSON.parse(JSON.stringify(restored))).not.toHaveProperty('investment_name');
    expect(JSON.parse(JSON.stringify(restored))).not.toHaveProperty('currency_code');
    // current_value (already captured pre-fix) still round-trips correctly.
    expect(restored.current_value).toBe(500000);
  });
});

describe('R3 closure — full link -> refresh -> unpublish lifecycle (PROV-R3C-001..008, FIN-R3C-001..006)', () => {
  const userId = 'user-prov-a';
  let db: FakeDb;

  beforeEach(() => {
    db = {};
    vi.mocked(createClient).mockImplementation(async () => makeFakeSupabase(db));
    vi.mocked(emitAuditEvent).mockClear();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('PROV-R3C-001 basic name preservation: manual "Original Manual Name" -> publish imported "Imported Scheme Name" -> unpublish -> expect "Original Manual Name"', async () => {
    const manual = seedManualInvestment(db, { userId, investmentName: 'Original Manual Name', currentValue: 500000 });
    const { positionId } = seedPosition(db, { userId, asOfDate: '2026-01-01', value: 520000, instrumentName: 'Imported Scheme Name', snapshotIdSuffix: 'v1' });

    const pub = await publishPosition(userId, positionId, { linkToExistingInvestmentId: manual.id as string });
    expect(pub.error).toBeNull();
    expect(pub.action).toBe('REPLACE_LINK_EXISTING');
    const linkedRow = db.investments.find((r) => r.id === manual.id)!;
    expect(linkedRow.investment_name).toBe('Imported Scheme Name');
    expect(linkedRow.current_value).toBe(520000);

    const unpub = await unpublishPosition(userId, pub.publicationId as string);
    expect(unpub.error).toBeNull();
    const restoredRow = db.investments.find((r) => r.id === manual.id)!;
    expect(restoredRow.investment_name).toBe('Original Manual Name');
    expect(restoredRow.current_value).toBe(500000);
    expect(restoredRow.source_type).toBe('manual');
  });

  it('PROV-R3C-002 refresh does not destroy the original: manual -> publish V1 -> refresh V2 -> unpublish -> expect original manual name', async () => {
    const manual = seedManualInvestment(db, { userId, investmentName: 'Original Manual Name', currentValue: 500000 });
    const { positionId: posV1, accountId, instrumentId } = seedPosition(db, { userId, asOfDate: '2026-01-01', value: 520000, instrumentName: 'Imported Scheme Name', snapshotIdSuffix: 'v1' });
    const pub1 = await publishPosition(userId, posV1, { linkToExistingInvestmentId: manual.id as string });
    expect(pub1.error).toBeNull();

    // Refresh: a new snapshot for the SAME account/instrument, later as_of_date.
    db.ii_holding_snapshots.push({ id: `pos-${userId}-v2`, user_id: userId, account_id: accountId, instrument_id: instrumentId, as_of_date: '2026-02-01', value: 561000, currency_code: 'INR', quality_status: 'certified', created_at: new Date(Date.now() + 1000).toISOString() });
    const refresh = await refreshPosition(userId, `pos-${userId}-v2`);
    expect(refresh.error).toBeNull();
    expect(refresh.decision).toBe('ACTIVATE_NEW');
    const afterRefresh = db.investments.find((r) => r.id === manual.id)!;
    expect(afterRefresh.current_value).toBe(561000);
    // The snapshot itself must be untouched by refresh.
    const snapAfterRefresh = afterRefresh.pre_publication_manual_snapshot as Row;
    expect(snapAfterRefresh.investment_name).toBe('Original Manual Name');
    expect(snapAfterRefresh.current_value).toBe(500000);

    const unpub = await unpublishPosition(userId, refresh.publicationId as string);
    expect(unpub.error).toBeNull();
    const restored = db.investments.find((r) => r.id === manual.id)!;
    expect(restored.investment_name).toBe('Original Manual Name');
    expect(restored.current_value).toBe(500000);
  });

  it('PROV-R3C-003 multiple refreshes: manual -> V1 -> V2 -> V3 -> unpublish -> expect original manual name', async () => {
    const manual = seedManualInvestment(db, { userId, investmentName: 'Original Manual Name', currentValue: 500000 });
    const { positionId: posV1, accountId, instrumentId } = seedPosition(db, { userId, asOfDate: '2026-01-01', value: 520000, instrumentName: 'Imported Scheme Name', snapshotIdSuffix: 'v1' });
    const pub1 = await publishPosition(userId, posV1, { linkToExistingInvestmentId: manual.id as string });
    expect(pub1.error).toBeNull();

    db.ii_holding_snapshots.push({ id: `pos-${userId}-v2`, user_id: userId, account_id: accountId, instrument_id: instrumentId, as_of_date: '2026-02-01', value: 540000, currency_code: 'INR', quality_status: 'certified', created_at: new Date(Date.now() + 1000).toISOString() });
    const refresh2 = await refreshPosition(userId, `pos-${userId}-v2`);
    expect(refresh2.error).toBeNull();

    db.ii_holding_snapshots.push({ id: `pos-${userId}-v3`, user_id: userId, account_id: accountId, instrument_id: instrumentId, as_of_date: '2026-03-01', value: 561000, currency_code: 'INR', quality_status: 'certified', created_at: new Date(Date.now() + 2000).toISOString() });
    const refresh3 = await refreshPosition(userId, `pos-${userId}-v3`);
    expect(refresh3.error).toBeNull();
    expect(db.investments.find((r) => r.id === manual.id)!.current_value).toBe(561000);

    const unpub = await unpublishPosition(userId, refresh3.publicationId as string);
    expect(unpub.error).toBeNull();
    const restored = db.investments.find((r) => r.id === manual.id)!;
    expect(restored.investment_name).toBe('Original Manual Name');
    expect(restored.current_value).toBe(500000);
    // Exactly one active publication throughout the chain (FIN-R3C style check).
    const activePubs = db.ii_fhip_publications.filter((r) => r.status === 'published');
    expect(activePubs.length).toBe(0); // unpublished at the end
    const nonTerminal = db.ii_fhip_publications.filter((r) => r.status !== 'unpublished' && r.status !== 'superseded');
    expect(nonTerminal.length).toBe(0);
  });

  it('PROV-R3C-004 idempotent publish: publish same position twice -> original pre-link snapshot unchanged (not recreated/overwritten)', async () => {
    const manual = seedManualInvestment(db, { userId, investmentName: 'Original Manual Name', currentValue: 500000 });
    const { positionId } = seedPosition(db, { userId, asOfDate: '2026-01-01', value: 520000, instrumentName: 'Imported Scheme Name', snapshotIdSuffix: 'v1' });
    const pub1 = await publishPosition(userId, positionId, { linkToExistingInvestmentId: manual.id as string });
    expect(pub1.error).toBeNull();
    const snapAfterFirst = JSON.stringify(db.investments.find((r) => r.id === manual.id)!.pre_publication_manual_snapshot);

    const pub2 = await publishPosition(userId, positionId, { linkToExistingInvestmentId: manual.id as string });
    expect(pub2.error).toBeNull();
    expect(pub2.action).toBe('LEAVE_UNCHANGED');
    expect(pub2.publicationId).toBe(pub1.publicationId);
    const snapAfterSecond = JSON.stringify(db.investments.find((r) => r.id === manual.id)!.pre_publication_manual_snapshot);
    expect(snapAfterSecond).toBe(snapAfterFirst);
    // No second publication row was created.
    expect(db.ii_fhip_publications.length).toBe(1);
  });

  it('PROV-R3C-005 unpublish/re-publish lifecycle: manual A -> publish -> unpublish -> publish -> unpublish -> expect manual A both times', async () => {
    const manual = seedManualInvestment(db, { userId, investmentName: 'Manual A', currentValue: 500000 });
    const { positionId: pos1 } = seedPosition(db, { userId, asOfDate: '2026-01-01', value: 520000, instrumentName: 'Imported Scheme Name', snapshotIdSuffix: 'v1' });

    const pub1 = await publishPosition(userId, pos1, { linkToExistingInvestmentId: manual.id as string });
    expect(pub1.error).toBeNull();
    const unpub1 = await unpublishPosition(userId, pub1.publicationId as string);
    expect(unpub1.error).toBeNull();
    expect(db.investments.find((r) => r.id === manual.id)!.investment_name).toBe('Manual A');

    // Second link cycle needs a NEW position id (refreshPosition/publishPosition
    // for the exact same positionId would hit the idempotency short-circuit).
    const { positionId: pos2 } = seedPosition(db, { userId, asOfDate: '2026-04-01', value: 530000, instrumentName: 'Imported Scheme Name', snapshotIdSuffix: 'v2' });
    const pub2 = await publishPosition(userId, pos2, { linkToExistingInvestmentId: manual.id as string });
    expect(pub2.error).toBeNull();
    const unpub2 = await unpublishPosition(userId, pub2.publicationId as string);
    expect(unpub2.error).toBeNull();
    expect(db.investments.find((r) => r.id === manual.id)!.investment_name).toBe('Manual A');
    expect(db.investments.find((r) => r.id === manual.id)!.current_value).toBe(500000);
  });

  it('PROV-R3C-006 manual edit between cycles: manual A -> publish -> unpublish -> user edits name to manual B -> publish again -> unpublish -> expect manual B, NOT manual A', async () => {
    const manual = seedManualInvestment(db, { userId, investmentName: 'Manual A', currentValue: 500000 });
    const { positionId: pos1 } = seedPosition(db, { userId, asOfDate: '2026-01-01', value: 520000, instrumentName: 'Imported Scheme Name', snapshotIdSuffix: 'v1' });
    const pub1 = await publishPosition(userId, pos1, { linkToExistingInvestmentId: manual.id as string });
    expect(pub1.error).toBeNull();
    await unpublishPosition(userId, pub1.publicationId as string);
    expect(db.investments.find((r) => r.id === manual.id)!.investment_name).toBe('Manual A');

    // User manually renames the row while it's back to source_type='manual'.
    const row = db.investments.find((r) => r.id === manual.id)!;
    row.investment_name = 'Manual B';

    const { positionId: pos2 } = seedPosition(db, { userId, asOfDate: '2026-04-01', value: 530000, instrumentName: 'Imported Scheme Name', snapshotIdSuffix: 'v2' });
    const pub2 = await publishPosition(userId, pos2, { linkToExistingInvestmentId: manual.id as string });
    expect(pub2.error).toBeNull();
    const linkedRow = db.investments.find((r) => r.id === manual.id)!;
    const secondSnapshot = linkedRow.pre_publication_manual_snapshot as Row;
    expect(secondSnapshot.investment_name).toBe('Manual B'); // fresh capture reflects the edit, not the original-original

    const unpub2 = await unpublishPosition(userId, pub2.publicationId as string);
    expect(unpub2.error).toBeNull();
    expect(db.investments.find((r) => r.id === manual.id)!.investment_name).toBe('Manual B');
  });

  it('PROV-R3C-008 failed publication: ii_fhip_publications insert fails after the manual row was already mutated -> compensation restores investment_name (the now-fixed, complete snapshot)', async () => {
    const manual = seedManualInvestment(db, { userId, investmentName: 'Original Manual Name', currentValue: 500000 });
    const { positionId } = seedPosition(db, { userId, asOfDate: '2026-01-01', value: 520000, instrumentName: 'Imported Scheme Name', snapshotIdSuffix: 'v1' });

    vi.mocked(createClient).mockImplementation(async () => makeFakeSupabase(db, { forcedErrors: [{ table: 'ii_fhip_publications', op: 'insert', message: 'simulated publication insert failure' }] }));

    const pub = await publishPosition(userId, positionId, { linkToExistingInvestmentId: manual.id as string });
    expect(pub.error).toContain('rolled back');
    expect(pub.publicationId).toBeNull();
    const revertedRow = db.investments.find((r) => r.id === manual.id)!;
    expect(revertedRow.source_type).toBe('manual');
    expect(revertedRow.investment_name).toBe('Original Manual Name'); // the fix: compensation now restores the name too
    expect(revertedRow.current_value).toBe(500000);
    expect(revertedRow.pre_publication_manual_snapshot).toBeNull();
    // No dangling publication row was left behind (insert genuinely failed).
    expect(db.ii_fhip_publications.length).toBe(0);
  });

  it('PROV-R3C-010 other overwritten fields (currency_code, country_code) are preserved and restored with the same rigor as investment_name', async () => {
    const manual = seedManualInvestment(db, { userId, investmentName: 'Original Manual Name', currentValue: 500000, currencyCode: 'AUD', countryCode: 'AU' });
    const { positionId } = seedPosition(db, { userId, asOfDate: '2026-01-01', value: 520000, instrumentName: 'Imported Scheme Name', snapshotIdSuffix: 'v1' });

    const pub = await publishPosition(userId, positionId, { linkToExistingInvestmentId: manual.id as string });
    expect(pub.error).toBeNull();
    const linked = db.investments.find((r) => r.id === manual.id)!;
    // During link, currency/country are overwritten to the certified position's (INR/IN).
    expect(linked.currency_code).toBe('INR');
    expect(linked.country_code).toBe('IN');

    const unpub = await unpublishPosition(userId, pub.publicationId as string);
    expect(unpub.error).toBeNull();
    const restored = db.investments.find((r) => r.id === manual.id)!;
    // The original manual AUD/AU pairing is restored exactly — this also
    // closes the latent currency/value-mismatch bug: current_value=500000
    // must never be left tagged with the wrong currency.
    expect(restored.currency_code).toBe('AUD');
    expect(restored.country_code).toBe('AU');
    expect(restored.current_value).toBe(500000);
  });

  it('II tracking fields (ii_canonical_account_id/instrument_id/ii_source_quality_status/ii_last_refreshed_at) are cleared on unpublish, not left stale on a source_type=manual row', async () => {
    const manual = seedManualInvestment(db, { userId, investmentName: 'Original Manual Name', currentValue: 500000 });
    const { positionId } = seedPosition(db, { userId, asOfDate: '2026-01-01', value: 520000, instrumentName: 'Imported Scheme Name', snapshotIdSuffix: 'v1' });
    const pub = await publishPosition(userId, positionId, { linkToExistingInvestmentId: manual.id as string });
    expect(pub.error).toBeNull();
    expect(db.investments.find((r) => r.id === manual.id)!.ii_canonical_account_id).not.toBeNull();

    await unpublishPosition(userId, pub.publicationId as string);
    const restored = db.investments.find((r) => r.id === manual.id)!;
    expect(restored.ii_canonical_account_id).toBeNull();
    expect(restored.ii_canonical_instrument_id).toBeNull();
    expect(restored.ii_source_quality_status).toBeNull();
    expect(restored.ii_last_refreshed_at).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // FIN-R3C-001..006 — core financial-integrity regression (no regression
  // from this narrow provenance fix).
  // ---------------------------------------------------------------------------
  it('FIN-R3C-001 manual 500,000 + imported 520,000 duplicate -> exactly one active value = 520,000', async () => {
    const manual = seedManualInvestment(db, { userId, investmentName: 'ABC Mutual Fund - Managed Funds', currentValue: 500000 });
    const { positionId } = seedPosition(db, { userId, asOfDate: '2026-01-01', value: 520000, instrumentName: 'ABC Mutual Fund', snapshotIdSuffix: 'v1' });
    const pub = await publishPosition(userId, positionId, { linkToExistingInvestmentId: manual.id as string });
    expect(pub.error).toBeNull();
    const activeInvestments = db.investments.filter((r) => r.is_active);
    expect(activeInvestments.length).toBe(1);
    expect(activeInvestments[0].current_value).toBe(520000);
  });

  it('FIN-R3C-002 idempotent publish retry -> no duplicate', async () => {
    const manual = seedManualInvestment(db, { userId, investmentName: 'ABC Mutual Fund', currentValue: 500000 });
    const { positionId } = seedPosition(db, { userId, asOfDate: '2026-01-01', value: 520000, instrumentName: 'ABC Mutual Fund', snapshotIdSuffix: 'v1' });
    await publishPosition(userId, positionId, { linkToExistingInvestmentId: manual.id as string });
    await publishPosition(userId, positionId, { linkToExistingInvestmentId: manual.id as string });
    expect(db.investments.filter((r) => r.is_active).length).toBe(1);
    expect(db.ii_fhip_publications.length).toBe(1);
  });

  it('FIN-R3C-003 refresh to 561,000 -> exactly one active value = 561,000', async () => {
    const manual = seedManualInvestment(db, { userId, investmentName: 'ABC Mutual Fund', currentValue: 500000 });
    const { positionId, accountId, instrumentId } = seedPosition(db, { userId, asOfDate: '2026-01-01', value: 520000, instrumentName: 'ABC Mutual Fund', snapshotIdSuffix: 'v1' });
    await publishPosition(userId, positionId, { linkToExistingInvestmentId: manual.id as string });
    db.ii_holding_snapshots.push({ id: `pos-${userId}-v2`, user_id: userId, account_id: accountId, instrument_id: instrumentId, as_of_date: '2026-02-01', value: 561000, currency_code: 'INR', quality_status: 'certified', created_at: new Date(Date.now() + 1000).toISOString() });
    const refresh = await refreshPosition(userId, `pos-${userId}-v2`);
    expect(refresh.error).toBeNull();
    const activeInvestments = db.investments.filter((r) => r.is_active);
    expect(activeInvestments.length).toBe(1);
    expect(activeInvestments[0].current_value).toBe(561000);
    expect(db.ii_fhip_publications.filter((r) => r.status === 'published').length).toBe(1);
  });

  it('FIN-R3C-004 an older snapshot after a newer active one is rejected', async () => {
    const manual = seedManualInvestment(db, { userId, investmentName: 'ABC Mutual Fund', currentValue: 500000 });
    const { positionId, accountId, instrumentId } = seedPosition(db, { userId, asOfDate: '2026-03-01', value: 561000, instrumentName: 'ABC Mutual Fund', snapshotIdSuffix: 'newer' });
    await publishPosition(userId, positionId, { linkToExistingInvestmentId: manual.id as string });
    db.ii_holding_snapshots.push({ id: `pos-${userId}-older`, user_id: userId, account_id: accountId, instrument_id: instrumentId, as_of_date: '2026-01-01', value: 520000, currency_code: 'INR', quality_status: 'certified', created_at: new Date(Date.now() - 100000).toISOString() });
    const refresh = await refreshPosition(userId, `pos-${userId}-older`);
    expect(refresh.decision).toBe('REJECT_OLDER');
    expect(db.investments.find((r) => r.id === manual.id)!.current_value).toBe(561000);
  });

  it('FIN-R3C-005 unpublish restores the original manual value', async () => {
    const manual = seedManualInvestment(db, { userId, investmentName: 'ABC Mutual Fund', currentValue: 500000 });
    const { positionId } = seedPosition(db, { userId, asOfDate: '2026-01-01', value: 520000, instrumentName: 'ABC Mutual Fund', snapshotIdSuffix: 'v1' });
    const pub = await publishPosition(userId, positionId, { linkToExistingInvestmentId: manual.id as string });
    await unpublishPosition(userId, pub.publicationId as string);
    expect(db.investments.find((r) => r.id === manual.id)!.current_value).toBe(500000);
    expect(db.investments.find((r) => r.id === manual.id)!.source_type).toBe('manual');
  });

  it('FIN-R3C-006 the financial-impact arithmetic is unaffected by the name-provenance fix', async () => {
    const manual = seedManualInvestment(db, { userId, investmentName: 'ABC Mutual Fund', currentValue: 500000 });
    const { positionId } = seedPosition(db, { userId, asOfDate: '2026-01-01', value: 520000, instrumentName: 'ABC Mutual Fund', snapshotIdSuffix: 'v1' });
    const pub = await publishPosition(userId, positionId, { linkToExistingInvestmentId: manual.id as string });
    expect(pub.financialImpact).toEqual({ currentIncludedValue: 500000, newPublishedValue: 520000, manualValueBeingSuperseded: 500000, netChange: 20000, currency: 'INR' });
  });
});
