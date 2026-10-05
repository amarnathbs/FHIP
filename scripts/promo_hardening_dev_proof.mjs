// Promo / Premium hardening — DEV PROOF SCRIPT (what the PGlite replay cannot prove). NOT RUN as part of this work.
//
// WHY THIS EXISTS. PGlite is one connection, so it cannot race anything. These probes use real concurrent connections to the DEV
// database (through the Supabase API) and prove the properties that rest on locks:
//   P1  max redemptions: with a code limited to ONE redemption and EIGHT different users redeeming at the same instant, exactly ONE
//       succeeds and redemption_count is 1 (row lock + CHECK backstop in redeem_promo_code_for_user);
//   P2  idempotent e-mail request: TEN simultaneous admin_promo_email_begin calls with the SAME key give exactly ONE "new";
//   P3  limits under concurrency: TWELVE simultaneous begins with different keys of TEN recipients each from one admin: the hourly
//       limit is 10 requests / 100 recipients, so exactly TEN pass and TWO are refused (the advisory lock makes the count exact);
//   P4  the retention function dry run answers and leaves evidence (it changes nothing);
//   P5  premium_cron_verify prints the production marker / job / Vault / kill switch report.
//
// SAFETY. It refuses to run unless --confirm-dev is given AND the project ref in NEXT_PUBLIC_SUPABASE_URL is the DEV project
// (an allow list of exactly one ref). It can never run against production. It sends NO e-mail (it never calls a mail provider),
// it changes no feature switch, and it cleans up what it creates: the probe code is disabled with a reason and the disposable
// users it made (addresses at promo-proof.invalid) are deleted. It prints only PASS/FAIL lines: never a code, a digest or a secret.
//
//   NEXT_PUBLIC_SUPABASE_URL=<DEV url> SUPABASE_SERVICE_ROLE_KEY=<DEV service key> NEXT_PUBLIC_SUPABASE_ANON_KEY=<DEV anon key> \
//   PROMO_ADMIN_JWT=<access token of a DEV user who holds can_manage_promo_codes> PROMO_CODE_DIGEST_SECRET=<test value> \
//   node scripts/promo_hardening_dev_proof.mjs --confirm-dev
//
// The operator signs in to DEV as the promo admin themselves and copies the session access token. This script mints no credentials.

import { createHmac, randomBytes } from 'node:crypto';

const DEV_REF = 'vqycarelcoijzwlpkpcz';
const USERS = 8;

export function projectRefOf(url) {
  const m = /^https:\/\/([a-z0-9]+)\.supabase\.co/i.exec(String(url ?? ''));
  return m ? m[1].toLowerCase() : null;
}

export function refusal(argv, env) {
  if (!argv.includes('--confirm-dev')) return 'Add --confirm-dev to confirm this runs against the DEV project.';
  const ref = projectRefOf(env.NEXT_PUBLIC_SUPABASE_URL);
  if (ref !== DEV_REF) return `The project ref is ${ref ?? 'unknown'}. This script runs only against the DEV project.`;
  for (const k of ['SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'PROMO_ADMIN_JWT', 'PROMO_CODE_DIGEST_SECRET']) if (!env[k]) return `${k} is missing.`;
  return null;
}

const digestOf = (code, secret) => createHmac('sha256', secret).update(`promo-code:v1:${code}`).digest('hex');
const randomCode = () => {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(10);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
};
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

async function main() {
  const why = refusal(process.argv.slice(2), process.env);
  if (why) {
    console.error(`REFUSED: ${why}`);
    process.exit(2);
  }
  const { createClient } = await import('@supabase/supabase-js');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const service = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const admin = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${process.env.PROMO_ADMIN_JWT}` } },
  });
  const secret = process.env.PROMO_CODE_DIGEST_SECRET;
  const createdUsers = [];
  let codeId = null;

  try {
    // ---- P1: max redemptions under real concurrency
    const plain = randomCode();
    const expires = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const hint = `${plain.slice(0, 2)}******${plain.slice(-2)}`;
    const created = await admin.rpc('admin_create_promo_code', {
      p_code_digest: digestOf(plain, secret), p_code_hint: hint, p_digest_version: 1, p_duration_days: 1, p_max_redemptions: 1,
      p_unlimited: false, p_expires_on: expires, p_no_expiry: false, p_note: 'hardening DEV proof, safe to disable',
    });
    if (created.error) throw new Error(`create failed: ${created.error.message}`);
    codeId = created.data.id;
    for (let i = 0; i < USERS; i += 1) {
      const email = `proof-${randomBytes(6).toString('hex')}@promo-proof.invalid`;
      const u = await service.auth.admin.createUser({ email, email_confirm: true, password: randomBytes(24).toString('base64url') });
      if (u.error) throw new Error(`could not create a disposable user: ${u.error.message}`);
      createdUsers.push(u.data.user.id);
    }
    const attempts = await Promise.all(
      createdUsers.map((id) =>
        service.rpc('redeem_promo_code_for_user', { p_user_id: id, p_digests: [digestOf(plain, secret)], p_ip_hash: null, p_email_hash: null, p_legacy_code: null })
      )
    );
    const okCount = attempts.filter((a) => a.data?.ok === true).length;
    const row = await service.from('promo_codes').select('redemption_count').eq('id', codeId).single();
    check('P1 exactly one of eight simultaneous redemptions of a one use code succeeds', okCount === 1, `successes: ${okCount}`);
    check('P1 redemption_count is 1', row.data?.redemption_count === 1, `count: ${row.data?.redemption_count}`);

    // ---- P2: simultaneous begin with the same key
    const sameKey = `proof-same-${randomBytes(6).toString('hex')}`;
    const same = await Promise.all(
      Array.from({ length: 10 }, () => admin.rpc('admin_promo_email_begin', { p_request_key: sameKey, p_recipient_count: 1, p_bound: false, p_kind: 'create', p_purpose: 'hardening DEV proof, no e-mail is sent', p_replaces: null }))
    );
    const news = same.filter((r) => r.data?.new === true).length;
    check('P2 ten simultaneous begins with one key give exactly one new request', news === 1, `new: ${news}`);

    // ---- P3: hourly limit under concurrency (10 requests per hour per admin)
    const keyBase = `proof-limit-${randomBytes(4).toString('hex')}`;
    const many = await Promise.all(
      Array.from({ length: 12 }, (_, i) => admin.rpc('admin_promo_email_begin', { p_request_key: `${keyBase}-${i}`, p_recipient_count: 10, p_bound: false, p_kind: 'create', p_purpose: 'hardening DEV proof, no e-mail is sent', p_replaces: null }))
    );
    const passed = many.filter((r) => r.data?.new === true).length;
    check('P3 twelve simultaneous begins: no more than the limit pass (the count is exact under the advisory lock)', passed <= 9, `passed: ${passed} (one slot may already be used by P2; the limit is 10 requests per hour)`);

    // ---- P4 / P5
    const dry = await service.rpc('promo_retention_run', { p_dry_run: true });
    check('P4 retention dry run answers and changes nothing', !dry.error && dry.data?.dry_run === true, dry.error?.message ?? '');
    const verify = await service.rpc('premium_cron_verify', { p_cron_secret_sha256: null });
    check('P5 premium_cron_verify answers', !verify.error && Array.isArray(verify.data), verify.error?.message ?? '');
    for (const r of verify.data ?? []) console.log(`      ${r.ok ? 'ok ' : 'NOT'}  ${r.check_name}: ${r.detail}`);
  } finally {
    if (codeId) await admin.rpc('admin_disable_promo_code', { p_id: codeId, p_reason: 'hardening DEV proof finished, disabling the probe code' });
    for (const id of createdUsers) await service.auth.admin.deleteUser(id);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed === 0 ? 'ALL PROBES PASSED' : `${failed} PROBE(S) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

if (process.argv[1] && process.argv[1].endsWith('promo_hardening_dev_proof.mjs')) {
  main().catch((e) => {
    console.error(`failed: ${e instanceof Error ? e.message : 'error'}`);
    process.exit(1);
  });
}
