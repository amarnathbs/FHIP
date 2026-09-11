# AIE-1.1 — Shared Document Preprocessing, Masking & JSON-Schema Gateway

**Status: IMPLEMENTED and TESTED on a feature branch, NOT certified, NOT merged, NOT deployed.**
This report describes what was built in this pass. It is not a certification —
AIE-1.1's own source document requires independent verification and
traceability across all 332 numbered requirements for a FULL PASS, and real
certification of the whole AIE-1 platform is explicitly AIE-1.6's job, not
this one. Nothing here should be read as "AIE-1.1 complete" — see "What
remains" below.

Branch: `feature/aie-1-1-document-gateway` (off `origin/main`, NOT
`feature/lr-1-upload-security-lifecycle`, which has unrelated in-flight
work from a parallel session).

## 1. Discovery — what already existed, what was reused, what is net-new

Full inventory (file:line citations) was produced before any design work,
per AIE-1.1's own mandated sequence ("inventory current upload/document/AI/
schema/audit foundations and reuse safe components"). Summary:

### Reused directly (pattern or technique, cited in code comments)
- **`lib/financial-data-hub/domain/fileValidation.ts`** (FDH-3) — magic-byte/
  MIME/size/hash validation technique. `lib/aie/validation/fileValidation.ts`
  re-implements the identical dependency-free technique, generalised to an
  injectable allowlist (FDH-3's is locked to its own two-type allowlist).
- **`lib/financial-data-hub/domain/documentLifecycle.ts`** — the "declare
  every legal edge once, enforce server-side" state-machine pattern.
  `lib/aie/stateMachine.ts` follows it exactly.
- **`lib/financial-data-hub/services/storage.ts`** / **`services/auditLog.ts`**
  — the "one service-role-only file per concern, RLS SELECT-only for
  everyone else" discipline. `lib/aie/storage.ts` and `lib/aie/audit.ts`
  follow it exactly, including the three-part storage-bucket pattern (private
  bucket + SELECT-only RLS + one service-role module).
- **`lib/financial-data-hub/bank-pdf/textExtraction.ts`** / **`lib/services/
  investment-intelligence/pdfExtraction.ts`** — `pdf-parse` is already a
  dependency; `lib/aie/extraction/textExtraction.ts` is a third, domain-
  neutral thin wrapper using the identical password/corrupt/insufficient-
  text disambiguation technique. NO new PDF library was introduced.
- **`lib/financial-data-hub/payslip/privacy.ts`** (`SENSITIVE_PATTERNS`,
  `FORBIDDEN_LABEL_TERMS`) and **`lib/services/investment-intelligence/
  parsers/textUtils.ts`** (`maskPan`) — carried over verbatim in substance
  into `lib/aie/masking/piiMasking.ts`'s generic, domain-agnostic engine.
  Neither original file was modified or replaced; their existing call sites
  are untouched.
- **`lib/ai/providers/types.ts`**'s `ProviderError`/`ProviderErrorCode`/
  `ProviderHealth`/`CostEstimate` — imported and reused as-is (they are
  fully generic, no Module-11-specific coupling).

### Deliberately NOT reused, with reasons disclosed in code
- **`lib/ai/gateway/aiModelGateway.ts`** (`AIModelGateway`) and
  `AIGenerateRequest`/`AIProvider` — locked to Module 11's own `AITaskType`
  union and `responseSchema: 'ai_response_envelope'` literal. AIE-1.1 needs
  its own choke point per its own spec (GW section: "one typed internal
  extraction operation"), so `lib/aie/provider/gateway.ts` /
  `lib/aie/provider/types.ts` define AIE's own request/result shape,
  structurally modelled on Module 11's but independent.
- **`ajv`** — AIE-1.1's spec says "JSON Schema" throughout, but this
  codebase has zero `ajv` usage anywhere; Zod is the sole schema library in
  use. `lib/aie/schema/schemaRegistry.ts` is Zod-based (see its own header
  for the full reasoning) rather than introducing a new dependency to match
  the spec's literal noun. This is a disclosed, deliberate deviation — the
  substance (published/versioned/immutable schemas, reject-unknown-keys,
  typed rejection codes) is fully implemented.

### Confirmed missing — built net-new this pass
- Malware/AV signature scanning (FDH-3's own threat model already discloses
  this gap; still true here — see "Honest limitations" below).
- A document quarantine table/workflow (`aie_document_intake` +
  `aie_document_fingerprint` + the `aie-document-quarantine` storage bucket
  and RLS policy).
- A generic, cross-domain JSON Schema/validation gateway
  (`lib/aie/schema/schemaRegistry.ts`).
- A generic, domain-agnostic PII masking engine
  (`lib/aie/masking/piiMasking.ts`).
- A cross-domain document classifier/parser registry
  (`lib/aie/classifier/registry.ts`) — existing per-domain registries
  (bank-csv, bank-pdf, liability, retirement, investment adapters) are
  untouched; a future AIE-1.3 is expected to wrap them behind this
  interface, not discard them.
- Global-shape fingerprint/dedup persistence (existing FDH dedup is scoped
  `(user_id, file_hash)` only, same scoping decision kept here — see
  DUP-03's own "scope by tenant/user" requirement).

## 2. What was built

- **Migration** `supabase/migrations/0140_aie1_1_shared_document_gateway.sql`
  — 15 tables (`aie_document_intake`, `aie_document_fingerprint`,
  `aie_extraction_run`, `aie_processing_transition`, `aie_parser_attempt`,
  `aie_masking_summary`, `aie_mask_token_map`, `aie_ai_completion_attempt`,
  `aie_schema_validation_result`, `aie_field_candidate`,
  `aie_reconciliation_run`, `aie_unresolved_item`, `aie_review_decision`,
  `aie_audit_event`, `aie_write_batch`), full RLS, a shared cross-tenant
  integrity trigger (`aie_assert_child_owner`, mirroring FDH-3's own
  trigger precedent), and the quarantine bucket's storage RLS policy.
  **HELD LOCALLY. Not applied to any DEV or production database.**
  Numbered `0140` (main's highest is `0137`; `0138`/`0139` are already
  claimed on the separate, unmerged `feature/lr-1-upload-security-lifecycle`
  branch — confirmed by fetching that branch directly, not guesswork).
  Both `npm run check:migrations` and a manual cross-branch check against
  that branch pass clean (see verification evidence below).
- **`lib/aie/`** — types, state machine, admission/structural validation,
  fingerprinting, PII masking + reversible-token-map encryption, the JSON
  Schema (Zod) registry, the AI provider abstraction/mock/gateway, the
  classifier registry, the reconciliation handoff contract, the DB
  repository, the audit trail, feature flags, PDF text extraction, storage,
  and the orchestrator tying every stage together.
- **`app/api/aie/`** — `POST /intake` (the full admission → quarantine →
  validation → local extraction → fingerprint → deterministic parser →
  masking → gated AI fallback → schema validation → reconciliation handoff
  pipeline in one server-mediated request, matching the existing
  `bank-pdf/upload` route's own pattern), `GET /intake/{id}` (privacy-safe
  status), `GET /unresolved-items` (diagnostic listing only — the real
  reviewer UI is explicitly AIE-1.5's job).
- **`scripts/aie1_1_create_storage_bucket.mjs`** — written, NOT run (no
  DEV/production authority granted this pass).
- **62 new unit tests** across 7 files (`tests/unit/aie*.test.ts`) — state
  machine (legal/illegal transitions), admission/structural validation
  (adversarial PDF fixtures: embedded JS, launch actions, polyglot trailing
  content), PII masking (recall on seeded canaries, precision against
  non-PII figures, cross-call token non-correlation), fingerprinting/
  duplicate classification, the schema registry (malformed JSON, unknown
  properties, missing source references, immutability), the AI gateway
  (kill switch, unmasked-PII refusal, schema rejection, provider-error
  mapping without leaking raw errors, idempotent collapse of concurrent
  identical calls), and the orchestrator (deterministic-complete path with
  zero AI calls, deterministic-partial path with a PII canary proven absent
  from the "provider"-seen payload, kill-switch-blocked fallback, FAIL/
  INDETERMINATE reconciliation always producing a blocking unresolved item,
  schema-rejected AI output never contaminating candidates).

## 3. Verification evidence actually run and observed

- `npx tsc --noEmit` — **zero new errors**. The only errors present
  (razorpay/stripe/xlsx/@electric-sql/pglite module-not-found) are
  pre-existing, confirmed identical before and after this branch's changes
  (missing optional npm packages in this environment, unrelated to AIE).
- `npx eslint lib/aie app/api/aie` — **zero errors, zero warnings** (two
  trivial unused-var warnings were found and fixed during this pass).
- `npx vitest run tests/unit/aie*.test.ts` — **62/62 passed**, 7/7 files.
- `npx vitest run` (full suite) — **6374 passed**, 18 skipped, 18 failed —
  **all 18 failures confirmed pre-existing** (missing razorpay/stripe/xlsx/
  pglite packages; `resources*LiveDev` tests requiring real Supabase
  credentials; one unrelated pre-existing `countryGateAccessMatrix` failure
  confirmed present on `origin/main` before this branch's changes via
  `git stash`). Two REAL regressions this branch's new code caused were
  found and fixed in this same pass, not swept under the rug:
  - `tests/unit/appCapabilityManifest.test.ts` required every
    `app/api/*` top-level folder to be mapped to a module or the infra
    allowlist — `aie` added to the documented infra allowlist (it is
    explicitly cross-cutting shared infrastructure, not owned by one
    financial module — that is the whole point of the architecture).
  - `tests/unit/fdh1Isolation.test.ts` does a naive substring search for
    the literal text `"financial-data-hub"` across the whole repo (its own
    documented, known limitation — it cannot distinguish a real import from
    a comment mentioning the string) and flagged 10 AIE files whose header
    comments explain the REUSE DECISIONS above by naming existing FDH
    files. Confirmed by `grep -rn "from '@/lib/financial-data-hub" lib/aie
    app/api/aie` (zero matches — no AIE file actually imports FDH code).
    Added to `FDH_APPROVED_CONSUMER_FILES` with the same documented,
    per-file exception pattern this test already uses for five prior,
    identical false positives (LR-3/LR-8/LR-9 and others).
- `npx node scripts/check-migration-versions.mjs` — OK, 133 active
  migrations, next version 0141.
- `npx node scripts/check-migration-versions-against-branch.mjs
  --against=origin/main` — OK, no collision.
- `npx node scripts/check-migration-versions-against-branch.mjs
  --against=origin/feature/lr-1-upload-security-lifecycle` — OK, no
  collision (this is the one that actually mattered, given that branch's
  own `0138`/`0139`).
- **`next build`** — attempted, **could not complete**: this worktree has
  no local `node_modules` (module resolution falls through to the parent
  checkout's `D:\FHIP\node_modules`, which is why `tsc`/`eslint`/`vitest`
  all work fine), and Next.js 16's Turbopack build refuses to run with a
  symlinked/junctioned `node_modules` pointing outside its sandboxed
  filesystem root (`"Symlink [project]/node_modules is invalid, it points
  out of the filesystem root"`) — confirmed to be a genuine tool/
  environment limitation of this specific worktree setup, not a code
  defect, and left disclosed rather than worked around by copying
  `node_modules` wholesale into the worktree. **Build was not verified to
  complete in this pass.**

## 4. Honest limitations / deferred work

- **No malware/AV signature scanner.** `lib/aie/validation/fileValidation.ts`'s
  `scanForMalwareSignatures()` is an explicit, disclosed fail-closed stub
  (matches FDH-3's own already-disclosed identical gap). What IS
  implemented for real: PDF-structural heuristics (embedded JavaScript,
  launch actions, embedded files, auto-open actions, polyglot trailing
  content after `%%EOF`) — these catch a real, meaningful class of threat
  a signature engine alone would not, but are not a substitute for one.
- **No page/table-artifact persistence** (`SourceArtifact`/`PageArtifact`/
  `TableArtifact` from the spec's 18-entity model are not built this pass
  — extraction runs operate on already-extracted text held in memory for
  the duration of one request, not a separately persisted per-page/table
  row). Recorded explicitly in the migration's own header as a deferred
  entity mapping.
- **`RetentionDisposition` folded into `aie_document_intake`** (not a
  separate table) — a disclosed simplification, not a silent one.
- **No retention/purge sweep job** — FDH-3's own janitor pattern
  (`purge.ts` + the LR-1 cron migration) was not reproduced for AIE this
  pass; documents sit in `quarantined`/`ready` state indefinitely until a
  future pass adds one.
- **No repair-retry policy for a schema-rejected AI response** — the
  orchestrator proceeds straight to reconciliation on the first schema
  rejection rather than attempting a bounded repair, matching the spec's
  own "at most" ceiling by choosing zero rather than inventing an unreviewed
  repair heuristic.
- **The masking-policy block (`isBelowMaskingPolicy`) is not fully wired**
  — the orchestrator currently always passes an empty `labelsSeenRaw` array
  (no deterministic parser this pass extracts and reports raw field labels
  separately from values), so the "forbidden label seen raw" block path
  exists and is tested in isolation but is not yet reachable end-to-end
  from the orchestrator. A real domain adapter (1.2/1.3) is expected to
  supply real labels.
- **AIE-1.1 ships no domain adapter** (by design — that's 1.2/1.3/1.4).
  `noDomainAdapterReconciliationRule` is an explicit placeholder returning
  NOT_APPLICABLE; no parser is registered against `aieParserRegistry` in
  production code (only in tests), so every real document today reaches
  `deterministic_partial` outcome with zero AI-eligible gaps unless/until a
  future adapter registers one.
- **No real AI provider integration.** Only `MockAieProvider` exists. A
  real provider (e.g. wrapping `lib/ai/providers/openaiProvider.ts`'s
  technique) is explicitly out of scope — no live provider traffic occurs
  anywhere in this pass, and the kill switch (`AIE_AI_FALLBACK_ENABLED`)
  defaults OFF regardless.
- **No AIE-1.0 artifact found in this repository.** All six source
  documents treat "AIE-1.0" (approved architecture/privacy contract: ADRs,
  threat model, privacy classification, retention schedule, PC5 contract,
  PC6 exclusion) as an already-existing prerequisite. None exists under
  that name in this repo. This pass substituted this codebase's own
  already-established PC5/PC6 conventions (per project memory) and this
  document + `AIE_1_MASTER_PLAN.md`'s own principles table as the working
  equivalent — flagged in the master plan as an open item for the Product
  Owner before AIE-1.2 starts.
- **`AIE_MASK_TOKEN_ENCRYPTION_KEY` does not exist in any environment.**
  `lib/aie/masking/tokenMapCrypto.ts` throws a clear, actionable error if a
  mask-token-map row is ever attempted without it — a genuine prerequisite
  for live use, not silently assumed present.

## 5. Non-negotiable prohibitions — self-check (not a certification)

Every prohibition in AIE-1.1 section 4 was designed against explicitly;
spot-checked here, not independently re-verified (that is AIE-1.6's job):

| Prohibition | Where enforced |
|---|---|
| No raw/unmasked content to an external AI provider | `lib/aie/provider/gateway.ts`'s `containsUnmaskedPii` re-scan runs immediately before every payload is built, independent of the caller's own masking |
| No adapter/browser route calls a provider directly | `AieDocumentAiGateway` is the only class that touches `AieAiProvider`; no other file imports `lib/aie/provider/types` provider-calling surface |
| No provider output bypasses schema validation | `gateway.ts`'s `executeOnce` always calls `validateAiOutput` before returning `success` |
| No confidence score bypasses reconciliation | No `confidence` field exists anywhere in `lib/aie/reconciliation/types.ts`'s signatures by construction |
| No user-controlled tenant/owner/processing-state/provider/schema/destination authority | Every status transition goes through the service-role repository after RLS-verified ownership; `aie_document_intake`/every child table has no authenticated UPDATE/DELETE policy |
| No direct AIE core write to canonical financial tables | `aie_write_batch` is a scaffold only; the orchestrator never imports or calls any Investment Intelligence/FDH canonical-write service |
| No second exception system | `aie_unresolved_item` is the only such table this migration creates; no competing table was added anywhere else |
| No PC6 usage inside document acceptance | Zero imports of any PC6/pricing/NAV/benchmark module anywhere in `lib/aie/**` |
| No production migration/provider traffic without separate authority | Migration held locally; `AIE_AI_FALLBACK_ENABLED`/`AIE_DOCUMENT_INTAKE_ENABLED` both default OFF; bucket-creation script written but not run |
| No raw provider error/document content/prompt/PII in logs | `lib/aie/audit.ts`'s `metadata` is always a closed, structured object; `gateway.ts` never returns a raw `ProviderError.message` to its caller |

## 6. What this means for AIE-1.2/1.3/1.4/1.5

The downstream contract AIE-1.1's own spec requires it to expose is in
place: the adapter interfaces (`lib/aie/classifier/registry.ts`), the sole
provider gateway (`lib/aie/provider/gateway.ts`), the reconciliation
handoff shape (`lib/aie/reconciliation/types.ts`), and the single
unresolved-item persistence system (`aie_unresolved_item` +
`lib/aie/db/repository.ts`'s decision service) all exist and are exercised
by real tests. A future AIE-1.2/1.3 adapter is expected to: register a real
`RegisteredParser`, supply a real `ReconciliationRule`, and consume
`aie_unresolved_item`/`aie_review_decision` — not build any of those from
scratch.
