# Market Index Data - Admin capabilities and Standard compliance

Applies: `docs/admin/FHIP_ADMIN_ARCHITECTURE_STANDARD.md` v1.0 (read in full before this work). Surface: Admin > Market Index Data (`/admin/investment-intelligence/market-index-data`, alias `/benchmark-data`). Future-review owner: Product Owner. Exceptions requested under section 16: **none**.

## 1. Capabilities affected (six, separately named; none implies another)

| Capability | Column (`admin_users`) | DB predicate | API guard key | UI visibility |
|---|---|---|---|---|
| View (read-only) | `can_view_reference_data_quality` (PC6) **or** any column below | `is_benchmark_data_viewer()` | `view` | nav group + tabs |
| Upload (stage + validate) | `can_upload_market_index_data` (0232) | `is_market_index_data_admin()` | `upload` | Upload tab, cancel own job |
| Publish new history | `can_publish_benchmark_data` (0241) | `is_benchmark_publisher()` | `publish` | Publish action on new-history jobs |
| Correct / roll back | `can_correct_benchmark_data` (0241) | `is_benchmark_corrector()` | `correct` | Correction mode, publish correction, rollback |
| Catalogue, mappings, draft entitlements, ingestion mode | `can_manage_benchmark_catalogue` (0241) | `is_benchmark_catalogue_admin()` | `catalogue` | Catalogue/Mappings/Entitlements(propose)/Ingestion tabs |
| Approve / revoke entitlements | `can_approve_benchmark_entitlements` (0241) | `is_benchmark_entitlement_approver()` | `entitlementApprove` | Approve/Revoke actions |

`view` is the only union and it is read access only. The 0241 migration grants no capability to anyone; each grant is a deliberate PO action. Roles are multi-role by union (section 3); Analyst remains read-only and has no benchmark capability (section 5).

## 2. Route / RPC gating

| Route (under `/api/admin/investment-intelligence/benchmark-data/`) | Capability | Database enforcement |
|---|---|---|
| `GET overview`, `jobs`, `jobs/[id]`, `jobs/[id]/errors`, `templates/[name]`, `help`, `catalogue`, `entitlements`, `mappings` | view | RLS on every table via `is_benchmark_data_viewer()` |
| `POST upload`, `upload/inspect` | upload | `create_benchmark_import_job`, `stage_benchmark_import_rows`, `finalize_benchmark_import_job` check `auth.uid()` + `is_market_index_data_admin()` and that the caller owns the job |
| `POST jobs/[id]/publish` | publish (new history) / correct (correction), by the job's mode | `publish_benchmark_import` checks the mode-specific predicate, entitlement, checksum, digest, counts, current series; separation of duties (self-publish needs explicit acknowledgement) |
| `POST jobs/[id]/cancel` | upload, publish or correct | `cancel_benchmark_import_job` (staging admin or publisher/corrector) |
| `POST jobs/[id]/rollback` | correct | `rollback_benchmark_import` |
| `POST catalogue`, `catalogue/[id]/verify` | catalogue | `upsert_benchmark_catalogue_entry`, `verify_benchmark_catalogue_entry` |
| `POST entitlements` | catalogue | `propose_benchmark_entitlement` |
| `POST entitlements/[id]/approve|revoke` | entitlementApprove | `approve_benchmark_entitlement` (proposer approving own record needs explicit acknowledgement), `revoke_benchmark_entitlement` |
| `POST mappings`, `mappings/[id]/review` | catalogue | `propose_benchmark_mapping`, `review_benchmark_mapping` (auto-publish is service-role only) |
| `POST ingestion/[id]/mode` | catalogue | `set_benchmark_ingestion_mode` (automation also needs an approved automation entitlement) |
| `POST .../cron/benchmark-ingestion` | job secret (not an admin route) | service-role RPCs only; OFF by default |

Denial behaviour: unauthenticated 401, authenticated without the capability 403, malformed input 422, size 413, stale 409, never a 200 with an empty body; a missing migration is an explicit `unavailable`/503 state.

## 3. Standard clauses and proving tests

| Clause | How met | Tests |
|---|---|---|
| s2 capability-based access | six named capabilities, separately documented and tested | `tests/unit/benchmarkDataAdminRoutes.test.ts` capability MATRIX (every route x every capability, 217 tests); PGlite capability checks |
| s3 multi-role union | `view` union of reads only; each write capability separate | matrix + nav test |
| s4 navigation is not authorisation / four layers | DB predicates + RLS; API `requireBenchmarkCapability`; page `requireBenchmarkPage`; nav `adminNav.ts` | direct-API (matrix), direct-page redirect test, nav test, **database-bypass** PGlite checks (plain user / admin without capability / anon calling RPCs directly) |
| s5 least privilege / separation of duties | uploader cannot publish; publisher cannot publish corrections; corrector cannot publish new history; catalogue admin cannot approve entitlements; approver cannot propose; self-stage-and-publish and self-approve need explicit recorded acknowledgement | route tests (s5 block) + PGlite |
| s6 privileged RPC pattern | SECURITY DEFINER, `auth.uid()` inside, pinned `search_path`, fixed return types, no dynamic SQL, EXECUTE revoked from public/anon, explicit exception for unauthorised callers; consumer RPC `benchmark_entitled_actions` is aggregate-only booleans | PGlite grants + refusals |
| s7/s9 privacy and data boundary | all tables are global reference data with no tenancy and no user columns (a PGlite check asserts the demand table has none); API returns only `...ByMe` flags, never another admin's id | `jobs list never returns another admin identifier`; PGlite column check |
| s8 result states | `ok` / `unavailable` (migration absent) / explicit errors; data states `no_data`, `history_missing`, `stale`, `current`, `blocked_no_entitlement`; never a bare 0 | overview unavailable test; consumer tests |
| s11 exports | the only exports are the validation-error CSV and the static templates: purpose (fix and re-upload); roles = view; server generation; column allow-list; formula-injection neutralisation (`= + - @ TAB CR`); `no-store`, `nosniff`, non-identifying file name; authorisation at generation time (no stored link); negative tests | `s11 export` tests; `benchmarkDataFileErrorCsvTemplates.test.ts` |
| s12 metric certification | demand and watermark definitions in `demand.ts` / `ingestion/calendar.ts` headers and the runbook | `benchmarkDataIngestion.test.ts` |
| s13 safe failure | role-resolution error, missing column, RPC error, absent migration, unknown right all fail closed | fail-closed tests; entitlement unknown-right throws |
| s14 no scope expansion | one nav group, six capabilities, own routes/tests; the superseded India POST is answered 410 (same surface); `benchmark_datasets` governance untouched | static tests (no service-role client in any route) |
| s15 documentation | this file, the runbook, the release package; rollback = set the capability false / kill switches / apply-script rollback | - |

## 4. Rollback or disablement

Set the capability column false (per admin); keep the kill switches OFF (default); revoke entitlements; Jobs > Rollback for a publish; `scripts/bench1_phase2_po_apply_0241.sql` rollback block for the migration.
