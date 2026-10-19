# Premium AI for all eligible users: production proof report (19/10/2026)

Branch `feat/premium-ai-prod-proof-20261019` on `origin/main` 22db19b. Pack: `docs/ai/po_apply_premium_ai_production_proof/` (start at its `README.md`).
Evidence labels: UNIT-TESTED, PGLITE-VERIFIED, DEV-verified, PRODUCTION-VERIFIED, NOT PERFORMED, UNKNOWN. Nothing below is PRODUCTION-VERIFIED.

## 0. Corrections to the earlier report, applied

| # | Correction | What changed |
|---|---|---|
| 1 | Production configuration is UNKNOWN, not "disabled" | No flag value is stated or assumed anywhere. `Check-AmplifyAiConfig.ps1` and `sql/A01` to `A04` return it as booleans and presence; a refusal reason in the audit trail names any missing setting (`01_...` section 5) |
| 2 | A draft is not a complete journey | Journey 1 runs to review, acceptance **after** verified deletion, canonical rows, downstream screen and replay (`03_...`). DEV-verified end to end for the bank PDF |
| 3 | "Being prepared" proves only that a screen opens | Module 11 protocol defines "useful content" by reading the stored-answer table, and found that on the Module 11 branch 19 of 25 Standard questions show that placeholder until Insight Packs exist (finding M11-1) |
| 4 | Rollback does not stop everything, and the cap must survive | `06_ROLLBACK_PER_FEATURE.md`: per-feature controls; the cap, ledger and security controls are preserved; dropping the cap objects is explicitly **not** a routine rollback; a no-deploy stop (`sql/ops/O02a`) refuses all new AI spend while keeping every object |

## 1. What I did and did not touch

* No production access, no secrets printed, no user created with a password (the DEV rehearsal used passwordless synthetic users, deleted afterwards, residue re-counted: 0).
* **No application code changed.** Added: tests, scripts, the pack, one documentation fix (`ENVIRONMENT_VARIABLES.md`'s quoted forwarding line, which turns a pre-existing failing test green).
* I did not use the machine's stored AWS profile against production Amplify (the brief says no production credentials). It was used, as in earlier DEV missions, for the DEV scan bucket only.
* Module 11: read the integration branch tip `4e0f034` read-only through a sub-agent; nothing on it was edited.

## 2. Findings (new in this report)

| # | Finding | Severity | Where |
|---|---|---|---|
| F-1 | `FDH_DOCUMENT_UPLOAD_ENABLED` (the upload kill switch) is not forwarded by `amplify.yml`: a console value never reaches the server and the code treats anything but `false` as on. Uploads cannot be switched off from the console | Medium (rollback) | `01_...` s2, `06_...` |
| F-2 | If the per-user-cap code is live and migration 0284 is not on production, every AI reading is refused | High if unmet | `sql/A01` |
| F-3 | `AIE_AI_PROVIDER=mock` is honoured in any environment (a mistaken value in production would "succeed" with an empty reading). The proof detects it (no provider request id) | Low | `01_...` |
| F-4 | On DEV the delete of the temporary S3 scan copy was answered `access_denied` and recorded `verified: unverifiable`. The derivative copy of the uploaded document may therefore not be removed. Production permission UNKNOWN | Medium | `sql/E01`, `E09` |
| F-5 | **No active route for PDF liability, retirement or Australian investment statements** (CSV only; PDFs are refused with "try a CSV"). IMPLEMENTATION GAP G-1. Not implemented: it would reverse an explicit product statement and needs an accuracy corpus and a product decision | Gap | `02_...` s3 |
| F-6 | Deletion of the original happens at acceptance (PO decision 01/10/2026) or by the 50-minute backstop (worst case 55), so "deletion before acceptance" occurs only if the person waits about an hour. Protocol variant B does exactly that | Design reality | `03_...` s4 |
| F-7 | The global US$10 ceiling is a **lifetime** ledger with no reset; only an update of the stored column raises it (the setting can only lower it) | Info (it decides how long the feature can run) | `05_...` s1 |
| F-8 | The stale doc comments in the five `lib/aie/adapters/*/featureFlags.ts` still describe a shared pilot cohort | Trivial | `01_...` s4 |
| F-9 | Module 11 findings M11-1 to M11-12 (most important: stored answers need Insight Packs that the go-live scheduler-off decision never creates; a real pack's answer may never match a live figure; `custom_ai_enabled=false` is not "typed questions only"; a skipped person is parked for the month; internal certification routes open to Free users) | High to Medium | `module11/README.md` s8 |

## 3. Feature-by-feature table (document AI)

Deployed build: the live build is **at least `e9e6a87`** (public probe, 19/10/2026); the exact commit is **UNKNOWN** until you read the Amplify console. Premium enforcement is the same code for every row.

| Feature | Deployed build | Premium enforcement | Production configuration | Successful production execution | Free-user refusal | Cost / quota evidence | Remaining blockers |
|---|---|---|---|---|---|---|---|
| Bank statement PDF AI reading | UNKNOWN (>= `e9e6a87`) | In code on `main`: upload, retry and AI step each check an active Premium window, no cache, no role shortcut (UNIT-TESTED; DEV-verified) | UNKNOWN | **NOT PERFORMED** (DEV: 20 of 20, DEV-verified; the 01/10/2026 production attempt was refused by the old pilot list) | DEV-verified (upload 403, lapsed 'premium_required'); production NOT PERFORMED | DEV: settled US$0.000444 per reading, reservation released, replay free; PGlite arithmetic. Production NOT PERFORMED | Run Journey 1; confirm 0284 on production; confirm scan-copy purge (F-4) |
| Payslip PDF | UNKNOWN | same | UNKNOWN | NOT PERFORMED (DEV payslip draft equals the sheet, DEV-verified; confirm and canonical not re-run for this file) | production NOT PERFORMED | DEV one metered attempt | Journey 4.1 |
| Liability statement (CSV only) | UNKNOWN | same | UNKNOWN | NOT PERFORMED (DEV 14/10/2026 with equivalent fixtures; not re-run with these files) | NOT PERFORMED | DEV 14/10/2026: US$0.000482 | Journey 4.2. **PDF: no route (G-1)** |
| Retirement statement (CSV only) | UNKNOWN | same | UNKNOWN | NOT PERFORMED (same note) | NOT PERFORMED | DEV 14/10/2026: US$0.000668 | Journey 4.3. **PDF: no route (G-1)** |
| Australian investment statement (CSV only) | UNKNOWN | same | UNKNOWN | NOT PERFORMED (same note) | NOT PERFORMED | DEV 14/10/2026: US$0.000328 | Journey 4.4. **PDF: no route (G-1)** |
| Investment Intelligence statement (PDF) | UNKNOWN | same, through the II gate (UNIT-TESTED) | UNKNOWN | NOT PERFORMED, and **not rehearsed on DEV**: `ii_ai_extraction_reviews` (migration 0160) is absent on DEV; production state UNKNOWN | NOT PERFORMED | NOT PERFORMED | Apply and verify 0160 on DEV, rehearse, then Journey 4.5 |
| Customer upload admission (Premium-only) | UNKNOWN (>= `e9e6a87`, includes it) | Single shared capability; manual entry and Admin unaffected (UNIT-TESTED, 427 tests in the Premium suites) | n/a (no flag) | NOT PERFORMED | DEV-verified 403, no row, nothing scanned | n/a | R1 to R7; upload kill switch not operable (F-1) |
| Real malware scan and deletion | UNKNOWN | n/a | UNKNOWN | Earlier production evidence only (01/10/2026: scan clean in about 5 s). Not re-proved for this protocol | n/a | n/a | Scan-copy purge permission (F-4); `A03`/`A04` cleanup jobs |
| Per-user US$1/day cap and US$10 lifetime ceiling | Cap code in `main`; live build UNKNOWN | n/a | Values UNKNOWN (`sql/A02`) | NOT PERFORMED | n/a | DEV-verified (22 parallel requests: exactly 10 admitted; real-route refusals), PGLITE-VERIFIED | Confirm 0284 and the stored values on production; decide the ceiling for growth |

**Verdict, document AI: NOT YET PROVEN LIVE.** The code, the Premium rule, the refusals and the spending controls are UNIT-TESTED, PGLITE-VERIFIED and (bank, payslip, refusals, limits) DEV-verified. No production execution exists, the production configuration and build are UNKNOWN, the Investment Intelligence journey was not rehearsed, and three classes have no PDF route. The sentence "all implemented, release-ready AI features are live for eligible Premium users" **may not be used**. Excluded, with reasons: bank, payslip, liability, retirement, Australian investment and Investment Intelligence (no production execution); the PDF variants of liability, retirement and Australian investment (no route); Module 11 (below); not part of the claim and not activated: the diagnostic AIE intake routes and `/aie-review` inbox, the insurance adapter, the factsheet reader AI, Admin AI operations.

## 4. Module 11 (separate verdict)

Branch `integration/module11-0-to-11-7-20261014` tip `4e0f034`, local only, not merged, owned by another agent (not edited). Premium decided by the entitlement function; no pilot list; scheduler eligibility is entitlement-based with the window filter and keyset paging now present.

| Feature | Deployed build | Premium enforcement | Production configuration | Successful production execution | Free-user refusal | Cost / quota evidence | Remaining blockers |
|---|---|---|---|---|---|---|---|
| AI Coach (typed questions) | not on `main`; branch unmerged | `ai_entitlement_state` then `ai_admit_request` (read from code) | UNKNOWN; `MODULE11_*` and `OPENAI_API_KEY` not forwarded on `main` (branch adds it) | NOT PERFORMED | DEV-verified at service level only; browser NOT RUN | Branch claims only; ceilings in `ai_platform_controls` | Gates 1 to 7 below |
| Next Best Action | not on `main` | check in `nba/service.ts` (corrects the earlier note) | UNKNOWN | NOT PERFORMED | service level only | rules only, no provider cost | Premium and Free browser checklists |
| Insight Packs, Standard questions, Explain | not on `main` | same | scheduler OFF by decision | NOT PERFORMED | | | **M11-1/2**: stored answers exist only after packs; a real pack's answer may never match a live figure; unverified on DEV |

Remaining gates (from the branch, other agent's claims, not re-verified): v3 prompt pack on DEV **not recorded as applied** (DEV still v2); Premium browser checklist **NOT RUN**; Free browser checklist
**NOT RUN in a browser**; answer-tone review **NOT RUN by the PO**; Admin AI Operations browser proof waived since 01/10/2026, never performed; production precheck **NOT RUN**; final decision
**conditional pass, not ready for merge, production activation not authorized** (15/10/2026 wording). **Verdict, Module 11: NOT READY; not live.** Its blockers do not hold back document AI.

## 5. Verification summary

| What | Result |
|---|---|
| New suites (documents 41, configuration 9, spend PGlite 9, tenancy 6, pack PGlite 36) | 101 of 101 pass |
| Related existing suites (24 files) | 679 of 679 pass |
| DEV rehearsal (bank, refusals, limits, payslip) | 32 of 32 checks; per-user cap script 12 of 12 |
| `tsc --noEmit` | one pre-existing error (`canonicalCertResidueAllSql.test.ts(127,75)`), none in new files |
| `eslint` on new and changed TypeScript | clean |
| SQL editor-safety lint, 34 files | clean |
| Full repository suite | NOT PERFORMED |

## 6. The operator actions, in order

See `README.md` "Ordered steps": (1) read the deployed commit and test `git merge-base --is-ancestor 1501882 <deployed>`; (2) `sql/A01` to `A04` on DEV then production; (3) Amplify check
with the script, fix, build; (4) create P1, P2, F1, X1; (5) baseline `A02`/`E05`; (6) Journey 1 (bank PDF, variant B); (7) refusals R1 to R7, R9; (8) the other classes; (9) Module 11 only after its gates;
(10) close out and clean up with backup first; (11) fill `07_EVIDENCE_TEMPLATE.md` and decide with section 3 above.
