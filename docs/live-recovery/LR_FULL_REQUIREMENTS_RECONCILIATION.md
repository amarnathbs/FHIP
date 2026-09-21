# LR Full Requirements Reconciliation

**Date:** 2026-09-14 · **Baseline:** `origin/main` @ `ff35f54` · **Branch:** `audit/lr-independent-completeness-2026-09-14`

This document records the audit's method, its evidence base, the Section 44 master matrix, the Section 25 cross-module missing-requirement search, the Section 27 proven-by-construction audit, and the Section 38 regression baseline.

---

## 1. Method and verification capability

### Environment identity, printed before verification (Section 30)

```
pwd                     D:/FHIP/.claude/worktrees/agent-acd9635e1dd2cb2b0
git rev-parse --show-toplevel   D:/FHIP/.claude/worktrees/agent-acd9635e1dd2cb2b0
git branch --show-current       audit/lr-independent-completeness-2026-09-14
git rev-parse HEAD              ff35f54c5eb78bcdf91a9e32b25108712351986f  (at audit start)
git rev-parse origin/main       ff35f54c5eb78bcdf91a9e32b25108712351986f
```
HEAD and `origin/main` were **identical** at audit start, so every source claim in these reports is a claim about canonical `origin/main`.

### Capability actually available (established, not assumed)

`scripts/audit-lr/a01_capability_probe.mjs` established the following before any verification was attempted:

| Capability | DEV | PROD |
|---|---|---|
| PostgREST service-role read/write | Yes | Yes |
| OpenAPI schema introspection (250 / 248 tables) | Yes | Yes |
| Storage admin API | Yes | Yes |
| Auth admin API | Yes | Yes |
| Arbitrary SQL (`exec_sql` etc.) | **No** | **No** |
| `supabase_migrations` ledger | **No** (`PGRST106`, only `public` + `graphql_public` exposed) | **No** |
| `pg_cron` / `net` introspection | **No** | **No** |
| Live application HTTP | local build | **Yes** |
| Amplify deployment API | **No** | **No** |

Migration application therefore had to be proven by **schema artefact probing** rather than by reading a ledger — which is why the `0136` finding is stated as a constraint-behaviour proof rather than a ledger lookup.

### Evidence hierarchy applied (Section 3)

- **Tier 1 (original PO requirements):** the audit brief's own restatement of the locked requirements. The original LR master prompts are **not committed to this repository** — recorded as a structural finding in `LR_DEFERRED_SCOPE_RECONCILIATION.md` §4.
- **Tier 2 (subsequent PO decisions):** the project memory record and decisions embedded in migration and code headers.
- **Tier 3 (code / DB / runtime):** the primary basis for every finding here.
- **Tier 4 (phase reports):** treated as leads only. Several Tier 4 claims were tested and found wrong — listed in §4 below.

---

## 2. Section 44 — Final master matrix

| Requirement area | Original expected scope | Current implementation | Main | DEV DB | Prod DB | Deployed | UI | Live DEV | Live Prod | Financially correct | Secure | Operationally ready | PO-authorized deviation? | Outstanding | Sev | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Global financial invariants | Exactly-once wealth, symmetric ratios, no double subtraction | Mostly correct; Net Worth is not | Y | Y | Y | Y | Y | **Y** | ? | **N** | — | — | No | SMSF loan double-subtracted | **P0** | **FAIL** |
| DSR / DTI | 10% not 30%; OR of tag and link | Correct on the canonical path | Y | Y | Y | Y | Y | **Y PASS** | ? | **Y** | — | — | — | Twin diverges | P1 | **PASS (engine)** |
| Exactly-once forecasting | One dollar once | Correct, 8/8 | Y | Y | Y | Y | Y | **Y PASS** | ? | **Y** | — | — | — | SMSF contribution classification | P2 | **PASS** |
| SMSF workspace | Full Summary/Detailed workspace | Detailed maintenance broken | Y | Y | Y | Y | Y | **N** | **N** | **N** | Y | — | No | `0137` regression | **P0** | **FAIL** |
| SMSF P&L / reconciliation / export | P&L, reconciliation, forecast, accountant export | P&L + CSV export exist; reconciliation and transactions do not | Y | Y | Y | Y | Y | Partial | ? | ? | Y | — | Not evidenced | Periods, transactions, export breadth | P2 | **PARTIAL** |
| Upload security / raw deletion | Strict deletion, no vault, janitor | Correct for FDH; absent for II | Y | Y | Partial | Y | Y | Y | **Y (janitor)** | — | Partial | Partial | Gate: not evidenced | II pipeline unpurged, no scanner, no load cert | **P1** | **PARTIAL** |
| Manual input UX | Form-first across 8 registers | Correct | Y | Y | Y | Y | Y | Y | ? | Y | Y | — | — | Insurance `cover_type` | P2 | **PASS** |
| Expenses bank workflow | Upload→Analyse→Review→Accept→Apply | Dead-ends at upload | Partial | Y | Y | Y | Y | **N** | **N** | Y (at the data layer) | Y | — | No | No parser worker | **P1** | **FAIL** |
| Import recovery | Payslip, liability, investment, retirement | Built, gated off; several formats absent | Y | Y | Y | Y | Y | Y | **N** | Y | Partial | **N** | Gate: not evidenced | PDF/broker/insurance gaps | P2 | **PARTIAL** |
| Insurance + Goals | Full lifecycle | Correct except cover-type detection | Y | Y | Y | Y | Y | Y | ? | Partial | Y | — | — | Income protection invisible | P2 | **PARTIAL** |
| Reports Hub / navigation | Coherent IA, premium fails closed | IA broadly right; two export defects | Y | Y | Partial | Y | Y | Partial | **N** | Y | **N** | — | No | Bypass, login-page PDF, missing bucket | **P1** | **FAIL** |
| Legal / accessibility / closure | Copy matches behaviour; two-actor closure | Copy partly wrong; closure incomplete | Y | Y | Y | Y | Partial | Partial | **N** | — | Partial | — | No | Blocking FK, residue, copy | **P1** | **PARTIAL** |
| Payments | AU Stripe, IN Razorpay, no Global price | Correct code, unconfigured in production | Y | Y | Y | Y | Y | Partial | **N** | Y | Partial | — | No | Env not forwarded | **P1** | **FAIL in production** |
| Company / Family Trust | Full entity architecture | Company works; Trust impossible in production | Y | Y | **Partial** | Y | Y | **Y PASS** | **N (Trust)** | Y | **Y** | — | WP-07/08 deferred | `0136` not applied | **P1** | **PARTIAL** |
| Terminal certification | Production-certified programme | Not achieved | — | — | — | — | — | — | — | — | — | — | — | See the Final Report | — | **FAIL** |

---

## 3. Section 25 — Cross-module missing-requirement search

Search terms applied across the committed specification and phase documents, the migration corpus, and the code: *must, shall, should, required, implement, build, add, support, include, test, verify, production, PDF, CSV, import, upload, bank, broker, CAMS, insurance, SMSF, Company, Trust, Child, report, export, Apply, Accept, Review, delete, archive, country, currency, premium, payment, malware, virus, scanner, load test, performance, production enablement.*

### ORIGINAL REQUIREMENTS WITH NO CURRENT IMPLEMENTATION MATCH

| Requirement | Where it is stated or implied | Current implementation |
|---|---|---|
| Malware / virus scanning before parsing | `FDH1_STATE_MACHINES.md:195` describes `malware_detected` as "flagged by scanning"; `FDH_ERROR_CODES` declares it; two CHECK constraints allow it | **None.** Zero assignments anywhere |
| A parser worker to consume the FDH ingestion queue | `uploadLifecycle.ts:307-309` names "a future FDH-4/5 parser worker" as the consumer | **None** |
| Production load / performance certification of the upload pipeline | §13.3 of the audit brief; no prior attempt anywhere | **None** |
| Liability statement PDF import | LR-4 scope as restated in the brief | **None** — CSV only by construction |
| Retirement statement PDF import | LR-4 scope | **None** — actively refused |
| Named AU broker import | LR-4 scope | **None** — `FDH11_AU_BROKER_ADAPTERS.md` lists 7 brokers as UNSUPPORTED |
| Insurance document import | LR-4 / LR-7 scope | **None** — not a document type |
| SMSF transaction ledger / SMSF bank import | LR-5 / LR-6 scope | **None** |
| SMSF accountant/auditor export beyond CSV (PDF/XLSX, balance sheet, audit metadata) | LR-6 title | **CSV only** |
| Entity income / expenses / transactions / reports / exports | LR-11 scope | **None** (WP-07/WP-08 deferred) |
| Report CSV export | Advertised at `reports/page.tsx:83` | **None** — permanently gated off |
| Report export expiry | `report_exports.expires_at` declared and read | **Never written** |
| `'printed'` / `'exported'` access events | Declared in the event enum | **Never emitted** |
| Report versioning UI (publish / revise / retry) | Three working routes exist | **No UI reaches them** |
| A live production payment round trip | PO-authorized before LR-12R | **Never done** |
| One bounded synthetic production account deletion | PO-authorized before LR-12R | **Never done** |

This list is **not** "NONE FOUND". Sixteen requirements have no current implementation match. Seven of them (malware scanning, the parser worker, load certification, entity income/expenses, SMSF transactions, the production payment round trip, the production deletion run) are material to the programme's own terminal-certification claim.

---

## 4. Section 27 — Proven-by-construction audit

High-risk claims that rested on code inspection, "by design", "structurally impossible", "existing certified infrastructure", or "no need to live test" — independently exercised.

| Claim | Source | Independently exercised? | Outcome |
|---|---|---|---|
| "SMSF liabilities are never double-subtracted" | `0084` column comment; LR-5/LR-6 certification | **Yes** — real fund, real loan, real engine | **FALSE.** −$365,000 error |
| "`0137`: No change to any function's logic/body" | `0137:42-43` | **Yes** — add/edit/remove on a detailed fund | **FALSE.** `42501` on all three |
| "The Twin must never see a different household cash-flow figure from the Dashboard" | `twinData.ts:260-261` | **Yes** — both loaders, same user, same instant | **FALSE.** DSR 30% vs 10% |
| "Entity liabilities are structurally excluded from personal DTI/DSR" | `0134:135-136` | **Yes** — real entity, real engine | **TRUE** |
| "Production uploads structurally disabled regardless" | `FDH14_RESIDUAL_RISK_REGISTER.md:10` | **Yes** — every upload surface enumerated against the gate | **FALSE.** One surface has no gate |
| "A storage-purge failure aborts the deletion" | `accountDeletionOrchestration.ts:60-69` | **Yes** — probed `list()` on the two missing production buckets | **True in code, vacuous in production** (`200 []`, never an error) |
| "the claim row's `processing_status` stays `'failed'` … so a retry is not blocked" | `stripe/webhook/route.ts:58-60` | Source-traced | **FALSE.** Plain INSERT; `23505` → `ALREADY_PROCESSED` regardless of status |
| Render token is "single-use" | `reportPdfRenderer.ts:15-17` | Source-traced | **FALSE.** Plain SELECT, no consume-on-read |
| "no account/user-deletion API route exists anywhere" | `countryGateAccessMatrix.test.ts` MC-15 | **Yes** — the suite itself | **FALSE, and the test fails on main** — LR-9 built one |
| Cross-tenant isolation on LR tables | LR-11 phase report (disclosed as unproven) | **Yes** — two real JWTs plus a positive control | **TRUE** |
| Exactly-once forecast integrity | LR-FI-3 | **Yes** — 8 scenarios | **TRUE** |
| The DSR 30%→10% fix | LR-12R | **Yes** — both discriminators | **TRUE** |
| The janitor runs autonomously in production | LR-1 closure | **Partly** — endpoint proven live and authorised; `pg_cron` invocation still operator-attested | **Endpoint TRUE**, schedule unverifiable here |
| LR-3's $500→$700 bank-import oracle proves the Expenses journey | `LR3_BANK_IMPORT_ORACLE_LIVE_DEV_E2E.md` | **Yes** — read the document and traced the panel's own calls | **The oracle is genuine but proves a different journey.** It drove `upload → detect → **process** → categorise → approve` directly over the API (`:14`); the Expenses panel never calls `process`. The named proof script is also **absent from the repository** |

**Eight of fifteen high-confidence "proven by construction" claims were false when exercised.** That ratio is the single most useful output of this audit.

---

## 5. Section 38 — Full repo regression and Baseline Failure Register

Run on the audit branch with **zero source modifications**, so every failure below is a **pre-existing `origin/main` baseline failure**.

| Check | Result |
|---|---|
| `npx tsc --noEmit` | **Clean, exit 0** |
| `npx vitest run` (default 5 s timeout) | 6,416 passed / **14 failed** / 23 skipped — all 14 were `Test timed out in 5000ms` |
| `npx vitest run --testTimeout=120000` | 6,427 passed / **3 failed** / 23 skipped; **12 test files failed** |

The 11 timeout-only failures disappeared at a longer timeout. Next.js itself flagged the cause: *"Slow filesystem detected. The benchmark took 17251ms"*, with a vitest transform time of 568 s on the first run. They are environmental.

### Genuine baseline failures on `origin/main`

| # | Test | Nature | Assessment |
|---|---|---|---|
| B-1 | `tests/unit/fdh1Isolation.test.ts:312` — "FDH is imported by an unapproved consumer: `components/investment-intelligence/InvestmentIntelligenceSubNav.tsx`" | **Real test failure, false architectural alarm.** The guard is a naive substring scan (`readFileSync(file).includes('financial-data-hub')`) with an explicit allowlist of known prose-comment false positives. `InvestmentIntelligenceSubNav.tsx:43` mentions `financial-data-hub/review/ReviewWorkspace.tsx` **in a comment** and imports nothing from the Hub | Add the file to `FDH_APPROVED_CONSUMER_FILES`, exactly as `reports/page.tsx` and `accountDeletionStorage.ts` already are |
| B-2 | `tests/unit/countryGateAccessMatrix.test.ts:254` — MC-15 asserts "no account/user-deletion API route exists anywhere", and finds `app/api/admin/account-deletions/[id]/execute/route.ts` | **Real test failure, real stale claim.** LR-9 built the route; the guard was never updated. The test's own comment says: *"If this ever finds a real candidate, the closure report's 'not currently supported' claim needs updating, not this test."* The route **is** country-gated (via `requireAccountDeletionAdmin` → `countryConfirmationBlockResponse`), so this is a documentation/guard defect, not a gate hole | Update the MCC closure claim and the guard |
| B-3 | `tests/unit/aiResidualClosureFailClosed.test.ts:201` — `expect(canonicalWrites(h).length).toBeGreaterThan(0)` returned 0 | **Real assertion failure in a negative control.** The control exists to prove the fail-closed assertions above it are not vacuous. A failing negative control means the surrounding fail-closed proof is currently **unproven**, not that the system is unsafe | Outside Live Recovery scope; flagged for the AI workstream |

### Environment-dependent baseline failures (9 files)

`resourcesR1_1`, `resourcesAdminR1_2`, `resourcesEditorR1_3`, `resourcesR1_4LiveDev`, `resourcesPublicR1_5`, `resourcesDiscoveryR1_6LiveDev`, `resourcesImportR1_7LiveDev`, `resourcesP0ContentR1_7CLiveDev`, `resourcesAdminRoleCtaHotfixLiveDev` — all fail at collection with `Error: supabaseUrl is required.` They construct a Supabase client at module scope from `process.env`, and `vitest.config.ts` loads no env file. They require externally-injected credentials and are not runnable from a clean checkout.

### Conclusion

**`origin/main` does not pass its own test suite**, with 3 genuine failures and 9 files that cannot run without externally supplied credentials. Two of the three genuine failures are direct consequences of Live Recovery and recent work (B-1 from the app-review comment, B-2 from LR-9's own new route). Per Section 38's requirement, these were not dismissed as pre-existing without proof: baseline failure was established by running them against an unmodified tree, and each was root-caused individually.

---

## 6. Section 29 — Git and deployment reconciliation

`git fetch` performed; `HEAD == origin/main == ff35f54` at audit start.

Ancestry of the 18 named Live Recovery commits was tested with `git merge-base --is-ancestor`, never lexically. 15 are ancestors of `origin/main`. Three are not: `cd7b201` (LR-11B Family Trust), `5447fac` and `ab94d1f` (the LR-9 storage fixes). **All three are false negatives** — their content is present on `origin/main` (migration `0136` exists; the family-trust validator and UI exist; `accountDeletionStorage.ts` carries both the corrected folder discriminator and the abort invariant). They were rebased or squashed, so the SHAs differ.

**Recorded as a methodological finding:** SHA ancestry alone is not a sufficient test of "is this on main". Content must be checked. A certification that relies on ancestry alone will raise this same false alarm.

### Deployed artifact verification

No Amplify API access exists, so deployment identity was established behaviourally rather than asserted:

- A server-rendered marketing page emits `new Date().toISOString().slice(0,10)` at build time and returned **2026-09-14** — the production build is from today.
- Every behavioural probe run against production matched current `origin/main`: the `/reports/{id}/print?token=` waiver produces the page-level `redirect('/login')` (307 with a rendered body) exactly as the current `app/(print)/reports/[id]/print/page.tsx:29` does, while `/forecast/report/print?token=` produces the proxy-level redirect (307, 6-byte body) exactly as the current `proxy.ts:107` regex dictates. The two are distinguishable, and both matched.
- Route-existence probes matched the current route tree, including `/api/business-entities` (401) and `/companies` (307 → `/login`).

**"Auto-deploy therefore PASS" was never used.** Deployment identity remains formally unconfirmed and is listed as a CANNOT VERIFY item.

---

## 7. Section 30 — Current production source of truth

The repository root at `D:/FHIP` is a **different, stale checkout** on branch `feature/phase1-design-system`, whose `package.json` lacks `stripe`, `razorpay`, `pglite`, `tsx`, `xlsx` and `pdf-parse` — i.e. it predates Live Recovery entirely. Dozens of sibling worktrees exist under `.claude/worktrees/`.

This audit ran exclusively in an isolated worktree branched from `origin/main`, with its own `npm ci`, and printed its identity before every verification phase. No claim in these reports derives from the stale root checkout.

The guard Section 30 asks for — "the prior Family Trust class of failure where DB/branch existed but `main` lacked application code" — was specifically tested, and the **inverse** was found: `main` and the deployed artifact have the code, and the production database does not (P1-1).
