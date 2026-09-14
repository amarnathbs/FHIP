# AIE-1 Closure — Operational Runbooks (mission section 13)

Every runbook below assumes the reader has read-only production/DEV
console access and, where noted, the AIE-scoped IAM roles from
`AIE_1_CLOSURE_AWS_INFRASTRUCTURE.md`. **No runbook here logs or requires
logging a full document, prompt, or provider payload** — every diagnostic
step below reads from `aie_audit_event` (counts/status/reason codes only,
per its own table-level discipline) or infrastructure-level metadata
(queue depth, GuardDuty plan status), never document content.

---

## 1. GuardDuty plan inactive

**Symptom**: new uploads stall in `quarantined` past the scan-wait
deadline; no `document_purged`/extraction-admitted audit events for new
intakes.

**Diagnose**:
```bash
aws guardduty get-malware-protection-plan --region ap-southeast-2 --malware-protection-plan-id <id>
```
Check `status`. `WARNING`/`ERROR` includes a `statusReasons` code (e.g.
`INSUFFICIENT_TEST_OBJECT_PERMISSIONS`, `EVENTBRIDGE_MANAGED_EVENTS_
DELIVERY_DISABLED` — both documented in `scanResultTypes.ts`'s header
sources). Also watch for a `GuardDuty Malware Protection Resource Status
Warning/Error` EventBridge event.

**Mitigate**: fix the named `statusReasons` code per AWS's own
troubleshooting guidance (IAM permission gap, missing test object, etc.).
While inactive, **new intake should be blocked at the application layer**
(the global `AIE_DOCUMENT_INTAKE_ENABLED` kill switch) rather than left to
silently admit unscanned objects — no code path in this repo currently
auto-detects plan health and flips that switch; this is a manual operator
action until that automation is built.

## 2. Scan backlog (GuardDuty scans queuing, not completing in time)

**Symptom**: `s3Throttled: true` appearing in scan-result events; objects
approaching the 24-hour hard-backstop age without a scan result ever
arriving.

**Diagnose**: CloudWatch GuardDuty metrics for scan latency; check the
bucket's prefix structure against S3's TPS guidance (the IaC doc's own
`s3Throttled` note).

**Mitigate**: this is a genuine capacity/design issue (uploads concentrated
under too few prefixes), not a code bug — restructure the quarantine key
prefix scheme (already random-UUID-per-user, so this is unlikely at pilot
volume) or request a GuardDuty scan-rate increase from AWS. Do NOT
lower the admission-deadline to compensate — that would silently convert
legitimate slow scans into false `block_deadline_expired` rejections.

## 3. Dead-letter messages (GuardDuty scan-result SQS DLQ)

**Symptom**: `aie-scan-result-dlq-not-empty` CloudWatch alarm fires.

**Diagnose**: read (never delete) messages from the DLQ; each is a scan
result the consumer failed to process 5 times. `lib/aie/malware/
scanResultHandler.ts#decideScanResult()`'s pure logic is the first thing to
check against the actual message content — since it's pure/no I/O, replay
the exact message through it locally to see which branch it hits.

**Mitigate**: if `decideScanResult` itself is correct and the failure is
transient (e.g. a DB outage during the consumer's durable-write step),
manually redrive the DLQ messages back to the main queue once the
transient cause is resolved. If `decideScanResult` reveals a genuine logic
gap, fix and add a regression test (see `tests/unit/
aieGuardDutyScanResultHandler.test.ts`'s existing 15 cases as the pattern)
before redriving.

## 4. Provider outage (OpenAI)

**Symptom**: elevated `provider_error`/`timeout` outcomes in
`aie_ai_completion_attempt.outcome` (or, once wired for real, the
`ai_fallback_budget_exhausted` audit event if outages coincide with the
cost ledger settling reservations at the full amount and exhausting the
allowance — see item 5).

**Diagnose**: check OpenAI's own status page; confirm `AIE_OPENAI_API_KEY`
is genuinely valid (`OpenAiAieProvider.validateProviderHealth()` reports
"configured", not "live-verified" — a stale/revoked key looks configured
right up until the first real call fails with `AUTH`).

**Mitigate**: deterministic processing continues regardless (GW-12,
`lib/aie/provider/gateway.ts`'s own architecture) — the outage degrades AI
fallback only, never blocks documents whose deterministic parser already
succeeded. If sustained, flip `AIE_AI_FALLBACK_ENABLED` off entirely to
stop attempting (and burning bounded-retry budget on) calls that will keep
failing; deterministic-complete documents are entirely unaffected either
way.

## 5. Cost spike (AI pilot allowance)

**Symptom**: `aie_ai_cost_ledger.reserved_usd + settled_usd` approaching
`allowance_usd`; `budget_exhausted` outcomes appearing.

**Diagnose**:
```ts
import { getAieCostLedgerSnapshot } from '@/lib/aie/cost/costAdmission';
// remainingUsd, totalAttempts, totalInputTokens/totalOutputTokens
```
Check for an unexpectedly high `totalAttempts`/tokens-per-attempt ratio —
could indicate a retry storm (transient failures repeatedly re-reserving)
or a genuine traffic spike.

**Mitigate**: the reservation itself already structurally prevents
overspending the configured `AIE_AI_COST_ALLOWANCE_USD` (migration 0150's
atomic RPC) — no manual intervention is needed to prevent a runaway
overspend. To raise the pilot ceiling deliberately, change
`AIE_AI_COST_ALLOWANCE_USD` (a config change, not a DB migration — the
allowance is supplied by the app on every call, see `0150`'s own header).
To pause AI spend entirely while investigating, flip
`AIE_AI_FALLBACK_ENABLED` off (deterministic processing is unaffected).

## 6. Retention breach (an object older than 24h, still not purged)

**Symptom**: an `aie_document_intake` row with `storage_key` set and
`created_at` older than 24 hours, `purge_status` not `purged`.

**Diagnose**: check `last_purge_error_sanitised` and
`purge_attempt_count` on the row (once migration 0149 is applied — until
then, see the disclosed pre-0149 degradation in
`AIE_1_CLOSURE_INSURANCE_REGRESSION_REPORT.md`: the row may show
`status: 'ready'` with a stale `storage_key` even though the object was
genuinely already deleted from Storage — always independently verify
against Storage directly with `admin.storage.from('aie-document-
quarantine').list(...)` before assuming the object still exists).

**Mitigate**: `enforceAieRawFileHardBackstop()` (called every 15 minutes by
the cron sweep) should have already force-scheduled this row — if it
hasn't fired, check the cron job itself is actually running (`select *
from cron.job where jobname = 'aie1-document-purge-sweep'` and
`cron.job_run_details` for recent failures) before assuming an application
bug. A manual one-off remediation: call `runPurgeAttempt()` directly for
the specific row via a service-role script (mirroring
`scripts/aiecl_pc5_interface_live_dev_check.ts`'s own direct-import
pattern).

## 7. Failed deletion (delete call succeeds, verify-absent fails, or vice versa)

**Symptom**: `document_purge_failed` audit events accumulating for the
same intake id (`purge_attempt_count` climbing).

**Diagnose**: `last_purge_error_sanitised` (URL-redacted, 200-char capped —
by design, never the raw client error) names the failure class. A
`storage object still present after delete` message specifically means
`deleteFromQuarantine` reported success but `verifyQuarantineObjectAbsent`
still found it — worth checking Supabase Storage's own status page for a
propagation-delay incident before assuming an application bug (the same
distrust-the-single-signal discipline `lib/aie/storage.ts`'s own header
documents).

**Mitigate**: the bounded 5-minute retry (`AIE_PURGE_FAILED_RETRY_DELAY_
MINUTES` in `lib/aie/services/purge.ts`) usually self-heals a transient
propagation delay. Persistent failure after several retries needs a human
to inspect the specific object directly in the Supabase Storage console.

## 8. Masking defect (a real PII pattern reaches the AI payload)

**Symptom**: `ai_fallback_unmasked_pii_blocked` audit events, OR — far more
seriously — a masking gap that the gateway's own defensive re-check
(`containsUnmaskedPii`, PAY-04) also misses.

**Diagnose**: `ai_fallback_unmasked_pii_blocked` firing is actually the
SAFE outcome (the defense-in-depth check caught what the primary masking
step missed) — treat every occurrence as a genuine masking-pattern gap to
fix in `lib/aie/masking/piiMasking.ts`, not noise to suppress. If no such
event ever fires but a real PII leak is suspected via another channel
(e.g. an OpenAI project dashboard review), that means BOTH layers missed
it — the more urgent case, requiring an immediate `AIE_AI_FALLBACK_
ENABLED=false` while the masking pattern is fixed and a new regression
test is added to `tests/unit/aiePiiMasking.test.ts`.

**Mitigate**: never patch masking patterns in production without a
regression test proving the specific missed pattern is now caught —
matches this repo's own established discipline (every prior masking fix
in this programme's history added a dedicated test first).

## 9. Incorrect extraction (a field value that reached canonical storage is wrong)

**Symptom**: a user or support ticket reports an accepted document's
canonical fields (e.g. `insurance_policies.cover_amount`) don't match the
source document.

**Diagnose**: query `aie_field_candidate`/`aie_review_decision` for the
run (`getAdapterIdForRun`, `listFieldCandidatesForRun`,
`listLatestCorrectionsForRun` — all already-existing repository functions)
to reconstruct exactly what was extracted, whether AI was used
(`aie_ai_completion_attempt`), and whether the user corrected it. **Never
re-derive the "right" value from the deleted original PDF** — it is gone
by design; provenance metadata (parser/schema/model versions, timestamps,
acceptance identity) is what mission section 4.5 says to retain instead,
and it is sufficient to determine WHERE the wrong value came from
(deterministic parser bug vs. AI hallucination vs. user's own correction)
without the original bytes.

**Mitigate**: canonical correction follows the amendment/audit model each
domain module already has (e.g. an insurance policy edit through its own
existing manual-entry UI) — mission section 10.5's own binding rule: no
destructive "undo" of canonical financial records outside an already-
approved amendment/audit model. Fix the root cause (parser bug → new
regression fixture; AI hallucination → tighten the schema/prompt; a
review-UX gap → the review UI itself) so the same mistake can't recur, in
addition to fixing the one affected record.

## 10. Canonical-write incident (a write partially succeeded, or a duplicate appeared)

**Symptom**: two canonical rows for what should be one accepted document,
or a canonical row with no corresponding `aie_*_adapter_link`/
`aie_write_batch` row (the exact failure mode migration 0146 fixed for
insurance/II link tables historically — see
`AIE_1_0146_INSURANCE_CLOSURE_REPORT.md`).

**Diagnose**: `hasWriteBatchForRun`/`findOrCreateWriteBatch`'s own
idempotency-key uniqueness should make this structurally rare post-0146 —
if it recurs, the FIRST thing to check is whether a NEW link/junction table
was added since without an equivalent trigger-column-name check (0146's
own root cause: two tables reusing a shared trigger function that
referenced the wrong column name for their specific schema).

**Mitigate**: never manually delete a canonical row to "fix" a duplicate
without first confirming which one is provably the FIRST successful write
(check `aie_write_batch.status = 'committed'`'s own timestamp, and the
audit trail's `run_completed` event) — deleting the wrong one destroys the
genuine record and keeps the duplicate.
