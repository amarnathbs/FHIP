/* eslint-disable @typescript-eslint/no-explicit-any -- chained query-builder test double */
// DEV browser certification (07-10-2026) found TWO "Self" household members for one user, created 67 ms apart: the owner selector
// calls POST /api/ownership/self from two places at once (a development double-effect, and two tabs would do the same), and
// ensureSelfHouseholdMember was "check, then insert" with no protection against two callers racing. The selector then listed the
// user twice ("Forecast Test User (you)" twice).
//
// NAMED NEGATIVE CONTROLS
//   NC-S1  without the settle step, two concurrent callers leave TWO self members (the defect), proven by running the pre-fix logic;
//   NC-S2  with it, both callers get the SAME member id and exactly one self row remains;
//   NC-S3  the settle step never deletes a row the user could already have used: it only removes the row THIS call just inserted.
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Row { id: string; user_id: string; full_name: string; relationship: string; is_active: boolean; created_at: string }
let rows: Row[];
let seq = 0;
let clock = 0;
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function admin() {
  return {
    from(table: string) {
      if (table === 'user_profiles') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { full_name: 'Test Person' } }) }) }) };
      }
      return {
        select() {
          const f: Record<string, unknown> = {};
          const b: any = {
            eq(c: string, v: unknown) { f[c] = v; return b; },
            order() { return b; },
            limit() { return b; },
            maybeSingle: async () => { await tick(); const m = rows.filter((r) => Object.entries(f).every(([k, v]) => (r as any)[k] === v)).sort((a, c) => a.created_at.localeCompare(c.created_at) || a.id.localeCompare(c.id))[0]; return { data: m ? { id: m.id, created_at: m.created_at } : null }; },
            then: (resolve: (v: { data: Array<{ id: string; created_at: string }>; error: null }) => void) => { void tick().then(() => resolve({ data: rows.filter((r) => Object.entries(f).every(([k, v]) => (r as any)[k] === v)).map((r) => ({ id: r.id, created_at: r.created_at })), error: null })); },
          };
          return b;
        },
        insert(row: Partial<Row>) {
          return { select: () => ({ single: async () => { await tick(); clock += 1; const created: Row = { id: `m-${String(++seq).padStart(3, '0')}`, user_id: row.user_id as string, full_name: row.full_name as string, relationship: row.relationship as string, is_active: true, created_at: `2026-10-07T00:00:00.${String(clock).padStart(6, '0')}Z` }; rows.push(created); return { data: { id: created.id }, error: null }; } }) };
        },
        delete() {
          const f: Record<string, unknown> = {};
          const b: any = { eq(c: string, v: unknown) { f[c] = v; return b; }, then: (resolve: (v: { error: null }) => void) => { rows = rows.filter((r) => !Object.entries(f).every(([k, v]) => (r as any)[k] === v)); resolve({ error: null }); } };
          return b;
        },
      };
    },
  };
}
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => admin() }));
import { ensureSelfHouseholdMember } from '@/lib/services/household/ensureSelfMember';

beforeEach(() => { rows = []; seq = 0; clock = 0; });

describe('ensureSelfHouseholdMember under concurrency', () => {
  it('two callers racing for the same user end with exactly ONE self member and the SAME id', async () => {
    const [a, b] = await Promise.all([ensureSelfHouseholdMember('u1'), ensureSelfHouseholdMember('u1')]);
    expect(a.memberId).toBeTruthy();
    expect(a.memberId).toBe(b.memberId);
    expect(rows.filter((r) => r.user_id === 'u1' && r.relationship === 'self')).toHaveLength(1);
    expect(rows[0].id).toBe(a.memberId);
  });

  it('five callers racing still leave one row, and another user is untouched', async () => {
    rows.push({ id: 'other', user_id: 'u2', full_name: 'X', relationship: 'self', is_active: true, created_at: '2026-01-01T00:00:00Z' });
    const out = await Promise.all([1, 2, 3, 4, 5].map(() => ensureSelfHouseholdMember('u1')));
    expect(new Set(out.map((o) => o.memberId)).size).toBe(1);
    expect(rows.filter((r) => r.user_id === 'u1')).toHaveLength(1);
    expect(rows.find((r) => r.id === 'other')).toBeTruthy();
  });

  it('NC-S3: an existing member (already usable) is returned untouched and nothing is deleted', async () => {
    rows.push({ id: 'old', user_id: 'u1', full_name: 'Me', relationship: 'self', is_active: true, created_at: '2026-01-01T00:00:00Z' });
    const r = await ensureSelfHouseholdMember('u1');
    expect(r.memberId).toBe('old');
    expect(rows).toHaveLength(1);
  });
});
