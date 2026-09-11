# AIE-1 Live-DEV Verification Report

**Branch**: `integration/aie-1-release-candidate` (base commit `f1d7424`)
**Date**: 2026-09-12
**DEV project**: Supabase project ref `vqycarelcoijzwlpkpcz` (the project hardcoded as
`CERTIFIED_DEV_PROJECT_REF` in `scripts/aie1_1_create_storage_bucket.mjs`; matches
`NEXT_PUBLIC_SUPABASE_URL` in `.env.local`, never the `PRODUCTION_`-prefixed variables).
**Scope**: AIE_1_PRODUCTION_CERTIFICATION_PLAN.md section 4 ("Live-DEV verification").

## Headline result: CONDITIONAL — one real defect found and fixed; the core live-DEV
proof (migrations 0140-0145 applied, cross-tenant RLS on the AIE tables themselves,
the Insurance E2E journey, the hostile-PDF-through-the-real-route check) is **blocked**
by a genuine, structural, pre-existing limitation of this sandboxed environment: **there
is no way to execute DDL (CREATE TABLE / ALTER TABLE) against this Supabase project from
here.** This is not a new problem — it is the exact same limitation independently
disclosed by multiple prior phases in this repository's own history (see "Why migrations
could not be applied" below), confirmed again here, first-hand, against this exact project.

What follows is a section-by-section account of what was actually attempted, real
command output as evidence, what passed, what is blocked, and precisely why.

---

## 1. Migration application — BLOCKED (capability does not exist in this sandbox)

### 1a. Confirmed the "before" state (read-only, live)

Queried the DEV project's live PostgREST schema cache (which only ever lists tables
Supabase's API layer actually knows about) directly:

```
host vqycarelcoijzwlpkpcz.supabase.co
table:aie_document_intake:   http 404 (PGRST205 — table not found)
table:aie_unresolved_item:   http 404 (PGRST205 — table not found)
table:aie_review_decision:   http 404 (PGRST205 — table not found)
table:aie_mask_token_map:    http 404 (PGRST205 — table not found)
table:aie_ai_provider_call:  http 404 (PGRST205 — table not found)
table:insurance_policies:    http 200 (pre-existing table, unaffected)
openapi root: total paths in schema cache: 270; aie_-related paths: []
```

Confirms migrations `0140`-`0145` are **not applied** to DEV — proven by live query,
not assumed.

### 1b. Confirmed there is no DDL execution path available

Probed every mechanism this codebase's own prior phases have used to check for one:

```
rpc/exec_sql:     http 404 PGRST202 "Could not find the function public.exec_sql"
rpc/execute_sql:  http 404 PGRST202 "Could not find the function public.execute_sql"
rpc/run_sql:      http 404 PGRST202 "Could not find the function public.run_sql"
rpc/admin_exec:   http 404 PGRST202 "Could not find the function public.admin_exec"
Accept-Profile:information_schema -> http 406 PGRST106 "Only the following schemas
                                       are exposed: public, graphql_public"
supabase_migrations ledger        -> http 406 PGRST106 (same restriction)
```

Also checked and confirmed:
- `.env.local` (DEV block only) has no `DATABASE_URL`/`POSTGRES_URL`/DB password.
- No Supabase Management API personal-access-token exists anywhere in the environment
  (the Management API — the only channel that can run arbitrary DDL — is a separate,
  project-administration API requiring a PAT; the service-role key only authenticates
  against the project's own PostgREST/Storage/Auth/Realtime APIs, and PostgREST itself
  is a data API, not a SQL-execution endpoint).
- `npx supabase --version` resolves (2.117.0) but there is no `supabase login` session
  and no DB password to `supabase link`/`db push` with.

**This is not a new finding.** It is the identical, independently-disclosed limitation
already on record in this exact codebase from unrelated prior live-DEV passes:
`scripts/r11_professional_live_dev_tests.mjs`'s own sibling investigation, and the
explicit disclosures inside `scripts/ii_r5_schema_probe.mjs`, `scripts/ii_r6p1_schema_probe.mjs`,
and `scripts/r12_live_dev_verification.mjs` ("no exec_sql/execute_sql/run_sql/admin_exec
RPC exists... no DDL execution mechanism is available in this sandbox"). Confirmed here
again, first-hand, against the AIE-1 migrations specifically, rather than taken on faith
from those comments.

**What a human needs to do to unblock this**: either (a) run
`npx supabase db push` (or paste the six migration files' SQL directly into the Supabase
Studio SQL editor) from a machine/session that has the DEV project's database password
or a linked CLI session, or (b) grant this environment a `SUPABASE_ACCESS_TOKEN`
(Management API PAT) scoped to the DEV project only. Until one of those happens,
sections 2-4 below cannot be completed against the real AIE-1 schema.

### 1c. What WAS independently actionable without DDL, and was done for real

**Storage bucket** (`aie-document-quarantine`) — this is a Storage Admin API call, not
DDL, so it does not depend on the migrations. AIE-1.1's own report said this script was
"written, not run." Run for real this time:

```
$ node scripts/aie1_1_create_storage_bucket.mjs
Bucket created: {"name":"aie-document-quarantine"}

Live configuration:
  id: aie-document-quarantine
  public: false
  file_size_limit: 26214400
  allowed_mime_types: ["application/pdf"]

OK: aie-document-quarantine is private, size-limited and MIME-restricted.
```

The bucket now genuinely exists in DEV, private, 25MB-capped, PDF-only, exactly as
AIE-1.1 specified. (Left in place — it is additive infrastructure, not synthetic test
residue, matching the same "create the bucket" instruction given to AIE-1.1 itself.)

**Feature-flag defaults** — confirmed by reading `lib/aie/featureFlags.ts`,
`lib/aie/adapters/insurance/featureFlags.ts`: every flag
(`AIE_DOCUMENT_INTAKE_ENABLED`, `AIE_AI_FALLBACK_ENABLED`,
`AIE_ALLOW_MISSING_SIGNATURE_SCANNER`, `AIE_INSURANCE_ADAPTER_ENABLED`,
`AIE_INSURANCE_ADAPTER_CANONICAL_WRITE_ENABLED`) requires the literal string `'true'`
and defaults OFF for anything else (unset included). No production Amplify environment
variable was touched, read, or even visible from this sandbox — per `DEPLOYMENT.md`
this project is deployed via AWS Amplify with no console access available here, so "DEV
environment configuration" in practice means the local `.env.local` used by a
locally-run `next dev`, which is what was used for the (blocked) journey attempt below.

---

## 2. Cross-tenant RLS proof — PARTIAL: the METHOD is proven live; the AIE-specific
   tables cannot be, because they don't exist yet

Since `aie_document_intake`/`aie_unresolved_item`/`aie_review_decision`/
`aie_mask_token_map` don't exist in DEV (section 1), there is nothing to attack on
those specific tables. This is exactly the gap AIE-1.6's own certification report
named explicitly: *"I did not attempt a live cross-tenant access test (no database
exists to attack)... both remain paper/structural."* That sentence remains true today
for the AIE tables specifically, for the same reason.

What this pass DID do for real: proved the **negative-control discipline itself** is
sound, live, using two real disposable synthetic users against an **existing**
RLS-protected table (`households`, migration `0001`) whose policy is
`auth.uid() = user_id` — structurally identical in shape to the policies written for
the AIE-1 tables in `0140_aie1_1_shared_document_gateway.sql`. Script:
`scripts/aie1_live_dev_rls_method_proof.mjs` (new, committed with this report).

Real output:

```
[PASS] SETUP-1 -- Tenant A created via admin.auth.admin createUser + real password sign-in
        {"id":"69ca16dd-...","email":"aie1-livedev-A-1789165023826@fhip-test.invalid"}
[PASS] SETUP-2 -- Tenant B created via admin.auth.admin createUser + real password sign-in
        {"id":"f20d9950-...","email":"aie1-livedev-B-1789165023826@fhip-test.invalid"}
[PASS] SETUP-3 -- Tenant A inserts own households row as themself (RLS with-check passes for own user_id)
        {"status":201,"id":"a665b385-b54b-4142-8805-2b6391993174"}
[PASS] POSITIVE-CONTROL -- Tenant A reads their OWN household row via their own JWT -- must return exactly 1 row
        {"status":200,"rows":[{"id":"a665b385-...","user_id":"69ca16dd-...","household_name":"AIE1 livedev RLS proof 1789165023826"}]}
[PASS] NEGATIVE-CONTROL-READ -- Tenant B attempts to read Tenant A's household row via Tenant B's own JWT -- must return zero rows
        {"status":200,"rows":[]}
[PASS] NEGATIVE-CONTROL-WRITE -- Tenant B attempts to UPDATE Tenant A's household row via Tenant B's own JWT -- must affect zero rows
        {"status":200,"rows":[]}
[PASS] NEGATIVE-CONTROL-WRITE-VERIFY -- Service-role read confirms the row content is unchanged after the blocked cross-tenant write attempt
        [{"household_name":"AIE1 livedev RLS proof 1789165023826"}]

=== 13/13 PASS ===
```

Discipline followed exactly as required: the **positive control ran first** (Tenant A
reading their own real row, over PostgREST, using their own real JWT, not the
service-role client) and passed, which is what makes the subsequent empty result from
Tenant B meaningful rather than coincidental — an empty result from a broken client
would have looked identical to a correctly-enforced RLS policy, which is precisely the
"returns empty by coincidence" failure mode this pass was told to rule out. Both a
cross-tenant READ and a cross-tenant WRITE were attempted (not just a read), and the
WRITE's failure was independently re-verified with a service-role read showing the row's
content was genuinely unchanged, not just that the PostgREST response had 0 rows.

**What this proves**: the general RLS-enforcement mechanism (Supabase Auth JWT →
PostgREST → `auth.uid() = user_id` policy) genuinely works end-to-end against this real
DEV project, for a same-shaped policy.
**What this does NOT prove**: that the specific 16 policies written across
`0140`-`0145` for the AIE tables are themselves free of a mistake (e.g. a policy that
checks the wrong column, or a table with RLS accidentally left disabled). That
specific proof requires the migrations to be applied first (section 1) and must be
re-run once they are — `scripts/aie1_live_dev_rls_method_proof.mjs` is written
generically enough that extending it to the four `aie_*` tables once they exist is a
small, mechanical change (create an intake row as Tenant A instead of a household row;
everything else — positive/negative-control structure, cleanup, residue re-verification
— carries over unchanged).

---

## 3. Real end-to-end Insurance journey — BLOCKED (same root cause as section 1)

Read `app/api/aie/intake/route.ts` in full to determine precisely where in the request
path a real HTTP call would fail. Its very first side effect after auth/flag/validation
checks is:

```ts
const rlsClient = await createClient();
const created = await createIntake(rlsClient, { userId: user.id, ... });
if ('error' in created) return bad('could not create intake', 500);
```

`createIntake` writes to `aie_document_intake` — the table that does not exist in DEV
(section 1). This happens **before** `validateUploadForAdmission` (the hostile-PDF
check, section 4) ever runs. So a real HTTP round trip against this route today would
deterministically return `500 "could not create intake"` regardless of whether the
uploaded PDF is benign, hostile, or garbage — a result that would prove nothing about
the actual pipeline and would misrepresent a schema-missing error as a pipeline result
if reported as a "negative control." Rather than fabricate a misleading result, this
was not run against a live HTTP call.

A real `next dev` server WAS started against this exact `.env.local` (real DEV project,
real feature flags set to `'true'`) to confirm the app itself boots cleanly with this
environment (`✓ Ready in 1067ms`, Next.js 16.2.12/Turbopack, zero startup errors), but
this sandbox's background-process lifecycle did not keep the server alive long enough
across tool-call boundaries to complete a reliable HTTP round trip before the process
was torn down — a genuine environment constraint of this specific sandbox, not a code
issue. Given the deterministic 500 established above, chasing a persistent server
further would not have added confirmatory value: the actual blocker is the missing
schema, not server availability.

**Also blocked for the same reason**: masked-AI-fallback non-firing confirmation,
reconciliation, `/api/aie/review/*` decision states, and the real canonical write into
`insurance_policies` — every one of these depends on `aie_document_intake`/
`aie_unresolved_item`/`aie_review_decision` rows that cannot be created until the
migrations are applied.

**What already exists and was not re-run** (no new value from re-running it here):
`tests/unit/aieReviewE2eInsuranceJourney.test.ts` and
`tests/unit/aieInsuranceAdapterOrchestratorIntegration.test.ts` already exercise this
exact journey in-process against `MockAieProvider` and an in-memory repository —
confirmed still 284/284 passing across all 32 `tests/unit/aie*.test.ts` files as part
of this pass (see section 5). That is unit-level proof, already claimed as such by
AIE-1.5; it is not, and was never presented here as, the real-infrastructure proof this
report set out to produce.

---

## 4. Hostile-PDF-against-real-infrastructure — BLOCKED (same root cause), but a
   real defect was found and fixed while investigating it

Attempting this check required first confirming the adversarial fixture and its
regression test were still accurate. They were not.

### 4a. The defect found

`tests/unit/aie16CertificationAdversarialPdf.test.ts` (an AIE-1.6 certification
artifact, predating `fix/aie-1-1-pdf-flatedecode-detection` commit `1afceec`) still
asserted the **pre-fix, vulnerable** behaviour: that a `/JavaScript` action hidden
inside a `/FlateDecode`-compressed PDF stream was NOT caught (`result.suspicious` ===
`false`) and was admitted (`admission.ok` === `true`). The fix commit changed
`lib/aie/validation/fileValidation.ts` and added new tests to
`tests/unit/aieFileValidation.test.ts`, but never touched this older file — leaving it
silently asserting behaviour the code no longer has.

Confirmed by actually running it against the merged release-candidate branch:

```
$ npx vitest run tests/unit/aie16CertificationAdversarialPdf.test.ts
 FAIL  ...CONFIRMS the disclosed gap...
 AssertionError: expected true to be false
   - false
   + true
 Tests  1 failed | 1 passed (2)
```

This is a real, currently-failing test on `integration/aie-1-release-candidate` as
merged — i.e. this branch's own test suite is not actually green if run in full,
contrary to what a file-count/branch-name summary alone would suggest.

### 4b. The fix

Updated `tests/unit/aie16CertificationAdversarialPdf.test.ts` to assert the CURRENT,
correct (fixed) behaviour instead of the pre-fix one: the same exact adversarial
FlateDecode-wrapped `/JavaScript` fixture must now be flagged `suspicious: true` with
reason `embedded_javascript`, and `validateUploadForAdmission` must now reject it
(`admission.ok === false`). Added a header note explaining why the file changed, so it
now does its intended job — a permanent regression guard proving the fix holds — instead
of silently documenting stale, incorrect behaviour. No production code was touched;
`lib/aie/validation/fileValidation.ts`'s fix itself was already correct.

Verified:
```
$ npx vitest run tests/unit/aie16CertificationAdversarialPdf.test.ts
 Test Files  1 passed (1)
      Tests  2 passed (2)

$ npx vitest run tests/unit/aie*.test.ts
 Test Files  32 passed (32)
      Tests  284 passed (284)

$ npx tsc --noEmit        # zero new errors
$ npx eslint tests/unit/aie16CertificationAdversarialPdf.test.ts   # zero errors/warnings
```

### 4c. Why the "against real infrastructure" part is still blocked

With the test itself now correct, the remaining ask — running the SAME hostile bytes
through the real `/api/aie/intake` route against real DEV infrastructure — hits the
identical wall as section 3: `createIntake` fails first because `aie_document_intake`
doesn't exist, before `validateUploadForAdmission` is ever reached. So the fix's
in-process correctness is now confirmed (again) by a real, passing, non-stale unit
test, but "rejected by the real route running against real DEV infrastructure"
specifically cannot be demonstrated until the migrations are applied (section 1).

---

## 5. Cleanup and residue proof

Everything created against the DEV database or Auth system by this pass was synthetic
and disposable, and was fully removed, then independently re-verified as gone (not
just trusting the delete call's own success response):

```
--- cleanup ---
[PASS] CLEANUP-HOUSEHOLD -- deleted synthetic household a665b385-... (204)
[PASS] CLEANUP-USER -- deleted synthetic user 69ca16dd-... (200)
[PASS] CLEANUP-USER -- deleted synthetic user f20d9950-... (200)

--- independent residue re-verification (re-query, do not trust the delete responses) ---
[PASS] RESIDUE-CHECK-HOUSEHOLD -- household a665b385-... must be genuinely gone -> []
[PASS] RESIDUE-CHECK-USER -- user 69ca16dd-... must be genuinely gone
        {"status":404,"text":"{\"code\":404,\"error_code\":\"user_not_found\"...}"}
[PASS] RESIDUE-CHECK-USER -- user f20d9950-... must be genuinely gone
        {"status":404,"text":"{\"code\":404,\"error_code\":\"user_not_found\"...}"}
```

Additionally, after the script's own cleanup, this pass separately re-queried DEV once
more, independently, outside the script:
- Listed up to 200 DEV auth users and filtered for the `aie1-livedev` email pattern —
  **0 matches** remaining.
- Queried `households` for `household_name ilike '*AIE1*'` — **`[]`**, zero rows.

No document, no `aie_*` row (none could be created — see section 1), and no synthetic
storage object was left behind. The `aie-document-quarantine` bucket itself was
deliberately **left in place** (it is real, additive infrastructure that AIE-1.1
specified should exist, not synthetic test residue — see section 1c) and is currently
empty (nothing was ever uploaded to it, since the journey in section 3 never reached
the upload step).

Local, non-committed artifacts used only to run this pass — a `.env.local` (DEV
credentials only, never the `PRODUCTION_`-prefixed ones) and `.claude/launch.json` in
this worktree — are both git-ignored (`.gitignore` lines 19 and 35) and were not
committed; no secret value appears anywhere in this report, in git history, or in any
committed file.

---

## 6. What genuinely could not be verified in this environment, and why

Stated precisely, per phase, matching this programme's own established honesty
standard rather than downgrading a real FAIL to softer language:

1. **Migrations `0140`-`0145` applied to DEV** — NOT DONE. No DDL execution path
   exists in this sandbox (no `exec_sql`-style RPC, no Management API token, no direct
   Postgres connection string, no authenticated `supabase` CLI session). A human with
   the DEV project's DB password (or a scoped Management API PAT) needs to run
   `supabase db push` or paste the six migration files into the Supabase Studio SQL
   editor. Everything below follows from this.
2. **Cross-tenant RLS proof on the AIE-1 tables specifically** — NOT DONE (tables don't
   exist). The negative-control METHOD itself was proven live and sound against a
   structurally identical existing table (section 2); re-run
   `scripts/aie1_live_dev_rls_method_proof.mjs`'s pattern against `aie_document_intake`
   etc. once migrations are applied.
3. **Real end-to-end Insurance journey (upload → quarantine → masking → reconciliation
   → review → accept → canonical write)** — NOT DONE against real infrastructure, for
   the same reason. The in-process/mocked version already exists and still passes
   (284/284 across all AIE unit tests as of this pass).
4. **Hostile PDF rejected by the real `/api/aie/intake` route** — NOT DONE against real
   infrastructure, for the same reason. The underlying fix's correctness at the
   function level was re-confirmed live in this pass, and a real stale-test defect in
   its own regression guard was found and fixed (section 4).
5. **A persistent local dev server for a real HTTP round trip** — attempted; Next.js
   started cleanly against the real DEV `.env.local` and real feature flags
   (`✓ Ready in 1067ms`), but this sandbox does not keep a backgrounded long-running
   server process alive reliably across tool-call boundaries, so a full HTTP round trip
   was not completed. Given finding (1) makes the result deterministic and uninteresting
   (a 500 regardless of PDF content), this was not pursued further.
6. Sections 5 ("Real AI provider integration test") and 6 ("Retention/purge job") of
   `AIE_1_PRODUCTION_CERTIFICATION_PLAN.md` were explicitly out of scope for this pass
   per the dispatch instructions and were not attempted.

## 7. Genuine defect found and fixed in this pass

- **File**: `tests/unit/aie16CertificationAdversarialPdf.test.ts`
- **What was wrong**: asserted the pre-fix (vulnerable) behaviour of `scanPdfStructure`
  for a FlateDecode-hidden `/JavaScript` action; genuinely failed
  (`expected true to be false`) when run against the current, already-fixed
  `lib/aie/validation/fileValidation.ts`.
- **Fix**: updated the test's assertions and narrative to the current, correct, fixed
  behaviour (now a regression guard, not a stale vulnerability record).
- **Verification**: 2/2 in the file, 284/284 across all `tests/unit/aie*.test.ts`,
  `tsc --noEmit` clean, `eslint` clean.
- **No production code changed** — only the stale test.

## Files touched by this pass (all committed on `integration/aie-1-release-candidate`)

- `tests/unit/aie16CertificationAdversarialPdf.test.ts` — fixed stale assertions (section 4/7).
- `scripts/aie1_live_dev_rls_method_proof.mjs` — new; real cross-tenant RLS method proof with full cleanup (section 2).
- `docs/aie-programme/AIE_1_LIVE_DEV_VERIFICATION_REPORT.md` — this report.

Not committed (git-ignored, DEV-only, no secrets in git history): `.env.local`,
`.claude/launch.json`.

Real, live DEV-project side effects left in place after this pass: the
`aie-document-quarantine` Storage bucket (private, empty, 25MB cap, PDF-only) — created
per section 1c, not test residue. No other DEV state was changed; all synthetic users
and rows created during testing were deleted and independently confirmed gone
(section 5).
