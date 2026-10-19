#!/usr/bin/env bash
# Second pass after script corrections: journey 5 part 2 and 8a re-run, journey 1+2 re-run (holder reset), then the RBI correction journey 3b.
cd "$(dirname "$0")/../.." || exit 1
L=test-artifacts/nav2_stage3/logs
: > $L/_summary2.txt
run() { name=$1; shift; node "$@" > "$L/$name.log" 2>&1; echo "$name exit $?" >> $L/_summary2.txt; }
node scripts/nav2_stage3/reset_user.mjs free > $L/reset_free2.log 2>&1
run j5b scripts/nav2_stage3/j5b_states_and_reconciliation.mjs
run j8 scripts/nav2_stage3/j8_pdf_acceptance.mjs
node scripts/nav2_stage3/reset_user.mjs holder > $L/reset_holder2.log 2>&1
run j12 scripts/nav2_stage3/j12_accepted_statement_and_held_only.mjs
run j3b scripts/nav2_stage3/j3b_rbi_correction.mjs
node scripts/nav2_stage3/flags.mjs off > $L/flags_end2.log 2>&1
echo done >> $L/_summary2.txt
