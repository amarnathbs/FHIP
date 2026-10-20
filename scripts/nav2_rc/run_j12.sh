#!/usr/bin/env bash
# Waits for the app on port 3981, resets the holder fixture user, runs journeys 1 and 2, then optionally the rest.
cd "$(dirname "$0")/../.." || exit 1
L=test-artifacts/nav2_stage3/logs
until [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3981/login)" != "000" ]; do sleep 5; done
node scripts/nav2_stage3/reset_user.mjs holder > $L/reset_holder3.log 2>&1
node scripts/nav2_stage3/j12_accepted_statement_and_held_only.mjs > $L/j12.log 2>&1
echo "exit $?" >> $L/j12.log
