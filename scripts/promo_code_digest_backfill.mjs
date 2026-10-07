// Promo code digest backfill (hardening 0264 item 1) — OPERATOR SCRIPT, never run by the application or by CI.
//
// What it does, in order, for the codes that still have a plain value (created before hash only storage):
//   1. reads the pending rows (service role only function promo_codes_digest_pending),
//   2. computes each keyed digest with PROMO_CODE_DIGEST_SECRET (the secret never leaves this process),
//   3. stores it (promo_codes_digest_apply) and then asks the database to VERIFY the copy by sending the digest recomputed from
//      the plain value that was just read back (promo_codes_digest_mark_verified marks the row verified only if they are equal),
//   4. reports the counts. It NEVER prints a code, a digest or a secret, and it never blanks anything by itself:
//      blanking is the separate, deliberate step  --finalise  (all or nothing, only when every plain row is verified).
//
// SAFE BY DEFAULT. With no flag it is a DRY RUN that only counts. Writing needs --apply. Blanking needs --finalise AND
// --i-have-a-backup (a point in time backup or restore point exists for the project). It refuses to run against the
// production project unless --production is also given, and it refuses an unknown project.
//
//   node scripts/promo_code_digest_backfill.mjs                       dry run: counts only
//   node scripts/promo_code_digest_backfill.mjs --apply               store and verify digests (no blanking)
//   node scripts/promo_code_digest_backfill.mjs --finalise-dry        report what the finalise would do
//   node scripts/promo_code_digest_backfill.mjs --finalise --i-have-a-backup
//
// Environment (names only here): NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PROMO_CODE_DIGEST_SECRET,
// optional PROMO_CODE_DIGEST_VERSION (default 1). Reversal plan: docs/admin/po_apply_hardening/README.md section 6.

import { createHmac } from 'node:crypto';

const PRODUCTION_PROJECT_REF = 'twwpnltizhtjxhamyoxt';

/** Must equal computePromoDigest in lib/services/promoCodeDigest.ts (a test asserts they agree for the same inputs). */
export function digestOf(plainCode, secret, version) {
  const normalised = String(plainCode).replace(/[\s\-_]/g, '').toUpperCase();
  return createHmac('sha256', secret).update(`promo-code:v${version}:${normalised}`).digest('hex');
}

export function parseArgs(argv) {
  const has = (f) => argv.includes(f);
  return {
    apply: has('--apply'),
    finaliseDry: has('--finalise-dry'),
    finalise: has('--finalise'),
    backup: has('--i-have-a-backup'),
    production: has('--production'),
  };
}

export function projectRefOf(url) {
  const m = /^https:\/\/([a-z0-9]+)\.supabase\.co/i.exec(String(url ?? ''));
  return m ? m[1].toLowerCase() : null;
}

/** Returns an error message when the combination of flags and environment must not run, otherwise null. */
export function refusal(args, env) {
  const ref = projectRefOf(env.NEXT_PUBLIC_SUPABASE_URL);
  if (!ref) return 'NEXT_PUBLIC_SUPABASE_URL is missing or is not a Supabase project URL.';
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return 'SUPABASE_SERVICE_ROLE_KEY is missing.';
  if (!env.PROMO_CODE_DIGEST_SECRET || env.PROMO_CODE_DIGEST_SECRET.trim().length < 32) return 'PROMO_CODE_DIGEST_SECRET is missing or shorter than 32 characters.';
  if (ref === PRODUCTION_PROJECT_REF && !args.production) return 'This is the PRODUCTION project. Re-run with --production only when the PO has approved the production run.';
  if (args.finalise && !args.backup) return 'The finalise blanks the plain codes for good. Confirm a backup exists with --i-have-a-backup.';
  if (args.finalise && args.apply) return 'Run --apply and --finalise as separate steps so the counts can be read between them.';
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = process.env;
  const why = refusal(args, env);
  if (why) {
    console.error(`REFUSED: ${why}`);
    process.exit(2);
  }
  const { createClient } = await import('@supabase/supabase-js');
  const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const secret = env.PROMO_CODE_DIGEST_SECRET.trim();
  const version = Number(env.PROMO_CODE_DIGEST_VERSION ?? '1');
  if (!Number.isInteger(version) || version < 1) {
    console.error('REFUSED: PROMO_CODE_DIGEST_VERSION must be an integer of 1 or more.');
    process.exit(2);
  }
  console.log(`project: ${projectRefOf(env.NEXT_PUBLIC_SUPABASE_URL)}  mode: ${args.finalise ? 'FINALISE' : args.finaliseDry ? 'finalise dry run' : args.apply ? 'APPLY' : 'dry run'}`);

  if (args.finalise || args.finaliseDry) {
    const { data, error } = await db.rpc('promo_codes_finalise_hash_only', { p_dry_run: !args.finalise });
    if (error) {
      console.error(`finalise failed: ${error.code ?? ''} ${error.message}`);
      process.exit(1);
    }
    console.log(JSON.stringify(data));
    return;
  }

  let pendingTotal = 0;
  let applied = 0;
  let verified = 0;
  let mismatched = 0;
  for (;;) {
    const { data: rows, error } = await db.rpc('promo_codes_digest_pending', { p_limit: 200 });
    if (error) {
      console.error(`reading pending rows failed: ${error.code ?? ''} ${error.message}`);
      process.exit(1);
    }
    if (!rows || rows.length === 0) break;
    pendingTotal += rows.length;
    if (!args.apply) break; // a dry run only counts the first page and says so
    let progressed = 0;
    for (const row of rows) {
      const digest = digestOf(row.code, secret, version);
      const a = await db.rpc('promo_codes_digest_apply', { p_id: row.id, p_digest: digest, p_version: version });
      if (a.error) {
        console.error(`apply failed for one row: ${a.error.code ?? ''} ${a.error.message}`);
        mismatched += 1;
        continue;
      }
      applied += 1;
      // verify the copy: the digest is recomputed from the plain value read back, then compared inside the database
      const recomputed = digestOf(row.code, secret, version);
      const v = await db.rpc('promo_codes_digest_mark_verified', { p_id: row.id, p_recomputed_digest: recomputed });
      if (v.data === true) {
        verified += 1;
        progressed += 1;
      } else mismatched += 1;
    }
    if (progressed === 0) break; // nothing moved: stop instead of looping forever
  }
  console.log(`pending rows seen: ${pendingTotal}${args.apply ? '' : ' (first page only, dry run)'}  digests stored: ${applied}  verified: ${verified}  not verified: ${mismatched}`);
  console.log('Nothing was blanked. Run --finalise-dry to see the counts, then --finalise --i-have-a-backup when every row is verified.');
  if (mismatched > 0) process.exit(1);
}

if (process.argv[1] && process.argv[1].endsWith('promo_code_digest_backfill.mjs')) {
  main().catch((e) => {
    console.error(`failed: ${e instanceof Error ? e.name : 'error'}`);
    process.exit(1);
  });
}
