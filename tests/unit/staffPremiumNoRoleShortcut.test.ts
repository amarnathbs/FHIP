// Staff admin Premium (migration 0283) -- the GUARD TEST the PO decision depends on.
//
// DECISION (16-10-2026): staff accounts hold a REAL entitlement row. The consumer Premium checks must keep reading ONLY that row and
// must NOT gain an admin-role shortcut ("is this person an admin? then allow"). A shortcut would make Premium invisible and
// unauditable: it would not appear in user_entitlements, in Admin -> Premium Access, in the audit trail or in any report.
//
// This suite FAILS if any of these consumer guards, or any file that calls them, starts looking at an admin or Resources role, an
// admin table, the staff definition or the staff source value. Negative controls prove the detector sees a shortcut inserted into the
// real source files.

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectNamedFailure } from './support/promoTestHelpers';
import { effectivePlanTier } from '@/lib/services/entitlementWindow';
import { describePlanStatus } from '@/lib/services/entitlementPlanStatus';

// These tests walk the whole source tree; under a loaded machine (a full parallel run) the default 5 s is too short.
vi.setConfig({ testTimeout: 60_000 });

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cache = new Map<string, string>();
const read = (rel: string): string => {
  let v = cache.get(rel);
  if (v === undefined) {
    v = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    cache.set(rel, v);
  }
  return v;
};

/** Removes block and line comments (a comment may talk about admins; code may not act on them). Keeps string contents. */
export function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');
}

/** Tokens that mean "decide Premium from who the person is". None may appear in code of a consumer guard. */
export const ROLE_SHORTCUT_TOKENS = [
  'admin_users',
  'resource_user_roles',
  'requireAdmin',
  'requireSuperAdmin',
  'requireResourceAdminAccess',
  'isSuperAdmin',
  'isAdmin',
  'hasAdminAccess',
  'hasResourcesAccess',
  'getCurrentResourceRoles',
  'isResourceStaff',
  'canManageResources',
  'is_fhip_super_admin',
  'is_staff_premium_account',
  'staff_admin',
  'STAFF_PREMIUM',
  'staffPremium',
  'StaffPremium',
  'can_manage_premium_entitlements',
];

export function roleShortcutsIn(src: string): string[] {
  const code = codeOnly(src);
  return ROLE_SHORTCUT_TOKENS.filter((t) => new RegExp(`\\b${t}\\b`).test(code) || (t.endsWith('_') && code.includes(t)));
}

/** The consumer Premium decision points themselves. */
const CORE_GUARDS = [
  'lib/entitlements/financialDataImport.ts',
  'lib/entitlements/financialDataImportContract.ts',
  'lib/ai/access/premiumAiAccess.ts',
  'lib/services/entitlementWindow.ts',
  'lib/services/entitlements.ts',
  'lib/ai/entitlement/aiEntitlementService.ts',
  'lib/ai/entitlement/capabilities.ts',
];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.next') continue;
      walk(rel, out);
    } else if (/\.(ts|tsx)$/.test(e.name)) out.push(rel);
  }
  return out;
}

/** Every file that calls a consumer guard or reads a plan tier. */
const GUARD_CALL = /resolveFinancialImportAccess|refuseUnlessFinancialImportAllowed|assertFinancialImportAllowed|refuseUnlessImportRunMayStart|financialImportAccessView|resolvePremiumAiAccess|refuseUnlessPremiumAi|\beffectivePlanTier\b|\bgetPlanTier\b|\bcanExportReports\b|\bcanViewPremiumReport\b/;

describe('the consumer Premium guards read ONLY the entitlement row', () => {
  for (const f of CORE_GUARDS) {
    it(`${f}: no admin or role reference in code`, () => {
      expect(fs.existsSync(path.join(ROOT, f)), `${f} exists`).toBe(true);
      expect(roleShortcutsIn(read(f))).toEqual([]);
    });
  }

  it('every file that CALLS a consumer guard is free of role shortcuts too (no "admin bypass" next to the check)', () => {
    // financialImportInventory.ts is the CI inventory of which routes are exempt (it NAMES the admin guard to describe them, it decides
    // nothing); entitlementPlanStatus.ts only chooses the label the person reads: its tier still comes from effectivePlanTier, which
    // the next test pins (a staff source on a non-Premium row confers nothing).
    const NOT_A_DECISION = ['lib/entitlements/financialImportInventory.ts', 'lib/services/entitlementPlanStatus.ts'];
    const callers = [...walk('app'), ...walk('lib'), ...walk('components')].filter(
      (f) => GUARD_CALL.test(codeOnly(read(f))) && !CORE_GUARDS.includes(f) && !NOT_A_DECISION.includes(f)
    );
    expect(callers.length, 'the scan sees the guard callers').toBeGreaterThan(20);
    const offenders = callers.map((f) => ({ f, hits: roleShortcutsIn(read(f)) })).filter((x) => x.hits.length > 0);
    expect(offenders).toEqual([]);
  });

  it('a staff SOURCE confers nothing by itself: the tier the person is acted on with comes only from plan_tier and the window', () => {
    const today = '2026-10-16';
    expect(effectivePlanTier({ plan_tier: 'free', effective_from: today, effective_to: null, entitlement_source: 'staff_admin' } as never, today)).toBe('free');
    expect(describePlanStatus({ plan_tier: 'free', entitlement_source: 'staff_admin' }, today).planTier).toBe('free');
    expect(describePlanStatus({ plan_tier: 'premium', entitlement_source: 'staff_admin', effective_from: '2026-10-01', effective_to: null }, today).planTier).toBe('premium');
    // a row that is not yet in force is Free whatever its source says
    expect(describePlanStatus({ plan_tier: 'premium', entitlement_source: 'staff_admin', effective_from: '2026-11-01', effective_to: null }, today).planTier).toBe('free');
  });

  it('the SQL Premium functions (ai_entitlement_state, ai_admit_request) never look at a role table or the staff source', () => {
    const files = fs.readdirSync(path.join(ROOT, 'supabase', 'migrations')).filter((f) => f.endsWith('.sql')).sort();
    for (const name of ['ai_entitlement_state', 'ai_admit_request']) {
      let latest = '';
      for (const f of files) {
        const sql = read(`supabase/migrations/${f}`);
        const m = sql.match(new RegExp(`create or replace function (?:public\\.)?${name}\\s*\\([\\s\\S]*?\\n(?:\\$\\$|\\$fn\\$|\\$body\\$)\\s*;`, 'i'));
        if (m) latest = m[0];
      }
      expect(latest.length, `found a definition of ${name}`).toBeGreaterThan(200);
      const code = latest.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
      expect(code, name).not.toMatch(/admin_users|resource_user_roles|is_fhip_super_admin|is_staff_premium_account|staff_admin/);
    }
  });

  it('where the staff entitlement IS referenced in application code, it is only presentation, admin screens or the redeem courtesy check', () => {
    const referencing = [...walk('app'), ...walk('lib'), ...walk('components')].filter((f) => /\bstaff_admin\b|STAFF_PREMIUM|staffPremium/.test(codeOnly(read(f))));
    const allowed = [
      'lib/services/staffPremium.ts',
      'lib/services/entitlementPlanStatus.ts', // the label the person sees
      'lib/services/premiumGrantAdmin.ts', // admin screen: tells staff from paid when a grant is refused
      'app/api/payments/status/route.ts', // reports the source for the billing page
      'app/api/payments/promo/redeem/route.ts', // courtesy answer before a code is consumed (the database refuses anyway)
      'app/api/admin/ai/entitlements/route.ts', // head-count split
      'app/api/admin/entitlements/grants/route.ts',
      'app/api/admin/entitlements/staff/route.ts',
      'components/admin/PremiumEntitlementsClient.tsx',
      'components/profile/BillingPanel.tsx',
    ];
    expect(referencing.filter((f) => !allowed.includes(f))).toEqual([]);
    // none of the references decides access: the access guards are all outside this list
    expect(referencing.filter((f) => CORE_GUARDS.includes(f))).toEqual([]);
  });
});

describe('NEGATIVE CONTROLS -- the detector really sees a shortcut', () => {
  it('a shortcut inserted into the REAL premiumAiAccess source is flagged (assertion "no role shortcut in code" goes red)', async () => {
    const real = read('lib/ai/access/premiumAiAccess.ts');
    expect(roleShortcutsIn(real)).toEqual([]);
    const broken = real.replace(
      "if (typeof userId !== 'string' || userId.trim().length === 0) return deny('entitlement_unavailable', capability);",
      "if (typeof userId !== 'string' || userId.trim().length === 0) return deny('entitlement_unavailable', capability);\n  if (await isSuperAdmin(userId)) return { allowed: true, planTier: 'premium' };"
    );
    expect(broken).not.toBe(real);
    await expectNamedFailure(() => expect(roleShortcutsIn(broken), 'no role shortcut in code').toEqual([]), 'no role shortcut in code');
  });

  it('a shortcut inserted into the REAL financial import guard is flagged', async () => {
    const real = read('lib/entitlements/financialDataImport.ts');
    const broken = real.replace(
      "const row = read.row;",
      "const row = read.row;\n  const staff = await supabase.from('admin_users').select('user_id');"
    );
    expect(broken).not.toBe(real);
    await expectNamedFailure(() => expect(roleShortcutsIn(broken), 'no role shortcut in code').toEqual([]), 'no role shortcut in code');
  });

  it('a shortcut in effectivePlanTier (the window predicate every reader shares) is flagged', async () => {
    const real = read('lib/services/entitlementWindow.ts');
    const broken = real.replace("if (!row || row.plan_tier !== 'premium') return 'free';", "if (row && (row as { entitlement_source?: string }).entitlement_source === 'staff_admin') return 'premium';\n  if (!row || row.plan_tier !== 'premium') return 'free';");
    expect(broken).not.toBe(real);
    await expectNamedFailure(() => expect(roleShortcutsIn(broken), 'no role shortcut in code').toEqual([]), 'no role shortcut in code');
  });

  it('a mention in a COMMENT is not a shortcut, but the same token in code is (the stripper does not hide code)', () => {
    expect(roleShortcutsIn('// isSuperAdmin is never used here\n/* admin_users too */\nconst a = 1;')).toEqual([]);
    expect(roleShortcutsIn('const a = 1; // fine\nif (isSuperAdmin) return true;')).toEqual(['isSuperAdmin']);
    expect(roleShortcutsIn("const url = 'https://x.test'; const q = from('admin_users');")).toEqual(['admin_users']);
  });
});
