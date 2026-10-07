// Source-contract tests for the hardening mission (items 4, 10, 12 and the "capabilities are not implied" requirement).
//
// There is no DOM environment, so these read the SOURCE of the screens, routes, predicates and configuration files and fail on:
//   * a capability that is implied by another capability, by Super Admin, or by admin_users membership (code, navigation, /api/admin/me,
//     every route guard and every SQL predicate);
//   * a secret read through a fallback chain, logged, or forwarded under a name that is not documented;
//   * a promo or reminder job that ships switched on, or a cron registration that is not behind the production marker;
//   * an Admin screen that lost a label, the shared status component, the day-first date helpers or its responsive wrapper.
//
// NAMED NEGATIVE CONTROLS
//   NC-C1  a predicate rewritten to also accept any admin_users row is flagged: "a predicate reads only its own column";
//   NC-C2  a /api/admin/me line that ORs Super Admin into a capability is flagged: "no capability is derived from Super Admin";
//   NC-F1  a secret reader with a fallback chain is flagged: "no fallback between secrets";
//   NC-U1  a screen without the shared status component is flagged: "the screen uses the shared status component".

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { MIG_DIR, REPO_ROOT, expectNamedFailure } from './support/promoTestHelpers';
import { NO_ADMIN_CAPABILITIES, buildAdminNavGroups, parseAdminCapabilities } from '@/lib/admin/adminNav';

const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
const strip = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/^\s*\/\/.*$/, ''))
    .join('\n');
const migration = (prefix: string) => fs.readFileSync(path.join(MIG_DIR, fs.readdirSync(MIG_DIR).find((f) => f.startsWith(prefix))!), 'utf8');
const walk = (rel: string): string[] => {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(REPO_ROOT, rel), { withFileTypes: true })) {
    const p = `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
};

// ---------------------------------------------------------------------------------------------------------------------------
describe('capabilities are NOT implied (Standard sections 2 and 3)', () => {
  const PREDICATES: [string, string, string][] = [
    ['0231_', 'is_premium_entitlement_admin', 'can_manage_premium_entitlements'],
    ['0237_', 'is_promo_code_admin', 'can_manage_promo_codes'],
    ['0264_', 'is_entitlement_override_admin', 'can_override_entitlement_limits'],
  ];
  const body = (sql: string, fn: string) => {
    const m = sql.match(new RegExp(`create or replace function public\\.${fn}\\(\\)[\\s\\S]*?\\$(?:fn)?\\$;`));
    if (!m) throw new Error(`predicate ${fn} not found`);
    return m[0];
  };
  const readsOnlyOwnColumn = (text: string, column: string) => {
    expect(text.includes(`admin_users.${column} = true`), 'a predicate reads only its own column').toBe(true);
    const others = [...text.matchAll(/admin_users\.(\w+)/g)].map((m) => m[1]).filter((c) => c !== column && c !== 'user_id');
    expect(others, 'a predicate reads only its own column').toEqual([]);
    expect(/is_admin|super_admin|role\b|or\s+exists|\bor\b\s+true/i.test(text.replace(/--.*$/gm, '')), 'a predicate reads only its own column').toBe(false);
  };

  for (const [prefix, fn, column] of PREDICATES) {
    it(`${fn}() is true only for admin_users.${column} = true and for nobody else`, () => {
      readsOnlyOwnColumn(body(migration(prefix), fn), column);
    });
  }

  it('NC-C1: a predicate that ALSO accepted any admin_users row would be caught by the same assertion', async () => {
    const real = body(migration('0237_'), 'is_promo_code_admin');
    readsOnlyOwnColumn(real, 'can_manage_promo_codes');
    const broken = real.replace('admin_users.can_manage_promo_codes = true', 'admin_users.can_manage_promo_codes = true or admin_users.can_manage_premium_entitlements = true');
    await expectNamedFailure(() => readsOnlyOwnColumn(broken, 'can_manage_promo_codes'), 'a predicate reads only its own column');
  });

  it('every function granted to authenticated in the promo hardening migrations checks a capability INSIDE the function (layer 1, never navigation)', () => {
    const files = ['0265_', '0266_', '0264_'].map(migration);
    for (const sql of files) {
      const fns = [...sql.matchAll(/create or replace function public\.(\w+)\(([\s\S]*?)\$fn\$([\s\S]*?)\$fn\$;/g)];
      for (const f of fns) {
        const granted = new RegExp(`grant execute on function public\\.${f[1]}\\([^)]*\\) to [^;]*\\bauthenticated\\b`).test(sql);
        if (!granted) continue;
        if (f[1].startsWith('is_')) continue; // the capability predicates themselves
        const header = f[0].slice(0, f[0].indexOf(String.fromCharCode(36) + 'fn' + String.fromCharCode(36)));
        if (/\bimmutable\b/.test(header)) continue; // a pure constant or arithmetic helper, not a data path
        expect(/is_promo_code_admin\(\)|is_premium_entitlement_admin\(\)|is_entitlement_override_admin\(\)/.test(f[3]), `${f[1]} is granted to authenticated and must check a capability inside`).toBe(true);
      }
    }
  });

  it('admin_users membership and Super Admin never produce the three capabilities: the parser needs a literal true in each field', () => {
    const body = (caps: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ data: { isAdmin: true, hasResourcesAccess: true, ...extra, capabilities: caps } });
    const onlyAdmin = parseAdminCapabilities(body({}));
    expect([onlyAdmin.entitlementManagement, onlyAdmin.promoCodeManagement, onlyAdmin.entitlementOverride]).toEqual([false, false, false]);
    const one = parseAdminCapabilities(body({ entitlementManagement: true }));
    expect([one.entitlementManagement, one.promoCodeManagement, one.entitlementOverride]).toEqual([true, false, false]);
    const two = parseAdminCapabilities(body({ promoCodeManagement: true, entitlementManagement: true }));
    expect(two.entitlementOverride, 'the two ordinary capabilities do not imply the override').toBe(false);
    const override = parseAdminCapabilities(body({ entitlementOverride: true }));
    expect([override.entitlementManagement, override.promoCodeManagement]).toEqual([false, false]);
    expect(parseAdminCapabilities(body({ entitlementOverride: 'true' })).entitlementOverride, 'only a literal true counts').toBe(false);
    expect(parseAdminCapabilities(null)).toEqual(NO_ADMIN_CAPABILITIES);
    expect(NO_ADMIN_CAPABILITIES.entitlementOverride).toBe(false);
  });

  it('navigation: the override capability alone adds no menu entry; each ordinary capability adds only its own group', () => {
    const labels = (caps: Partial<typeof NO_ADMIN_CAPABILITIES>) => buildAdminNavGroups(true, { ...NO_ADMIN_CAPABILITIES, ...caps }).map((g) => g.label);
    // Super Admin (isAdmin true) with no capability sees neither group
    expect(labels({})).not.toContain('Entitlements');
    expect(labels({})).not.toContain('Promo Codes');
    expect(labels({ entitlementOverride: true })).not.toContain('Entitlements');
    expect(labels({ entitlementOverride: true })).not.toContain('Promo Codes');
    expect(labels({ entitlementManagement: true })).toContain('Entitlements');
    expect(labels({ entitlementManagement: true })).not.toContain('Promo Codes');
    expect(labels({ promoCodeManagement: true })).toContain('Promo Codes');
    expect(labels({ promoCodeManagement: true })).not.toContain('Entitlements');
  });

  it('/api/admin/me: each of the three capabilities has its own independent read of its own column, and none is combined with Super Admin', () => {
    const src = strip(read('app/api/admin/me/route.ts'));
    for (const [prop, fn, cap] of [
      ['entitlementManagement', 'canManagePremiumEntitlements', 'PREMIUM_ENTITLEMENT_ADMIN_CAPABILITY'],
      ['promoCodeManagement', 'canManagePromoCodes', 'PROMO_CODE_ADMIN_CAPABILITY'],
      ['entitlementOverride', 'canOverrideEntitlementLimits', 'ENTITLEMENT_OVERRIDE_CAPABILITY'],
    ] as const) {
      const line = src.split('\n').find((l) => l.includes(`${prop}:`) && l.includes('await'));
      expect(line, `${prop} line`).toBeDefined();
      expect(line, `no capability is derived from Super Admin (${prop})`).not.toMatch(/isSuperAdmin|isAdmin|\|\||&&/);
      expect(line).toContain(`${fn}()`);
      const fnBody = src.slice(src.indexOf(`async function ${fn}`), src.indexOf('}\n', src.indexOf(`async function ${fn}`) + 200));
      expect(fnBody, `${fn} reads its own column`).toContain(cap);
      expect(fnBody, `${fn} fails closed`).toMatch(/catch\s*\{\s*return false;/);
    }
  });

  it('NC-C2: a /api/admin/me line that ORs Super Admin into a capability would be caught', async () => {
    const check = (line: string) => expect(line, 'no capability is derived from Super Admin (entitlementManagement)').not.toMatch(/isSuperAdmin|isAdmin|\|\||&&/);
    check('      entitlementManagement: await canManagePremiumEntitlements(),');
    await expectNamedFailure(() => check('      entitlementManagement: current.isSuperAdmin || (await canManagePremiumEntitlements()),'), 'no capability is derived from Super Admin');
  });

  it('every promo, entitlement and override route uses its OWN named guard and never the bare requireAdmin()', () => {
    const files = [...walk('app/api/admin/promo-codes'), ...walk('app/api/admin/entitlements')].filter((f) => f.endsWith('route.ts'));
    expect(files.length).toBeGreaterThanOrEqual(8);
    for (const f of files) {
      const src = strip(read(f));
      expect(src.includes('requireAdmin('), `${f} must not use the bare requireAdmin()`).toBe(false);
      const own = f.includes('/promo-codes') ? 'requirePromoCodeAdmin' : 'requirePremiumEntitlementAdmin';
      expect(src.includes(`${own}()`), `${f} uses ${own}`).toBe(true);
    }
    const grants = strip(read('app/api/admin/entitlements/grants/route.ts'));
    expect(grants).toContain('requireEntitlementOverrideAdmin');
    expect(grants.indexOf('requirePremiumEntitlementAdmin()'), 'the ordinary guard runs first').toBeLessThan(grants.indexOf('requireEntitlementOverrideAdmin()'));
    const guard = strip(read('lib/services/entitlementOverrideAdmin.ts'));
    expect(guard).toContain("can_manage_premium_entitlements, ${ENTITLEMENT_OVERRIDE_CAPABILITY}");
    expect(guard, 'fails closed on a read error').toMatch(/error \|\|/);
  });

  it('there is no way to write a capability through the API: admin_users has only a self-read policy and no write grant for API roles', () => {
    const all = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).map((f) => fs.readFileSync(path.join(MIG_DIR, f), 'utf8')).join('\n');
    const policies = [...all.matchAll(/create policy [^\n]* on (?:public\.)?admin_users[^;]*;/gi)].map((m) => m[0]);
    expect(policies.every((p) => /for select/i.test(p) || /using \(auth\.uid\(\) = user_id\)/.test(p)), 'admin_users policies are read only').toBe(true);
    expect(/grant (?:insert|update|delete|all)[^;]* on (?:public\.)?admin_users to (?:anon|authenticated)/i.test(all)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe('item 4: secrets have no fallbacks, are never logged, and are forwarded and documented', () => {
  const PROMO_FILES = [
    'lib/services/promoSecrets.ts', 'lib/services/promoCodeIp.ts', 'lib/services/promoCodeDigest.ts', 'lib/services/promoCodeEmail.ts', 'lib/services/promoCodeCreate.ts',
    'lib/services/premiumCronAuth.ts', 'lib/services/promoEmailAbuse.ts', 'lib/services/promoEmailBreaker.ts', 'app/api/payments/promo/redeem/route.ts', 'app/api/premium/cron/expiry-reminders/route.ts',
    ...walk('app/api/admin/promo-codes'),
  ];

  const noFallback = (src: string) => {
    const code = strip(src);
    // an expression that ORs two secret variables or two secret readers together
    const chain = /(?:PROMO_IP_HASH_SECRET|PREMIUM_PROMO_EMAIL_BIND_SECRET|PROMO_CODE_DIGEST_SECRET|CRON_SECRET)[^\n]*\|\|[^\n]*(?:PROMO_IP_HASH_SECRET|PREMIUM_PROMO_EMAIL_BIND_SECRET|PROMO_CODE_DIGEST_SECRET|CRON_SECRET)/;
    expect(chain.test(code), 'no fallback between secrets').toBe(false);
    expect(/readPromoSecret\([^)]*\)\s*(?:\|\||\?\?)\s*readPromoSecret/.test(code), 'no fallback between secrets').toBe(false);
  };

  it('no promo or reminder source falls back from one dedicated secret to another', () => {
    for (const f of PROMO_FILES) noFallback(read(f));
  });

  it('NC-F1: the OLD fallback chain would be caught by the same check', async () => {
    noFallback('export const s = (env) => env.PREMIUM_PROMO_EMAIL_BIND_SECRET;');
    await expectNamedFailure(() => noFallback('const s = env.PREMIUM_PROMO_EMAIL_BIND_SECRET || env.PROMO_IP_HASH_SECRET || env.CRON_SECRET || null;'), 'no fallback between secrets');
  });

  it('only the secrets module and the cron authenticator read the dedicated secrets from the environment', () => {
    for (const f of PROMO_FILES) {
      if (f.endsWith('promoSecrets.ts')) continue;
      const code = strip(read(f));
      for (const name of ['PROMO_IP_HASH_SECRET', 'PREMIUM_PROMO_EMAIL_BIND_SECRET', 'PROMO_CODE_DIGEST_SECRET', 'CRON_SECRET']) {
        expect(new RegExp(`(?:process\\.env|env)\\.${name}\\b`).test(code), `${f} must read ${name} only through promoSecrets`).toBe(false);
      }
    }
  });

  it('the libraries never log (only the routes log, and only variable NAMES)', () => {
    for (const f of PROMO_FILES.filter((x) => x.startsWith('lib/'))) expect(/console\.(log|info|warn|error|debug)\(/.test(strip(read(f))), `${f} must not log`).toBe(false);
    for (const f of PROMO_FILES.filter((x) => x.startsWith('app/'))) {
      for (const line of strip(read(f)).split('\n').filter((l) => /console\.(log|info|warn|error|debug)\(/.test(l))) {
        expect(/secret|digest|password|token|\bcode\b\s*[,)]/i.test(line.replace(/promo redeem failed|server secrets not configured|premium expiry reminders[^'"]*|promo redeem refused/g, '')), `a log line must not carry a value: ${line.trim()}`).toBe(false);
      }
    }
  });

  it('amplify.yml forwards every promo secret and setting by name or prefix, and the environment document describes each', () => {
    const amplify = read('amplify.yml');
    const grep = amplify.split('\n').find((l) => l.includes('env | grep -e SUPABASE_SERVICE_ROLE_KEY')) ?? '';
    for (const token of ['-e CRON_SECRET', '-e PROMO_IP_HASH_SECRET', '-e PROMO_CODE_DIGEST_', '-e PROMO_TRUSTED_PROXY_HOPS', '-e PREMIUM_REMINDER_', '-e PREMIUM_PROMO_EMAIL_']) expect(grep, token).toContain(token);
    const doc = read('ENVIRONMENT_VARIABLES.md');
    for (const name of [
      'PROMO_CODE_DIGEST_SECRET', 'PROMO_CODE_DIGEST_VERSION', 'PROMO_CODE_DIGEST_SECRET_PREVIOUS', 'PREMIUM_PROMO_EMAIL_BIND_SECRET', 'PROMO_IP_HASH_SECRET', 'CRON_SECRET',
      'PROMO_TRUSTED_PROXY_HOPS', 'PREMIUM_PROMO_EMAIL_ENABLED', 'PREMIUM_REMINDER_SEVEN_DAY_ENABLED',
    ]) expect(doc, `ENVIRONMENT_VARIABLES.md documents ${name}`).toContain(`\`${name}\``);
    expect(doc).toMatch(/There are no fallbacks between these secrets/);
    expect(doc).toMatch(/unset \(OFF\)/);
    // every variable name the promo code reads is documented
    const used = new Set<string>();
    for (const f of [...PROMO_FILES, 'lib/services/premiumExpiryReminderEmail.ts', 'lib/services/premiumReminderMailer.ts']) {
      for (const m of strip(read(f)).matchAll(/\b(PROMO_[A-Z_]+|PREMIUM_[A-Z_]+|CRON_SECRET)\b/g)) used.add(m[1]);
    }
    for (const name of used) {
      if (/^(?:PROMO|PREMIUM|CRON)[A-Z_]*(?:_SECRET|_SECRET_PREVIOUS|_ENABLED|_VERSION|_HOPS|_FROM_NAME|_FROM_EMAIL)$/.test(name)) expect(doc, `${name} is read by the code and must be documented`).toContain(name);
    }
  });

  it('the secrets module refuses (never degrades): every feature lists the secrets it needs and the redeem route needs all three', () => {
    const src = strip(read('lib/services/promoSecrets.ts'));
    expect(src).toMatch(/redeem: \['digest', 'ip', 'bind'\]/);
    expect(src).toMatch(/create: \['digest'\]/);
    expect(src).toMatch(/email: \['digest', 'bind'\]/);
    expect(src).toMatch(/cron: \['cron'\]/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe('nothing is switched on', () => {
  it('the e-mail kill switch, the seven day reminder and every job control row ship OFF', () => {
    const email = strip(read('lib/services/promoCodeEmail.ts'));
    expect(email).toMatch(/PREMIUM_PROMO_EMAIL_ENABLED \?\? ''\)\.trim\(\) === 'true'/);
    const reminder = strip(read('lib/services/premiumExpiryReminderEmail.ts'));
    expect(reminder).toMatch(/PREMIUM_REMINDER_SEVEN_DAY_ENABLED \?\? ''\)\.trim\(\) === 'true'/);
    expect(reminder).toMatch(/PREMIUM_EXPIRY_EMAIL_THRESHOLD_DAYS: readonly number\[\] = \[30\]/);
    expect(migration('0238_')).toMatch(/select 'expiry_email', false/);
    expect(migration('0267_')).toMatch(/select 'promo_retention', false/);
    for (const prefix of ['0264_', '0265_', '0266_', '0267_', '0268_']) {
      const sql = migration(prefix).replace(/--.*$/gm, '');
      expect(/(?:insert into|update) public\.premium_reminder_job_control[^;]*\btrue\b/i.test(sql), `${prefix} must not enable a job`).toBe(false);
      expect(/update public\.premium_reminder_job_control/i.test(sql), `${prefix} must not change a job switch`).toBe(false);
    }
  });

  it('every cron registration in the hardening migrations sits behind the production marker and the pg_cron check', () => {
    for (const prefix of ['0264_', '0265_', '0266_', '0267_', '0268_']) {
      const sql = migration(prefix);
      for (const m of sql.matchAll(/cron\.schedule\(/g)) {
        const before = sql.slice(0, m.index);
        const doStart = before.lastIndexOf('do $fn$');
        expect(doStart, `${prefix}: cron.schedule must be inside a do block`).toBeGreaterThan(-1);
        const block = sql.slice(doStart, m.index);
        expect(block, `${prefix}: guarded by the production marker`).toContain("platform_deployment_environment where environment = 'production'");
        expect(block, `${prefix}: guarded by the pg_cron check`).toContain("to_regclass('cron.job')");
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe('item 12: Admin and Profile screens (source contract)', () => {
  const SCREENS = ['components/admin/PromoCodesClient.tsx', 'components/admin/PremiumEntitlementsClient.tsx'];

  const usesSharedStatus = (src: string) => expect(/import \{[^}]*AdminActionStatus[^}]*\} from '@\/components\/admin\/AdminActionStatus'/.test(src) && src.includes('<AdminActionStatus'), 'the screen uses the shared status component').toBe(true);

  it('both screens use the shared live-region status component (success polite, failure assertive)', () => {
    for (const f of SCREENS) usesSharedStatus(read(f));
  });

  it('NC-U1: a screen with its own ad hoc paragraphs instead would be caught', async () => {
    await expectNamedFailure(() => usesSharedStatus('export function X() { return <p role="alert">{error}</p>; }'), 'the screen uses the shared status component');
  });

  it('every static form control id has a label pointing at it (keyboard and screen reader)', () => {
    for (const f of SCREENS) {
      const src = read(f);
      const ids = [...src.matchAll(/<(?:input|textarea|select)\b[^>]*\bid="([a-z0-9-]+)"/g)].map((m) => m[1]);
      expect(ids.length, `${f} has form controls`).toBeGreaterThanOrEqual(4);
      for (const id of ids) expect(src.includes(`htmlFor="${id}"`), `${f}: control ${id} needs a label`).toBe(true);
    }
  });

  it('dates are day-first through the shared formatters or the typed DD-MM-YYYY input, never a native date picker or locale formatting', () => {
    for (const f of [...SCREENS, 'components/billing/PremiumAccessNotice.tsx', 'components/profile/BillingPanel.tsx']) {
      const src = strip(read(f));
      expect(/type="date"|toLocaleDateString|Intl\.DateTimeFormat/.test(src), `${f} date handling`).toBe(false);
    }
    expect(read('components/admin/PromoCodesClient.tsx')).toMatch(/formatDateShort/);
    expect(read('components/admin/PromoCodesClient.tsx')).toMatch(/DATE_INPUT_HINT/);
    expect(read('components/admin/PremiumEntitlementsClient.tsx')).toMatch(/formatDateShort/);
  });

  it('the list shows only a masked hint: the code is never rendered from a list row, and no list column asks for it', () => {
    const src = read('components/admin/PromoCodesClient.tsx');
    expect(/formatPromoCode\(r\.code\)|r\.code\b/.test(src.replace(/r\.code_hint/g, ''))).toBe(false);
    expect(src).toMatch(/Code \(masked\)/);
    expect(src).toMatch(/shown only this once/);
  });

  it('responsive and safe structure: tables scroll inside their own wrapper, forms are single column, destructive actions need confirmation text', () => {
    const promo = read('components/admin/PromoCodesClient.tsx');
    expect((promo.match(/<table/g) ?? []).length).toBe((promo.match(/overflow-x-auto/g) ?? []).length);
    expect(promo).toMatch(/Confirm disable/);
    expect(promo).toMatch(/PROMO_DISABLE_REASON_MIN_LENGTH/);
    const ent = read('components/admin/PremiumEntitlementsClient.tsx');
    expect((ent.match(/<table/g) ?? []).length).toBe((ent.match(/overflow-x-auto/g) ?? []).length);
    expect(ent).toMatch(/Confirm revoke/);
    expect(ent).toMatch(/OVERRIDE_REASON_MIN_LENGTH/);
  });

  it('create form states: generated versus admin-entered code, finite versus unlimited, expiry versus none, purpose required with a recipient, the bound-address note', () => {
    const src = read('components/admin/PromoCodesClient.tsx');
    for (const text of ['leave blank to generate one', 'Unlimited (explicit choice)', 'No expiry (explicit choice)', 'Why are you sending this code?', 'verified', 'Generate a replacement code and email it', 'Check the delivery status of an earlier e-mail request', 'recipient did not receive']) {
      expect(src.toLowerCase(), text).toContain(text.toLowerCase() === 'recipient did not receive' ? 'for anyone who did not get it' : text.toLowerCase());
    }
  });

  it('the override panel renders only for an operator with the separate capability, read from /api/admin/me (fail closed)', () => {
    const src = read('components/admin/PremiumEntitlementsClient.tsx');
    expect(src).toMatch(/parseAdminCapabilities\(json\)\.entitlementOverride/);
    expect(src).toMatch(/catch \{\s*if \(!cancelled\) setCanOverride\(false\)/);
    expect(src).toMatch(/canOverride && selected/);
  });

  it('Profile redemption: posts to the redeem route, shows the generic server message, and the reminder banner uses the shared day-first formatter', () => {
    const billing = read('components/profile/BillingPanel.tsx');
    expect(billing).toMatch(/\/api\/payments\/promo\/redeem/);
    expect(read('components/profile/BillingPanel.tsx')).toMatch(/formatDateShort/);
    expect(read('lib/services/entitlementReminder.ts'), 'the banner text is built with the shared day-first formatter').toMatch(/formatIsoDate|formatDateShort/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe('documentation: one section per item and no stale claim', () => {
  const report = read('docs/admin/ADMIN_PROMO_CODES_AND_REMINDERS_REPORT.md');

  it('section 18 has one subsection per item (1 to 14) each stating finding, change, evidence and residual risk', () => {
    const start = report.indexOf('## 18. Hardening mission');
    expect(start).toBeGreaterThan(-1);
    const section = report.slice(start);
    for (let i = 1; i <= 14; i += 1) {
      const m = new RegExp(`### 18\\.${i} Item ${i}\\b[\\s\\S]*?(?=### 18\\.${i + 1} Item ${i + 1}\\b|$)`).exec(section);
      expect(m, `item ${i} subsection`).not.toBeNull();
      for (const key of ['Finding', 'Change', 'Evidence', 'Residual risk']) expect(m![0], `item ${i} states ${key}`).toContain(`**${key}`);
      expect(m![0], `item ${i} status`).toMatch(/\*\*Status: (DONE|DONE-with-residual|BLOCKED)/);
    }
  });

  it('earlier statements that the new design contradicts are marked as superseded', () => {
    for (const phrase of ['code stored normalised', 'Plain codes are visible in the admin list', 'a redemption on date R ends on R + `duration_days` (inclusive)']) {
      const at = report.indexOf(phrase);
      expect(at, phrase).toBeGreaterThan(-1);
      const near = report.slice(at, at + 700) + report.slice(Math.max(0, at - 300), at);
      expect(near, `${phrase} must be marked superseded`).toMatch(/SUPERSEDED/);
    }
  });

  it('the PO hand-over README exists with the apply order, the verify queries and the secrets list', () => {
    const readme = read('docs/admin/po_apply_hardening/README.md');
    for (const m of ['0264', '0265', '0266', '0267', '0268']) expect(readme).toContain(m);
    for (const t of ['Apply order', 'Verify after each part', 'Secrets the PO must generate', 'Reversal']) expect(readme).toContain(t);
    for (const f of ['parts/0264a.sql', 'parts/0268b.sql']) expect(fs.existsSync(path.join(REPO_ROOT, 'docs/admin/po_apply_hardening', f))).toBe(true);
  });
});
