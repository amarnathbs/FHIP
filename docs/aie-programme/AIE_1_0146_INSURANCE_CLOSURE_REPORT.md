# AIE-1 — Post-`0146` Insurance DEV Closure Report

**Date:** 2026-09-13
**Scope:** AIECL-BAS-04 (migration 0146 verification), AIECL-I46-01 through I46-12, AIECL-I46C-01 through I46C-12 (from the AIE-1 closure mission).
**Method:** real running Next.js dev server (`npm run dev -- -p 3931`, this branch's own worktree) against real DEV Supabase infrastructure, real disposable synthetic users, real authenticated browser sessions (cookie-based, via the app's own `/login` page — not a bare Bearer token, which this app's `@supabase/ssr`-based auth does **not** accept; confirmed empirically, not assumed). Every HTTP call in this report was a genuine request to the real running app, not an internal function call.

## Headline result: CLOSED. Migration `0146` genuinely fixes the defect it targets, live-DEV proven end to end, with zero residue.

## 1. Migration `0146` verification (AIECL-BAS-04 / I46-01)

Direct reproduction of the exact operation `0146` fixes (inserting into `aie_insurance_adapter_link`, which references `aie_intake_id` — a column name the OLD shared trigger did not check, causing a `42703` failure): a real insert against DEV succeeded.

```
RESULT: 0146 CONFIRMED applied and effective on DEV -- insert into aie_insurance_adapter_link succeeded
```

This does not just check a migrations-ledger row exists — `0146` is a pure function-body replacement with no new queryable object, so a ledger check alone would prove nothing. This is a live behavioral reproduction.

## 2. Full real journey, clean fixture (I46-02 through I46-10)

Real disposable synthetic DEV user, real login through the actual `/login` page, real session cookie (`sb-vqycarelcoijzwlpkpcz-auth-token`).

**Real HTTP POST to `/api/aie/insurance/intake?filename=policy.pdf`** (clean fixture, real valid PDF bytes generated via this repo's own `buildMinimalTextPdf`/`buildAieInsuranceFixtureText` test helpers):

```json
{"data":{"intake_id":"9b24613b-...","run_id":"0b37f2c1-...","status":"awaiting_acceptance","ai_used":false,"field_count":19,"unresolved_item_ids":[],"duplicate_classification":"distinct"}}
```

- **I46-03/04**: real HTTP intake accepted the PDF (200) — proves parser registration works in the real running route (the exact defect a prior live-DEV pass found and fixed).
- **I46-05**: 19 real typed field candidates extracted deterministically (`ai_used: false` — zero provider call for a complete statement).
- **I46-06**: reached `awaiting_acceptance` directly from the clean fixture, confirmed again via `GET /api/aie/review/runs/{runId}` (`userState: "ready_to_accept"`, `reconciliationOutcome: "pass"`, `openBlockingItemCount: 0`).

**Real HTTP POST to `/api/aie/review/runs/{runId}/accept`**:

```json
{"data":{"accepted":true,"alreadyCompleted":false,"insurancePolicyId":"186bbf8a-..."}}
```

Verified by direct, independent DB query (service-role, read-only) against the real rows the HTTP call produced:

- **I46-07**: acceptance succeeded through the real review API.
- **I46-08**: exactly **one** `insurance_policies` row committed, fields matching the source fixture exactly (`policy_name`, `cover_type: life`, `cover_amount: 500000`, `premium: 100`, `currency_code: AUD`, `provider`, `waiting_period_days: 90`, `benefit_period: "2 years"`).
- **I46-09**: exactly **one** `aie_insurance_adapter_link` row, referencing the correct `aie_intake_id`.
- **I46-10**: the AIE run's real status column reads `completed` — genuine, not stuck in a masked-failure state.

## 3. Idempotency and concurrency (I46-11)

**Same-key replay**: repeating the identical `POST .../accept` call with the same `idempotencyKey`:

```json
{"data":{"accepted":true,"alreadyCompleted":true,"insurancePolicyId":null}}
```

Independently confirmed via DB: policy count stayed at 1, link count stayed at 1. No duplicate.

**Concurrent replay** (the stronger proof — 6 simultaneous HTTP requests against a fresh run, same new idempotency key, fired via `Promise.all` from the real browser):

```json
[{"status":409},{"status":200,"accepted":true,"policyId":"0041eda3-..."},{"status":409},{"status":409},{"status":409},{"status":409}]
```

Exactly **one** of six simultaneous requests succeeded; the other five received `409 Conflict`. Independently confirmed via DB: total policy count for the user was exactly 2 after this run (1 from the first journey + 1 from this one), exactly 1 adapter-link row for this run. The concurrency guard is real and correctly atomic under genuine concurrent HTTP load, not just against sequential replay.

## 4. Negative case: broken fixture → correction → corrected value written (I46C-01/02)

A fixture with `coverAmount` deliberately omitted, uploaded through the real route:

```json
{"data":{"intake_id":"3bcb4322-...","run_id":"69630c62-...","status":"unresolved","field_count":18,"unresolved_item_ids":["5e102ad7-..."]}}
```

**I46C-01**: a real blocking unresolved item was created (`reasonCode: "reconciliation_fail:insurance_required_fields_present"`, `severity: "blocking"`, `correctableFields: [{"fieldName":"coverAmount",...}]`).

**Real correction submitted** via `POST /api/aie/review/items/{itemId}/decide`:

```json
{"action":"correct","itemVersion":1,"idempotencyKey":"...","fieldName":"coverAmount","rawValue":"750000"}
→ {"data":{"decided":true,"revalidation":{"runStatus":"awaiting_acceptance","openBlockingItemCount":0,"worstOutcome":"pass"}}}
```

Accepted, then independently verified by direct DB query:

```json
{"id":"a8269f3d-...","cover_amount":750000}
```

**I46C-02 confirmed**: the **corrected** value (750000) reached the canonical write, not any default, zero, or the missing original. This is a real, end-to-end proof of the review→correction→revalidation→acceptance pipeline against real infrastructure.

## 5. Cross-tenant and input-validation attacks (I46C-04, I46C-07)

A second real disposable synthetic user ("attacker") logged in through the real `/login` page in a separate browser session, then attempted:

| Attack | Result |
|---|---|
| `GET /api/aie/review/runs/{ownerRunId}` (cross-tenant status read) | `404` |
| `POST /api/aie/review/runs/{ownerRunId}/accept` (cross-tenant acceptance) | `404` |
| `POST .../accept` with `ownerHouseholdRole: "not-a-real-role"` (as the legitimate owner) | `422` |

Ownership is enforced by returning `404` (not `403`), which also avoids leaking existence of another tenant's run — the correct, safer choice already used consistently elsewhere in this codebase.

## 6. Cleanup and residue

Both synthetic users and every row they created (`insurance_policies`, `aie_insurance_adapter_link`, `aie_unresolved_item`, `aie_extraction_run`, `aie_document_intake`, `aie_document_fingerprint`) were deleted via service-role calls after the test, then **independently re-verified gone** via fresh `auth.admin.getUserById()` and count queries against every affected table, scoped to the two synthetic user ids.

```
ZERO RESIDUE CONFIRMED
```

## 7. What this closes, and what it doesn't

**Closed for real**: the exact defect Live-DEV Pass 2 found (the wrong-column-name trigger bug) is genuinely fixed. The full Insurance journey — upload, deterministic extraction, reconciliation, review, correction, acceptance, canonical write, idempotent replay, concurrent-replay safety, and cross-tenant denial — all work correctly against real infrastructure through the real running application, not just in unit tests.

**Not covered by this pass** (out of this specific closure item's scope, tracked separately in the AIE-1 consolidated report and the closure mission): retention/purge, real AI-provider integration, malware-scanner decision, PC5 integration, accessibility certification, broader document-class corpus expansion, and the controlled-cohort rollout mechanism.

**Migration `0146` is applied to DEV only, per the user's own report — not yet applied to production.** This closure report certifies DEV behavior; production behavior for this specific trigger fix remains unverified until `0146` is applied there.
