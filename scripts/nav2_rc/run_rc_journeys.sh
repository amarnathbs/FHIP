#!/usr/bin/env bash
# Runs the NAV2 DEV journeys (Stage 3 journeys 3 to 9 plus the release candidate additions) in order against the app on port 3981 (DEV only), one log each in
# test-artifacts/nav2_stage3/logs/. Preconditions: the app server is up on the frozen SHA, fixture users set up (setup.mjs apply), statements built, j12 finished.
cd "$(dirname "$0")/../.." || exit 1
L=test-artifacts/nav2_stage3/logs
mkdir -p $L
: >> $L/_rc_summary.txt
run() { name=$1; shift; echo "$(date -u +%H:%M:%S) start $name" >> $L/_rc_summary.txt; node "$@" > "$L/$name.log" 2>&1; echo "$(date -u +%H:%M:%S) $name exit $?" >> $L/_rc_summary.txt; }
for part in "$@"; do
  case $part in
    reset_free) node scripts/nav2_stage3/reset_user.mjs free > $L/reset_free_rc.log 2>&1 ;;
    reset_spare) node scripts/nav2_stage3/reset_user.mjs spare > $L/reset_spare_rc.log 2>&1 ;;
    reset_admin) node scripts/nav2_stage3/reset_user.mjs admin > $L/reset_admin_rc.log 2>&1 ;;
    d3) run d3 scripts/nav2_rc/d3_reconcile.mjs ;;
    d8) run d8 scripts/nav2_rc/d8_concurrency_fairness.mjs ;;
    j3) run j3 scripts/nav2_stage3/j3_nav_correction.mjs ;;
    j3b) run j3b scripts/nav2_stage3/j3b_rbi_correction.mjs ;;
    j4) run j4 scripts/nav2_stage3/j4_v7_cache_proof.mjs ;;
    j5) run j5 scripts/nav2_stage3/j5_security.mjs ;;
    j5b) run j5b scripts/nav2_stage3/j5b_states_and_reconciliation.mjs ;;
    j6) run j6 scripts/nav2_stage3/j6_ownership_cases.mjs ;;
    j6b) run j6b scripts/nav2_stage3/j6b_joint_share.mjs ;;
    j7) run j7 scripts/nav2_stage3/j7_concurrency.mjs ;;
    j8) run j8 scripts/nav2_stage3/j8_pdf_acceptance.mjs ;;
    j8b) run j8b scripts/nav2_stage3/j8b_ui_accessibility.mjs ;;
    j9) run j9 scripts/nav2_stage3/j9_rbi_dry_run.mjs ;;
    d5) run d5 scripts/nav2_rc/d5_immutability_extra.mjs ;;
    m0282) run m0282 scripts/nav2_rc/d_monitor0282.mjs ;;
  esac
done
node scripts/nav2_stage3/flags.mjs off > $L/flags_after.log 2>&1
echo "done" >> $L/_rc_summary.txt
