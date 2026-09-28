// A household with zero `household_members` rows previously left Investment
// Intelligence's owner-matching with no "self" candidate at all -- found live
// in production 2026-09-28 (an onboarded, country-confirmed account with
// years of activity but zero household_members rows). ensureSelfHouseholdMember
// closes it the same way AU investment accounts already did (auAccountResolution.ts).

import { describe, it, expect, vi, beforeEach } from 'vitest';

interface FakeRow {
  id: string;
  user_id: string;
  full_name: string;
  relationship: string;
  is_active: boolean;
  created_at: string;
}

let members: FakeRow[];
let profiles: Record<string, { full_name: string | null }>;
let nextId = 1;

function makeAdmin() {
  return {
    from(table: string) {
      if (table === 'user_profiles') {
        return {
          select() {
            return {
              eq(_col: string, userId: string) {
                return { maybeSingle: async () => ({ data: profiles[userId] ?? null }) };
              },
            };
          },
        };
      }
      if (table === 'household_members') {
        return {
          select(_cols: string) {
            const filters: Record<string, unknown> = {};
            const builder = {
              eq(col: string, val: unknown) {
                filters[col] = val;
                return builder;
              },
              order() {
                return builder;
              },
              limit() {
                return builder;
              },
              maybeSingle: async () => {
                const row = members.find((m) => Object.entries(filters).every(([k, v]) => (m as never)[k] === v));
                return { data: row ? { id: row.id } : null };
              },
              then: (resolve: (v: { data: FakeRow[] }) => void) => {
                const rows = members.filter((m) => Object.entries(filters).every(([k, v]) => (m as never)[k] === v));
                resolve({ data: rows });
              },
            };
            return builder;
          },
          insert(row: Partial<FakeRow>) {
            return {
              select() {
                return {
                  single: async () => {
                    const created: FakeRow = {
                      id: `member-${nextId++}`,
                      user_id: row.user_id as string,
                      full_name: row.full_name as string,
                      relationship: row.relationship as string,
                      is_active: true,
                      created_at: new Date(2026, 0, nextId).toISOString(),
                    };
                    members.push(created);
                    return { data: { id: created.id }, error: null };
                  },
                };
              },
            };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => makeAdmin() }));

import { ensureSelfHouseholdMember } from '@/lib/services/household/ensureSelfMember';
import { loadHouseholdMembersForMatching } from '@/lib/aie/adapters/investment-intelligence/householdContext';

beforeEach(() => {
  members = [];
  profiles = {};
  nextId = 1;
});

describe('ensureSelfHouseholdMember', () => {
  it('creates a self member named from the profile when none exists', async () => {
    profiles['u1'] = { full_name: 'Dinesh Bhatia' };
    const { memberId, error } = await ensureSelfHouseholdMember('u1');
    expect(error).toBeNull();
    expect(memberId).toBeTruthy();
    const created = members.find((m) => m.id === memberId)!;
    expect(created.relationship).toBe('self');
    expect(created.full_name).toBe('Dinesh Bhatia');
  });

  it('falls back to "Me" when the profile has no name yet', async () => {
    profiles['u2'] = { full_name: null };
    const { memberId } = await ensureSelfHouseholdMember('u2');
    const created = members.find((m) => m.id === memberId)!;
    expect(created.full_name).toBe('Me');
  });

  it('is idempotent -- a second call returns the same existing self member, no duplicate', async () => {
    profiles['u3'] = { full_name: 'A' };
    const first = await ensureSelfHouseholdMember('u3');
    const second = await ensureSelfHouseholdMember('u3');
    expect(second.memberId).toBe(first.memberId);
    expect(members.filter((m) => m.user_id === 'u3' && m.relationship === 'self')).toHaveLength(1);
  });

  it('does not touch another user\'s household', async () => {
    profiles['u4'] = { full_name: 'A' };
    profiles['u5'] = { full_name: 'B' };
    const a = await ensureSelfHouseholdMember('u4');
    const b = await ensureSelfHouseholdMember('u5');
    expect(a.memberId).not.toBe(b.memberId);
  });
});

describe('loadHouseholdMembersForMatching (Investment Intelligence)', () => {
  it('the reproduced production gap: a household with zero rows now gets a self candidate', async () => {
    profiles['u6'] = { full_name: 'Dinesh Bhatia' };
    expect(members.filter((m) => m.user_id === 'u6')).toHaveLength(0);
    const loaded = await loadHouseholdMembersForMatching('u6');
    expect(loaded).toHaveLength(1);
    expect(loaded[0].relationship).toBe('self');
    expect(loaded[0].fullName).toBe('Dinesh Bhatia');
  });

  it('does not create a second self member when one already exists', async () => {
    profiles['u7'] = { full_name: 'A' };
    await ensureSelfHouseholdMember('u7');
    const loaded = await loadHouseholdMembersForMatching('u7');
    expect(loaded.filter((m) => m.relationship === 'self')).toHaveLength(1);
  });

  it('leaves existing non-self members intact alongside the ensured self member', async () => {
    profiles['u8'] = { full_name: 'A' };
    members.push({ id: 'spouse-1', user_id: 'u8', full_name: 'Priya', relationship: 'spouse', is_active: true, created_at: new Date(2020, 0, 1).toISOString() });
    const loaded = await loadHouseholdMembersForMatching('u8');
    expect(loaded).toHaveLength(2);
    expect(loaded.map((m) => m.relationship).sort()).toEqual(['self', 'spouse']);
  });
});
