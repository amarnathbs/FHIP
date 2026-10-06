// Migration 0276 (one ACTIVE self household member per user) and how the application answers its violation.
// The rule restricts ONLY self rows; household size is not limited (proved against real PostgreSQL by
// scripts/owner_before_upload_0276_self_unique_pglite_verification.mjs, 20 checks, which adds 9 and then 21 members).
//
// NAMED NEGATIVE CONTROLS
//   NC-U1  a unique violation on some OTHER index is not mistaken for the self rule;
//   NC-U2  the pack's read-only files contain no write statement and no editor hazard, and the lint bites on bad text;
//   NC-U3  the migration restricts only relationship = self AND is_active (a rule on any other relationship, or one that
//          counts inactive rows, fails the contract test).
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Row { id: string; user_id: string; relationship: string; is_active: boolean; created_at: string }
let rows: Row[];
let violateOnInsert: boolean;
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function admin() {
  return {
    from(table: string) {
      if (table === 'user_profiles') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { full_name: 'Test Person' } }) }) }) };
      return {
        select() {
          const f: Record<string, unknown> = {};
          const b: any = {
            eq(c: string, v: unknown) { f[c] = v; return b; },
            order() { return b; },
            limit() { return b; },
            maybeSingle: async () => { await tick(); const m = rows.filter((r) => Object.entries(f).every(([k, v]) => (r as any)[k] === v)).sort((a, c) => a.created_at.localeCompare(c.created_at))[0]; return { data: m ? { id: m.id } : null }; },
            then: (resolve: (v: { data: unknown[] }) => void) => { void tick().then(() => resolve({ data: rows.filter((r) => Object.entries(f).every(([k, v]) => (r as any)[k] === v)) })); },
          };
          return b;
        },
        insert() {
          return { select: () => ({ single: async () => {
            await tick();
            if (violateOnInsert) {
              // a racing caller inserted the self row between our look and our insert
              rows.push({ id: 'winner', user_id: 'u1', relationship: 'self', is_active: true, created_at: '2026-10-07T00:00:00Z' });
              return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "uq_household_members_one_active_self"' } };
            }
            return { data: { id: 'new' }, error: null };
          } }) };
        },
        delete() { const b: any = { eq() { return b; }, then: (r: (v: { error: null }) => void) => r({ error: null }) }; return b; },
      };
    },
  };
}
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => admin() }));
import { ensureSelfHouseholdMember } from '@/lib/services/household/ensureSelfMember';
import { isDuplicateSelfMemberError, SELF_UNIQUE_INDEX } from '@/lib/services/household/selfMemberUnique';

beforeEach(() => { rows = []; violateOnInsert = false; });

describe('recognising the self-member unique violation', () => {
  it('is the 23505 on the self index, and nothing else', () => {
    expect(isDuplicateSelfMemberError({ code: '23505', message: `duplicate key value violates unique constraint "${SELF_UNIQUE_INDEX}"` })).toBe(true);
    expect(isDuplicateSelfMemberError({ code: '23505', message: 'duplicate key value violates unique constraint "some_other_index"' })).toBe(false); // NC-U1
    expect(isDuplicateSelfMemberError({ code: '42501', message: SELF_UNIQUE_INDEX })).toBe(false);
    expect(isDuplicateSelfMemberError(null)).toBe(false);
  });
});

describe('ensureSelfHouseholdMember with the database rule in place', () => {
  it('a racing caller won the insert: the loser re-reads and returns the existing row, with no error', async () => {
    violateOnInsert = true;
    const r = await ensureSelfHouseholdMember('u1');
    expect(r).toEqual({ memberId: 'winner', error: null });
    expect(rows).toHaveLength(1);
  });
  it('a normal first call still creates the row', async () => {
    const r = await ensureSelfHouseholdMember('u1');
    expect(r.memberId).toBe('new');
  });
});

describe('the migration restricts only active self rows (household size is not limited)', () => {
  const sql = fs.readFileSync(path.resolve(__dirname, '..', '..', 'supabase', 'migrations', '0276_household_members_one_active_self.sql'), 'utf8');
  const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  it('the index is unique on user_id, partial on relationship = self and is_active, and nothing else is created', () => {
    expect(code).toMatch(/create unique index if not exists uq_household_members_one_active_self\s+on public\.household_members \(user_id\)\s+where relationship = 'self' and is_active;/);
    expect(code.match(/create (unique )?index/gi)).toHaveLength(1);
    expect(code).not.toMatch(/\b(delete|update|alter table|drop)\b/i); // it changes no row and no column
    expect(code).not.toMatch(/relationship\s+(in|<>|!=)/); // no other relationship is touched
  });
  it('NC-U3: the contract check bites on a rule that counts every relationship or inactive rows', () => {
    const tooWide = code.replace("where relationship = 'self' and is_active;", ';');
    expect(tooWide).not.toMatch(/where relationship = 'self' and is_active;/);
    const countsInactive = code.replace("and is_active;", ';');
    expect(countsInactive).not.toMatch(/and is_active;/);
  });
});

// ---- the hand-over pack ----
const PACK = path.resolve(__dirname, '..', '..', 'docs', 'ownership', 'po_apply_self_member_unique');
const read = (f: string) => fs.readFileSync(path.join(PACK, f), 'utf8');
function hazards(sql: string): string[] {
  const out: string[] = [];
  if (/[^\x00-\x7f]/.test(sql)) out.push('non-ascii');
  if (sql.includes('%')) out.push('percent sign');
  const words = /\b(into|from|join)\s+([A-Za-z_][A-Za-z0-9_.]*)/gi;
  let i = 0;
  while (i < sql.length) {
    if (sql.startsWith('--', i)) {
      let j = sql.indexOf('\n', i); if (j < 0) j = sql.length;
      const t = sql.slice(i, j);
      if (/[;"']/.test(t)) out.push(`comment has ; or a quote: ${t.slice(0, 40)}`);
      for (const m of t.matchAll(words)) out.push(`comment has "${m[0]}"`);
      i = j; continue;
    }
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length) { if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; } if (sql[j] === "'") break; j++; }
      const lit = sql.slice(i, j + 1);
      for (const m of lit.matchAll(words)) out.push(`string has "${m[0]}"`);
      i = j + 1; continue;
    }
    i++;
  }
  return out;
}

describe('hand-over pack po_apply_self_member_unique', () => {
  it('02 is byte-identical to the migration', () => {
    expect(read('02_apply_0276_one_active_self.sql')).toBe(fs.readFileSync(path.resolve(__dirname, '..', '..', 'supabase', 'migrations', '0276_household_members_one_active_self.sql'), 'utf8'));
  });
  for (const f of ['00_detect_duplicate_self_members.sql', '01_references_of_duplicate_rows.sql', '02_apply_0276_one_active_self.sql', '03_verify_index_and_household_sizes.sql']) {
    it(`${f} has no editor hazard (no into / from / join plus a word inside a comment or a string)`, () => {
      expect(hazards(read(f))).toEqual([]);
    });
  }
  for (const f of ['00_detect_duplicate_self_members.sql', '01_references_of_duplicate_rows.sql', '03_verify_index_and_household_sizes.sql']) {
    it(`${f} writes nothing`, () => {
      const code = read(f).split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
      expect(code).not.toMatch(/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke)\b/i);
    });
  }
  it('NC-U2: the lint bites', () => {
    expect(hazards('-- copies into the table\nselect 1')).not.toEqual([]);
    expect(hazards("select 'rows from the thing'")).not.toEqual([]);
    expect(hazards('-- fine\nselect 1')).toEqual([]);
  });
  it('the README states that household size is not limited', () => {
    expect(read('README.md')).toMatch(/does not limit the size of a household/i);
  });
});
