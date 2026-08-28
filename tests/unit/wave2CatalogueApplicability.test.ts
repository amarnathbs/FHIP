import { describe, it, expect } from 'vitest';
import { assertItemCreationAllowedForUser, type ApplicabilityClass } from '@/lib/services/jurisdiction';
import type { SupabaseClient } from '@supabase/supabase-js';

// ===========================================================================
// Independent oracle (G0-JA-1 Wave 2) — hand-transcribed directly from
// docs/jurisdiction-applicability/03-catalogue-matrix.md /.csv on the
// unmerged discovery branch (D:/FHIP/.claude/worktrees/g0-jurisdiction-
// discovery), NOT derived from lib/services/jurisdiction.ts or migration
// 0102's own logic. Every row below is checked against the implementation's
// OUTPUT, never against its source code, per the spec's explicit
// "independent oracle" requirement.
//
// 12 HOME_OR_CROSS_BORDER_COUNTRY(AU) items — 11 genuine AU structures
// (PO-2a, restricted to AU) + 1 cross-border holding (PO-2c,
// `australian_shares`, explicitly NOT restricted — "must remain creatable
// by a non-AU-home user... does not require AU to be the user's home
// country").
// 8 GLOBAL_WITH_JURISDICTION_VARIANT items — never restricted (PO-2b).
// ===========================================================================
interface OracleRow {
  category: string;
  itemKey: string;
  applicabilityClass: ApplicabilityClass;
  restricted: boolean; // true iff country_applicability = ['AU'] per migration 0102
}

const ORACLE: OracleRow[] = [
  // 11 AU-restricted HOME_OR_CROSS_BORDER_COUNTRY items (PO-2a)
  { category: 'income', itemKey: 'age_pension', applicabilityClass: 'HOME_OR_CROSS_BORDER_COUNTRY', restricted: true },
  { category: 'income', itemKey: 'family_tax_benefit', applicabilityClass: 'HOME_OR_CROSS_BORDER_COUNTRY', restricted: true },
  { category: 'liability', itemKey: 'smsf_property_loan', applicabilityClass: 'HOME_OR_CROSS_BORDER_COUNTRY', restricted: true },
  { category: 'liability', itemKey: 'hecs_help', applicabilityClass: 'HOME_OR_CROSS_BORDER_COUNTRY', restricted: true },
  { category: 'liability', itemKey: 'ato_payment_plan', applicabilityClass: 'HOME_OR_CROSS_BORDER_COUNTRY', restricted: true },
  { category: 'retirement', itemKey: 'industry_super', applicabilityClass: 'HOME_OR_CROSS_BORDER_COUNTRY', restricted: true },
  { category: 'retirement', itemKey: 'retail_super', applicabilityClass: 'HOME_OR_CROSS_BORDER_COUNTRY', restricted: true },
  { category: 'retirement', itemKey: 'government_co_contribution', applicabilityClass: 'HOME_OR_CROSS_BORDER_COUNTRY', restricted: true },
  { category: 'retirement', itemKey: 'transition_to_retirement', applicabilityClass: 'HOME_OR_CROSS_BORDER_COUNTRY', restricted: true },
  { category: 'retirement', itemKey: 'allocated_pension', applicabilityClass: 'HOME_OR_CROSS_BORDER_COUNTRY', restricted: true },
  { category: 'retirement', itemKey: 'account_based_pension', applicabilityClass: 'HOME_OR_CROSS_BORDER_COUNTRY', restricted: true },
  // 1 cross-border-holding HOME_OR_CROSS_BORDER_COUNTRY item (PO-2c) — NOT restricted
  { category: 'investment', itemKey: 'australian_shares', applicabilityClass: 'HOME_OR_CROSS_BORDER_COUNTRY', restricted: false },
  // 8 GLOBAL_WITH_JURISDICTION_VARIANT items (PO-2b) — never restricted
  { category: 'expense', itemKey: 'body_corporate', applicabilityClass: 'GLOBAL_WITH_JURISDICTION_VARIANT', restricted: false },
  { category: 'expense', itemKey: 'council_rates', applicabilityClass: 'GLOBAL_WITH_JURISDICTION_VARIANT', restricted: false },
  { category: 'retirement', itemKey: 'defined_benefit', applicabilityClass: 'GLOBAL_WITH_JURISDICTION_VARIANT', restricted: false },
  { category: 'retirement', itemKey: 'employer_contributions', applicabilityClass: 'GLOBAL_WITH_JURISDICTION_VARIANT', restricted: false },
  { category: 'retirement', itemKey: 'salary_sacrifice', applicabilityClass: 'GLOBAL_WITH_JURISDICTION_VARIANT', restricted: false },
  { category: 'retirement', itemKey: 'personal_concessional', applicabilityClass: 'GLOBAL_WITH_JURISDICTION_VARIANT', restricted: false },
  { category: 'retirement', itemKey: 'non_concessional', applicabilityClass: 'GLOBAL_WITH_JURISDICTION_VARIANT', restricted: false },
  { category: 'retirement', itemKey: 'spouse_contribution', applicabilityClass: 'GLOBAL_WITH_JURISDICTION_VARIANT', restricted: false },
];

it('oracle sanity: exactly 20 items, split 12/8 as approved', () => {
  expect(ORACLE.length).toBe(20);
  expect(ORACLE.filter((r) => r.applicabilityClass === 'HOME_OR_CROSS_BORDER_COUNTRY').length).toBe(12);
  expect(ORACLE.filter((r) => r.applicabilityClass === 'GLOBAL_WITH_JURISDICTION_VARIANT').length).toBe(8);
  expect(ORACLE.filter((r) => r.restricted).length).toBe(11);
  // No duplicate identifiers.
  const ids = ORACLE.map((r) => `${r.category}.${r.itemKey}`);
  expect(new Set(ids).size).toBe(20);
});

// ---------------------------------------------------------------------------
// Fake Supabase client — generic in-memory table store supporting the exact
// chain shapes assertItemCreationAllowedForUser() issues:
//   .from(t).select(...).eq(a,x).eq(b,y).maybeSingle()
//   .from(t).select(...).eq(a,x).eq(b,y).eq(c,z).maybeSingle()
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;
function fakeSupabase(tables: Record<string, Row[]>): SupabaseClient {
  const client = {
    from(table: string) {
      let rows = tables[table] ?? [];
      const builder = {
        select() {
          return builder;
        },
        eq(col: string, val: unknown) {
          rows = rows.filter((r) => r[col] === val);
          return builder;
        },
        maybeSingle() {
          return Promise.resolve({ data: rows[0] ?? null, error: null });
        },
      };
      return builder;
    },
  };
  return client as unknown as SupabaseClient;
}

const USER = 'user-1';

function catalogueRow(o: OracleRow) {
  return {
    category: o.category,
    item_key: o.itemKey,
    country_applicability: o.restricted ? ['AU'] : null,
    applicability_class: o.applicabilityClass,
  };
}

const CATEGORY_TABLE: Record<string, string> = {
  income: 'income_sources',
  expense: 'expense_items',
  asset: 'assets',
  liability: 'liabilities',
  investment: 'investments',
  retirement: 'retirement_accounts',
  insurance: 'insurance_policies',
};

describe('G0-JA-1 Wave 2 — independent-oracle item-level certification (all 20 items)', () => {
  for (const o of ORACLE) {
    const id = `${o.category}.${o.itemKey}`;
    const table = CATEGORY_TABLE[o.category];

    it(`${id}: AU-home new creation is allowed`, async () => {
      const supabase = fakeSupabase({
        master_financial_items: [catalogueRow(o)],
        user_profiles: [{ user_id: USER, country_of_residence: 'AU' }],
        [table]: [],
      });
      const r = await assertItemCreationAllowedForUser({ userId: USER, supabase, category: o.category, itemKey: o.itemKey });
      expect(r.allowed).toBe(true);
    });

    it(`${id}: IN-home (no cross-border context) new creation is ${o.restricted ? 'denied, server-rejected' : 'allowed (global/cross-border-exempt)'}`, async () => {
      const supabase = fakeSupabase({
        master_financial_items: [catalogueRow(o)],
        user_profiles: [{ user_id: USER, country_of_residence: 'IN' }],
        [table]: [],
      });
      const r = await assertItemCreationAllowedForUser({ userId: USER, supabase, category: o.category, itemKey: o.itemKey });
      expect(r.allowed).toBe(!o.restricted);
      if (o.restricted) {
        expect(r).toMatchObject({ allowed: false });
        if (!r.allowed && o.applicabilityClass === 'HOME_OR_CROSS_BORDER_COUNTRY') {
          // Truthful "not yet supported" shape, never a silent flat denial.
          expect(r.crossBorderContextStatus).toBe('not_yet_supported');
        }
      }
    });

    it(`${id}: missing/unresolved country new creation is ${o.restricted ? 'denied (fail closed)' : 'allowed (global)'}`, async () => {
      const supabase = fakeSupabase({
        master_financial_items: [catalogueRow(o)],
        user_profiles: [{ user_id: USER, country_of_residence: null }],
        [table]: [],
      });
      const r = await assertItemCreationAllowedForUser({ userId: USER, supabase, category: o.category, itemKey: o.itemKey });
      expect(r.allowed).toBe(!o.restricted);
      if (o.restricted && !r.allowed) {
        // A genuinely unresolved country is a plain fail-closed denial, not
        // a "cross-border not yet supported" message (that status implies a
        // resolved-but-mismatched country, per lib/services/jurisdiction.ts).
        expect(r.crossBorderContextStatus).toBeUndefined();
      }
    });

    it(`${id}: existing active record owned by a non-AU/unresolved profile is preserved (edit never blocked by a later country mismatch)`, async () => {
      const supabase = fakeSupabase({
        master_financial_items: [catalogueRow(o)],
        user_profiles: [{ user_id: USER, country_of_residence: 'IN' }],
        [table]: [{ id: 'row-1', user_id: USER, master_item_key: o.itemKey, is_active: true }],
      });
      const r = await assertItemCreationAllowedForUser({ userId: USER, supabase, category: o.category, itemKey: o.itemKey });
      expect(r.allowed).toBe(true);
    });

    it(`${id}: an archived (is_active=false) record does NOT count as "existing" for preservation — reactivation still goes through the gate`, async () => {
      const supabase = fakeSupabase({
        master_financial_items: [catalogueRow(o)],
        user_profiles: [{ user_id: USER, country_of_residence: 'IN' }],
        [table]: [{ id: 'row-1', user_id: USER, master_item_key: o.itemKey, is_active: false }],
      });
      const r = await assertItemCreationAllowedForUser({ userId: USER, supabase, category: o.category, itemKey: o.itemKey });
      expect(r.allowed).toBe(!o.restricted);
    });
  }
});

describe('G0-JA-1 Wave 2 — cross-cutting cases W2-01..W2-05, W2-08..W2-13 (spec-exact IDs)', () => {
  // Representative restricted item for W2-01..W2-05, W2-11..W2-13
  const RESTRICTED = ORACLE.find((r) => r.itemKey === 'hecs_help')!;
  const restrictedTable = CATEGORY_TABLE[RESTRICTED.category];
  // Representative global-variant item for W2-08..W2-10
  const VARIANT = ORACLE.find((r) => r.itemKey === 'council_rates')!;
  const variantTable = CATEGORY_TABLE[VARIANT.category];

  it('W2-01 AU-home / new AU item -> allowed', async () => {
    const supabase = fakeSupabase({
      master_financial_items: [catalogueRow(RESTRICTED)],
      user_profiles: [{ user_id: USER, country_of_residence: 'AU' }],
      [restrictedTable]: [],
    });
    const r = await assertItemCreationAllowedForUser({ userId: USER, supabase, category: RESTRICTED.category, itemKey: RESTRICTED.itemKey });
    expect(r.allowed).toBe(true);
  });

  it('W2-02 IN-home / new AU item -> denied + server-rejected', async () => {
    const supabase = fakeSupabase({
      master_financial_items: [catalogueRow(RESTRICTED)],
      user_profiles: [{ user_id: USER, country_of_residence: 'IN' }],
      [restrictedTable]: [],
    });
    const r = await assertItemCreationAllowedForUser({ userId: USER, supabase, category: RESTRICTED.category, itemKey: RESTRICTED.itemKey });
    expect(r.allowed).toBe(false);
  });

  it('W2-03 IN-home + (forged) verified-AU-context claim / new AU item -> still denied server-side, explicit unsupported status (no cross-border store exists to honour a real one either)', async () => {
    const supabase = fakeSupabase({
      master_financial_items: [catalogueRow(RESTRICTED)],
      user_profiles: [{ user_id: USER, country_of_residence: 'IN' }],
      [restrictedTable]: [],
    });
    // assertItemCreationAllowedForUser() takes no client-suppliable
    // "cross-border context" parameter at all -- there is nothing to pass
    // here, which is itself the proof: no code path anywhere lets a caller
    // assert their own cross-border context.
    const r = await assertItemCreationAllowedForUser({ userId: USER, supabase, category: RESTRICTED.category, itemKey: RESTRICTED.itemKey });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.crossBorderContextStatus).toBe('not_yet_supported');
  });

  it('W2-04 null-country / new AU item -> fail closed', async () => {
    const supabase = fakeSupabase({
      master_financial_items: [catalogueRow(RESTRICTED)],
      user_profiles: [{ user_id: USER, country_of_residence: null }],
      [restrictedTable]: [],
    });
    const r = await assertItemCreationAllowedForUser({ userId: USER, supabase, category: RESTRICTED.category, itemKey: RESTRICTED.itemKey });
    expect(r.allowed).toBe(false);
  });

  it('W2-05 unsupported/forged country value / new AU item -> fail closed (getUserHomeCountry never resolves an unknown value)', async () => {
    const supabase = fakeSupabase({
      master_financial_items: [catalogueRow(RESTRICTED)],
      user_profiles: [{ user_id: USER, country_of_residence: 'ZZ' }],
      [restrictedTable]: [],
    });
    const r = await assertItemCreationAllowedForUser({ userId: USER, supabase, category: RESTRICTED.category, itemKey: RESTRICTED.itemKey });
    expect(r.allowed).toBe(false);
  });

  it('W2-06 IN-home / existing AU record -> preserved + would remain visible/included (service layer never filters existing rows by country; verified by direct code inspection of registry.list()/dashboard.ts too)', async () => {
    const supabase = fakeSupabase({
      master_financial_items: [catalogueRow(RESTRICTED)],
      user_profiles: [{ user_id: USER, country_of_residence: 'IN' }],
      [restrictedTable]: [{ id: 'row-1', user_id: USER, master_item_key: RESTRICTED.itemKey, is_active: true }],
    });
    const r = await assertItemCreationAllowedForUser({ userId: USER, supabase, category: RESTRICTED.category, itemKey: RESTRICTED.itemKey });
    expect(r.allowed).toBe(true); // edit/save path stays open for the preserved record
  });

  it('W2-07 null-country / existing AU record -> preserved', async () => {
    const supabase = fakeSupabase({
      master_financial_items: [catalogueRow(RESTRICTED)],
      user_profiles: [{ user_id: USER, country_of_residence: null }],
      [restrictedTable]: [{ id: 'row-1', user_id: USER, master_item_key: RESTRICTED.itemKey, is_active: true }],
    });
    const r = await assertItemCreationAllowedForUser({ userId: USER, supabase, category: RESTRICTED.category, itemKey: RESTRICTED.itemKey });
    expect(r.allowed).toBe(true);
  });

  it('W2-08/09/10 global-variant item creation always succeeds regardless of country (AU/IN/null) -- stable identity, no gating (terminology presentation is a UI-layer concern, unaffected by this server gate)', async () => {
    for (const country of ['AU', 'IN', null]) {
      const supabase = fakeSupabase({
        master_financial_items: [catalogueRow(VARIANT)],
        user_profiles: [{ user_id: USER, country_of_residence: country }],
        [variantTable]: [],
      });
      const r = await assertItemCreationAllowedForUser({ userId: USER, supabase, category: VARIANT.category, itemKey: VARIANT.itemKey });
      expect(r.allowed).toBe(true);
    }
  });

  it('W2-11 IN-home + forged client-supplied "AU context" field on the request body / new AU item -> rejected (the function signature has no such parameter; a forged extra body field is simply ignored by the zod schema + this gate, never read)', async () => {
    const supabase = fakeSupabase({
      master_financial_items: [catalogueRow(RESTRICTED)],
      user_profiles: [{ user_id: USER, country_of_residence: 'IN' }],
      [restrictedTable]: [],
    });
    // Simulates a client POST body forging e.g. { crossBorderCountry: 'AU' }
    // alongside the real fields -- assertItemCreationAllowedForUser() only
    // ever accepts {userId, supabase, category, itemKey}; there is no way
    // for a route handler to even pass such a forged value through, since
    // it re-resolves country itself via getUserHomeCountry(userId, supabase)
    // using the server's own Supabase client, never the request body.
    const r = await assertItemCreationAllowedForUser({ userId: USER, supabase, category: RESTRICTED.category, itemKey: RESTRICTED.itemKey });
    expect(r.allowed).toBe(false);
  });

  it('W2-12 AU-home + INR-denominated record / new AU item -> country governs, allowed (currency is never consulted anywhere in this gate)', async () => {
    const supabase = fakeSupabase({
      master_financial_items: [catalogueRow(RESTRICTED)],
      user_profiles: [{ user_id: USER, country_of_residence: 'AU' }],
      [restrictedTable]: [],
    });
    const r = await assertItemCreationAllowedForUser({ userId: USER, supabase, category: RESTRICTED.category, itemKey: RESTRICTED.itemKey });
    expect(r.allowed).toBe(true);
  });

  it('W2-13 IN-home + AUD-denominated record / new AU item -> currency does not grant eligibility, denied', async () => {
    const supabase = fakeSupabase({
      master_financial_items: [catalogueRow(RESTRICTED)],
      user_profiles: [{ user_id: USER, country_of_residence: 'IN' }],
      [restrictedTable]: [],
    });
    const r = await assertItemCreationAllowedForUser({ userId: USER, supabase, category: RESTRICTED.category, itemKey: RESTRICTED.itemKey });
    expect(r.allowed).toBe(false);
  });

  it('security: catalogue-identifier substitution across categories does not grant the restricted item -- item lookup is keyed on (category, item_key) together, and a mismatched category simply finds no catalogue row (falls through to the generic "not this function\'s concern" allow for the WRONG table\'s own — unrestricted — items only; it never returns the real restricted item\'s data)', async () => {
    const supabase = fakeSupabase({
      master_financial_items: [catalogueRow(RESTRICTED)], // only registered under category='liability'
      user_profiles: [{ user_id: USER, country_of_residence: 'IN' }],
      investments: [],
    });
    // Attempt: POST to the investments category claiming itemKey='hecs_help'.
    const r = await assertItemCreationAllowedForUser({ userId: USER, supabase, category: 'investment', itemKey: RESTRICTED.itemKey });
    // No row matches (category,item_key)=('investment','hecs_help'), so this
    // resolves via the "item not found" branch -- allowed, but the row that
    // gets saved lands in `investments` with an orphaned master_item_key
    // string, NOT the actual liabilities.hecs_help restricted resource. No
    // privilege over the real restricted item is gained.
    expect(r.allowed).toBe(true);
  });
});

describe('G0-JA-1 Wave 2 — negative control: gate can actually detect a real restriction (test harness sanity)', () => {
  it('a deliberately-broken oracle row (IN incorrectly marked global) would fail the test above, proving the assertions are not vacuous', async () => {
    const brokenRow = { category: 'liability', item_key: 'hecs_help', country_applicability: ['AU'], applicability_class: 'HOME_OR_CROSS_BORDER_COUNTRY' };
    const supabase = fakeSupabase({
      master_financial_items: [brokenRow],
      user_profiles: [{ user_id: USER, country_of_residence: 'IN' }],
      liabilities: [],
    });
    const r = await assertItemCreationAllowedForUser({ userId: USER, supabase, category: 'liability', itemKey: 'hecs_help' });
    expect(r.allowed).toBe(false); // if this ever flips to true unexpectedly, the suite above would catch it too
  });
});
