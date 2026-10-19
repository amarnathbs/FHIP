#!/usr/bin/env bash
# Runs every Stage 3 journey in order against the app on port 3981 (DEV only) and writes one log per journey to test-artifacts/nav2_stage3/logs/.
# Preconditions: the app server is up (scripts/nav2_stage3/start_server.ps1), the fixture users are set up (node scripts/nav2_stage3/setup.mjs apply),
# and node scripts/nav2_stage3/build_statements.ts has been run (npx tsx scripts/nav2_stage3/build_statements.ts).
cd "$(dirname "$0")/../.." || exit 1
mkdir -p test-artifacts/nav2_stage3/logs
L=test-artifacts/nav2_stage3/logs
for u in holder free spare admin; do node scripts/nav2_stage3/reset_user.mjs $u > $L/reset_$u.log 2>&1; done
node scripts/nav2_stage3/flags.mjs off > $L/flags_start.log 2>&1
run() { name=$1; shift; node "$@" > "$L/$name.log" 2>&1; echo "$name exit $?" >> $L/_summary.txt; }
: > $L/_summary.txt
run j12 scripts/nav2_stage3/j12_accepted_statement_and_held_only.mjs
run j2b scripts/nav2_stage3/j2b_live_held_only_fetch.mjs
run j3 scripts/nav2_stage3/j3_nav_correction.mjs
run j4 scripts/nav2_stage3/j4_v7_cache_proof.mjs
run j5 scripts/nav2_stage3/j5_security.mjs
run j5b scripts/nav2_stage3/j5b_states_and_reconciliation.mjs
run j6 scripts/nav2_stage3/j6_ownership_cases.mjs
run j7 scripts/nav2_stage3/j7_concurrency.mjs
run j8 scripts/nav2_stage3/j8_pdf_acceptance.mjs
run j8b scripts/nav2_stage3/j8b_ui_accessibility.mjs
run j9 scripts/nav2_stage3/j9_rbi_dry_run.mjs
node scripts/nav2_stage3/flags.mjs off > $L/flags_end.log 2>&1
echo done >> $L/_summary.txt
