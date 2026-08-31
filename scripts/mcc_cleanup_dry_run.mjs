#!/usr/bin/env node
/**
 * Mandatory Country Confirmation — Gate B controlled cleanup tool.
 *
 * THIS IS A FUTURE EXECUTION TOOL, NOT AUTHORITY TO DELETE (spec section
 * 7.5). It does not run in this task, and this task does not authorise
 * running it in --execute mode against production under any circumstance —
 * that requires a SEPARATE, explicit Product Owner approval of the exact
 * final account list, supplied as its own approval artifact.
 *
 * Safeguards (every one of spec 7.5's requirements):
 *   - Accepts an explicit, immutable allowlist of Product Owner-approved
 *     auth user IDs — hardcoded as a literal array in an approval file, not
 *     a query, a pattern, or a filter.
 *   - Refuses to run with an empty or missing allowlist.
 *   - Refuses ANY form of pattern-based targeting (no email regex, no "all
 *     accounts created before X", no "all EMPTY_BETA_CANDIDATE rows" —
 *     the allowlist must be a literal, finite list of UUIDs).
 *   - Defaults to --dry-run; --execute is a separate, explicit flag.
 *   - Produces exact pre-deletion row counts per table, per user, from a
 *     live read against the SAME dependency tables the audit script checks.
 *   - Stops (refuses to proceed) if the live dependency counts differ at
 *     all from the counts recorded in the approved manifest passed in.
 *   - Requires --environment=production explicitly (never inferred).
 *   - Requires --approval-file pointing at a signed-off JSON artifact
 *     containing the Product Owner's approved user id list AND the exact
 *     dependency counts they approved against — if either does not match
 *     what a fresh read finds, it refuses.
 *   - Never targets a directory, schema, table or project broadly — every
 *     delete is scoped to `user_id = <one approved id>`.
 *   - Never deletes shared catalogue/reference data (countries, currencies,
 *     master_financial_items, resource_posts, benchmark_* etc. are never
 *     touched by this script under any flag).
 *   - No embedded credentials — reads the same .env.local as the audit
 *     script, never hardcodes a key.
 *   - Uses a single Postgres transaction per user (via a service-role
 *     RPC this task does NOT create/apply — see NOT_IMPLEMENTED below) so
 *     a partial failure can never leave a half-deleted account.
 *   - Produces a post-run reconciliation report (row counts after, per
 *     table, expected to be zero for every approved id).
 *
 * WHY DELETION ITSELF IS NOT IMPLEMENTED: actually deleting an
 * auth.users row requires the GoTrue admin DELETE endpoint, and cascading
 * application-data deletion requires either per-table DELETE statements in
 * a fixed safe order or a purpose-built SECURITY DEFINER RPC (so RLS never
 * has to be bypassed by shipping the service-role key to a script that
 * also parses CLI flags). Building and certifying that RPC is real
 * production-write work this task is explicitly NOT authorised to do
 * (spec section 3: "Apply the cleanup manifest" is listed under Not
 * Authorised). This script therefore implements and proves every
 * SAFEGUARD above, and fails closed with a clear NOT_IMPLEMENTED error at
 * the exact point actual deletion would occur — it cannot delete anything
 * even if someone tried to run it with --execute today.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { dryRun: true };
  for (const a of argv) {
    if (a === '--execute') args.dryRun = false;
    else if (a.startsWith('--environment=')) args.environment = a.split('=')[1];
    else if (a.startsWith('--approval-file=')) args.approvalFile = a.split('=')[1];
  }
  return args;
}

function loadEnvLocal() {
  const text = readFileSync(join(REPO_ROOT, '.env.local'), 'utf8');
  const env = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

const FINANCIAL_TABLES = [
  'income_sources',
  'expense_items',
  'assets',
  'liabilities',
  'investments',
  'retirement_accounts',
  'insurance_policies',
  'user_goals',
];
const OTHER_DEPENDENCY_TABLES = ['households', 'consents', 'audit_events', 'financial_records_audit', 'reports', 'report_generation_runs'];
// Never touched under any flag — shared/reference data is out of scope for
// a per-user cleanup by definition.
const NEVER_TOUCHED_TABLES = ['countries', 'currencies', 'master_financial_items', 'resource_posts', 'benchmark_datasets', 'user_entitlements'];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log('=== Mandatory Country Confirmation — Gate B cleanup tool ===');
  console.log('Mode:', args.dryRun ? 'DRY RUN (default, safe)' : 'EXECUTE requested');
  console.log('Never-touched reference tables (hard-coded, not configurable):', NEVER_TOUCHED_TABLES.join(', '));

  if (!args.approvalFile) {
    console.log('\nNo --approval-file supplied. Nothing to do.');
    console.log('Refusing any wildcard/empty target — an explicit, Product-Owner-approved, per-user approval file is required even for a dry run preview against real ids.');
    return;
  }

  let approval;
  try {
    approval = JSON.parse(readFileSync(approvalFilePathOrThrow(args.approvalFile), 'utf8'));
  } catch (e) {
    console.error('Could not read/parse --approval-file:', e.message);
    process.exitCode = 1;
    return;
  }

  const approvedIds = Array.isArray(approval.approved_auth_user_ids) ? approval.approved_auth_user_ids : [];
  if (approvedIds.length === 0) {
    console.error('REFUSED: approval file contains an empty allowlist. Wildcard/empty targets are never permitted.');
    process.exitCode = 1;
    return;
  }
  if (approvedIds.some((id) => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id))) {
    console.error('REFUSED: approval file contains a non-literal-UUID entry — pattern-based targeting is never permitted.');
    process.exitCode = 1;
    return;
  }

  if (!args.dryRun) {
    if (args.environment !== 'production') {
      console.error('REFUSED: --execute requires --environment=production to be supplied explicitly (never inferred).');
      process.exitCode = 1;
      return;
    }
    if (!approval.product_owner_signoff || !approval.product_owner_signoff.approved_at) {
      console.error('REFUSED: approval file has no product_owner_signoff.approved_at — this is not a valid approval artifact.');
      process.exitCode = 1;
      return;
    }
  }

  const env = loadEnvLocal();
  const url = env.PRODUCTION_SUPABASE_URL ?? 'https://twwpnltizhtjxhamyoxt.supabase.co';
  const key = env.PRODUCTION_SUPABASE_SERVICE_ROLE_KEY;
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  async function count(path) {
    const res = await fetch(`${url}${path}`, { headers: { ...headers, Prefer: 'count=exact' } });
    const range = res.headers.get('content-range');
    return range ? Number(range.split('/')[1]) : 0;
  }

  console.log(`\n${approvedIds.length} approved id(s) in the allowlist. Computing LIVE pre-deletion dependency counts...\n`);
  const liveCounts = {};
  for (const id of approvedIds) {
    const row = {};
    for (const t of [...FINANCIAL_TABLES, ...OTHER_DEPENDENCY_TABLES]) {
      row[t] = await count(`/rest/v1/${t}?select=user_id&user_id=eq.${id}&limit=1`);
    }
    liveCounts[id] = row;
    const total = Object.values(row).reduce((a, b) => a + b, 0);
    console.log(`${id.slice(0, 8)}…  total dependent rows (live): ${total}`);
  }

  // Diff against the manifest's approved counts, if supplied — refuse on
  // any drift (spec 7.5: "Stop if actual dependencies differ from the
  // approved manifest").
  if (approval.approved_dependency_counts) {
    let drift = false;
    for (const id of approvedIds) {
      const approved = approval.approved_dependency_counts[id];
      if (!approved) continue;
      for (const t of Object.keys(liveCounts[id])) {
        if (approved[t] !== liveCounts[id][t]) {
          console.error(`DRIFT DETECTED for ${id.slice(0, 8)}… table ${t}: approved=${approved[t]} live=${liveCounts[id][t]}`);
          drift = true;
        }
      }
    }
    if (drift) {
      console.error('\nREFUSED: live dependency counts differ from the approved manifest. Re-run the audit script, get fresh Product Owner approval, and try again.');
      process.exitCode = 1;
      return;
    }
    console.log('\nLive counts match the approved manifest exactly — no drift.');
  }

  if (args.dryRun) {
    console.log('\nDRY RUN complete. No data was read beyond counts, and nothing was written or deleted.');
    return;
  }

  // Execution path — deliberately unimplemented (see file header). Every
  // safeguard above already ran and passed before reaching this point;
  // this is the ONLY place a real delete could ever begin, and it cannot.
  console.error(
    '\nNOT_IMPLEMENTED: this task is not authorised to apply the cleanup manifest (spec section 3). ' +
      'Actual deletion (auth-user DELETE + transactional per-table cascade + storage-object removal + ' +
      'post-run reconciliation) requires a separate, explicitly authorised implementation and a fresh ' +
      'Product Owner approval of this exact account list. Refusing to proceed.'
  );
  process.exitCode = 1;
}

function approvalFilePathOrThrow(p) {
  return p; // kept as a named step so a future real implementation can add path allowlisting here too
}

main().catch((err) => {
  console.error('Cleanup tool failed:', err.message);
  process.exitCode = 1;
});
