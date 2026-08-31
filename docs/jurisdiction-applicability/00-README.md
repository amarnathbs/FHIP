# G0-JA-1 — Jurisdiction Applicability Realignment: Discovery, Architecture Certification & Implementation Blueprint

**Discovery date:** 2026-08-26. **Closure date (this pass):** 2026-08-27/28 (single continuous work session spanning the day boundary — timestamps in this package reflect the moment each check actually ran). **Scope:** Full-application discovery (2026-08-26) plus Product-Owner-decision incorporation, Resources-discrepancy resolution, and architecture closure (this pass, per the G0-JA-1 closure spec). Documentation and architecture only, both passes — no mass implementation, no production changes, SMSF workstream untouched, application source/migrations/catalogue data untouched.

## A. Executive verdict

**G0-JA-1 FULL PASS — PRODUCT DECISIONS INCORPORATED; ARCHITECTURE READY FOR PHASED IMPLEMENTATION**

> **Scope note (added 2026-08-30):** this FULL PASS is the verdict on the **discovery and architecture** work in this package only. It is **not** a Wave 2 verdict and must never be read as one. **Wave 2 is a CONDITIONAL PASS at 11/20 items functionally realigned** — see the "Wave 2 status" section below and the authoritative [`G0_JA1_Wave2_Final_Scope_Decision_2026-08-30.md`](./G0_JA1_Wave2_Final_Scope_Decision_2026-08-30.md).

All six Product Owner decisions (PO-1 through PO-6, §C below) are incorporated into the architecture and every affected deliverable. The Resources discrepancy is resolved with current, direct file-level evidence (§D). All twenty Australian catalogue candidates now carry an individual, rationale-backed disposition (`03-catalogue-matrix.md`/`.csv`, Decision PO-2). The applicability architecture now formally supports home and cross-border contexts via five canonical classes, including a distinct `EXISTING_RECORD_ONLY` state that separates existing-record preservation from new-record eligibility (`01-canonical-architecture.md` §7). Missing-country behaviour is architected to fail closed for new jurisdiction-sensitive creation while never touching existing data (`02-module-matrix.md` §Missing-country architecture, Decision PO-3). The EPF/PPF/NPS catalogue architecture is defined and approved for a future wave without being implemented now (Decision PO-1). SMSF cross-border preservation is architected via a documented future-state scenario table without weakening the current AU-only DB trigger (`09-cross-border-model.md` §6, Decision PO-5). Both confirmed code defects (JA-D1, JA-D2) have complete, bounded remediation specifications — future input source, response contract, required tests, rollback boundary, and objective exit criteria — without being fixed in this task (`04-calculation-dependency-matrix.md` §Defect Remediation Specifications, Decisions PO-4/PO-6). All ten deliverables were checked for internal consistency (§L) and updated where the discovery baseline's language still described a decision as pending. **No application source file, migration file, or catalogue/DEV/production data was changed anywhere in this task** — verified below (§L) and re-confirmed at the end of this pass. No material architecture blocker remains against the spec's own closure-blocker checklist (§16 of the spec; full walk-through in §M below — the remaining-issue register contains zero blocking items).

This verdict applies to the **architecture and documentation only**. It does not mean any of Waves 1-6 (§K) has been implemented, does not mean the two confirmed defects are fixed, does not mean the 98 missing-country users are resolved, and does not mean EPF/PPF/NPS exist in the live catalogue — none of that is a closure blocker per the spec's own explicit list (spec §16, "do NOT block closure" items), and none of it was implemented here.

## B. Current repository baseline

| Item | Value |
|---|---|
| Repository path | `D:\FHIP`, worktree `D:/FHIP/.claude/worktrees/g0-jurisdiction-discovery` |
| Branch | `g0-jurisdiction-applicability-discovery` |
| HEAD at closure start | `b568993dd1f1022b66ac05cba9ddfe252f096c1a` (2026-08-26 10:09:55 +1000) |
| `origin/main` at discovery start (original fork point) | `6a2701aa2257b26a2afb4059ccc8886b97fb05b8` |
| `origin/main` at closure start (re-fetched fresh, 2026-08-27) | `ba23cd6a38eae89662da69fc825f136385a22f4d` |
| Merge base (branch vs. current `origin/main`) | `6a2701aa2257b26a2afb4059ccc8886b97fb05b8` (i.e. the branch's own fork point — branch and `origin/main` have not been reconciled since, 6 commits ahead on the branch, 63 commits ahead on `origin/main`, confirmed via `git status`: "have 6 and 63 different commits each, respectively") |
| Working-tree status at closure start | Clean (`nothing to commit, working tree clean`) |
| Commits unique to the discovery branch | **6**, not 5 as the discovery baseline's own §A(v.1) once summarised — corrected here: `d563951`, `bf5be59`, `3d4ed0a`, `3fe6c0d`, `064f08f`, `b568993` (the 6th being the branch's own prior Resources-discrepancy correction, made before this closure task began — see §D) |
| Migrations `0084`/`0089`/`0090` | Confirmed byte-for-byte identical to `origin/main` both before and after this closure task's edits (SHA-256 hashes recorded in §L) |
| Current migration head on `origin/main` | `0095` (10 new migrations landed since the discovery fork point — none touching `master_financial_items`, `country_applicability`, `jurisdiction`, `resource_posts`, or `resource_faqs`; confirmed by targeted grep, §L) |
| Files modified by this closure task | All 11 physical files across the 10 deliverables under `docs/jurisdiction-applicability/` (`03` spans two physical files, `.md` + `.csv`) — 10 files (`00`, `01`, `02`, `03.md`, `03.csv`, `04`, `06`, `07`, `08`, `09`) received substantive content changes; `05` received a one-paragraph provenance note only. **Zero files outside `docs/jurisdiction-applicability/` were modified.** |

**Evidence provenance for this report, per spec §3's explicit requirement to distinguish sources:**
- **Original discovery baseline (2026-08-26):** all row counts, module findings, live-DEV query results, and the two confirmed defects, except where marked "CORRECTED" or "RESOLVED" below.
- **Fresh evidence from current `origin/main` (2026-08-27, this pass):** confirmed zero diff between the discovery fork point and current `origin/main` for every file this report depends on (`supabase/seed_master_items.sql`, `lib/services/twinData.ts`, `lib/engines/resilienceStress.ts`, `lib/services/jurisdiction.ts`, migrations `0084`/`0089`/`0090`/`0049`, all of `lib/resources/`) — the 10 new migrations that did land (`0082`, `0083`, `0086`, `0087`, `0088`, `0091`, `0092`, plus 3 education/funding-goal-linkage migrations) are confirmed unrelated by targeted grep. **Conclusion: the discovery baseline's technical findings are still valid against current `origin/main`; no discovery conclusion is invalidated by drift.**
- **Live DEV evidence:** re-used from the discovery baseline's own queries (`05-live-dev-usage-audit.md`), not re-queried in this closure pass — justified by the zero-diff finding above (see `05-live-dev-usage-audit.md`'s own baseline-refresh note).
- **Product Owner decisions (2026-08-27):** PO-1 through PO-6, §C below — newly incorporated in this pass.
- **Future implementation recommendations:** everything under `06-implementation-waves.md` — explicitly not implemented, not authorised to start by this closure.

No rebase, merge, or rewrite of the discovery branch was performed to produce this closure (spec §3's explicit instruction) — this pass adds new commits on top of the existing 6, it does not alter them.

## Wave 2 status — READ THIS FIRST (updated 2026-08-30)

> **Authoritative record:** [`G0_JA1_Wave2_Final_Scope_Decision_2026-08-30.md`](./G0_JA1_Wave2_Final_Scope_Decision_2026-08-30.md)
> Where any other document in this package conflicts with it about Wave 2, **that record governs**.

**Current Wave 2 verdict:**

> **G0-JA-1 WAVE 2 CONDITIONAL PASS — 11/20 ITEMS FUNCTIONALLY REALIGNED; AUSTRALIAN SHARES APPLICABILITY REDESIGN AND 8-ITEM SEMANTIC CERTIFICATION DEFERRED**

| Group | Count | Current status |
|---|---:|---|
| AU-restricted items implemented consistently | 11 | Functionally implemented |
| `investment.australian_shares` | 1 | Classification/data/runtime contradiction unresolved |
| `GLOBAL_WITH_JURISDICTION_VARIANT` items | 8 | Classified only; not functionally or semantically certified (0/8 functional) |
| **Total** | **20** | **11/20 functionally realigned** |

**Wave 2 document map:**

| Document | Standing |
|---|---|
| [`G0_JA1_Wave2_Final_Scope_Decision_2026-08-30.md`](./G0_JA1_Wave2_Final_Scope_Decision_2026-08-30.md) | **AUTHORITATIVE** — current Wave 2 status and all Product Owner decisions |
| [`G0_JA1_Wave2_Issue_Register.md`](./G0_JA1_Wave2_Issue_Register.md) | **CURRENT** — open issues W2-AR-1, W2-SV-1, W2-MCC-1 and the resolved W2-HF-1 |
| [`G0_JA1_Wave2_Detailed_Report_2026-08-28.md`](./G0_JA1_Wave2_Detailed_Report_2026-08-28.md) | **HISTORICAL — SUPERSEDED** |
| [`G0_JA1_Wave2_Detailed_Report_2026-08-29_CLOSURE.md`](./G0_JA1_Wave2_Detailed_Report_2026-08-29_CLOSURE.md) | **HISTORICAL — SUPERSEDED** |
| [`G0_JA1_Wave2_Final_Scope_Decision_And_2fa2090_Rejection_2026-08-30.md`](./G0_JA1_Wave2_Final_Scope_Decision_And_2fa2090_Rejection_2026-08-30.md) | **HISTORICAL — SUPERSEDED** (earlier same-day draft; its "12 restricted-item applicability implemented" framing is retracted) |

**Two deferred work packages** — defined, not scheduled, not started, each needing separate Product Owner authorisation (see `06-implementation-waves.md`):

- **Future Phase A — Australian Shares applicability redesign** (owns issue W2-AR-1).
- **Future Phase B — Jurisdiction Terminology and Semantic Variant Certification** (owns issue W2-SV-1).

**Mandatory Country Confirmation dependency:** Mandatory Country Confirmation establishes the approved authoritative country source (`user_profiles.country_of_residence`, `country_confirmed_at`, `country_source`). It is implemented on `feature/mandatory-country-confirmation-beta-cleanup` (HEAD `8621968`, migration `0111`). Migration `0111` has been applied to DEV and independently live-verified 28/28, with zero residual synthetic users. Mandatory Country Confirmation remains unmerged to `main` and is not production-live. Production users are **not** yet confirmation-gated. **Wave 2 applicability rework remains paused until it is fully released.**

**Rejected hotfix disposition:** commit `2fa2090` on `fix/g0-wave2-closure-hotfix` (worktree `D:/fhip-g0-wave2`), carrying migration `0103`, is **REJECTED — do not push, merge or deploy**. Migration `0103` is not approved for application anywhere. The commit is preserved unchanged as historical evidence of a rejected design.

**G0-JA-1 Wave 2 is PARKED.** No further Wave 2 implementation is authorised.

---

## Deliverables index (unchanged file set — updated content)

| File | Spec deliverable |
|---|---|
| `G0_JA1_Wave2_Final_Scope_Decision_2026-08-30.md` | **Authoritative Wave 2 status record (2026-08-30)** — supersedes every earlier Wave 2 completeness claim |
| `G0_JA1_Wave2_Issue_Register.md` | Current Wave 2 issue register |
| `01-canonical-architecture.md` | Deliverable 1 — Canonical Architecture Map + **NEW §7 Five Canonical Applicability Classes, §8 Canonical Jurisdiction Concepts** |
| `02-module-matrix.md` | Deliverable 2 — Complete Module Matrix, updated with PO-1/3/4/6 resolutions per module |
| `03-catalogue-matrix.csv` + `03-catalogue-matrix.md` | Deliverable 3 — Catalogue Matrix (machine-readable, 216 rows, unchanged count; 20 rows reclassified per PO-2) |
| `04-calculation-dependency-matrix.md` | Deliverable 4 — Calculation Dependency Matrix + **NEW §Defect Remediation Specifications (JA-D1, JA-D2)** |
| `05-live-dev-usage-audit.md` | Deliverable 5 — Live DEV Usage Audit (unchanged figures; provenance note added) |
| `06-implementation-waves.md` | Deliverable 6 — **REWRITTEN**: Wave 0 through Final Certification wave, per spec §12's mandated structure |
| `07-jurisdiction-standard.md` | Deliverable 7 — Permanent Jurisdiction Development Standard, updated to the five-class model |
| `08-testing-strategy.md` | Testing Strategy — GEO-01..10, APP-01..10 updated with PO decision references |
| `09-cross-border-model.md` | Cross-Border Model + **NEW §6 SMSF/Cross-Border Reconciliation Architecture (Decision PO-5)** |

## C. Product Owner decision incorporation table

| Decision ID | Decision | Status | Architecture effect | Implementation owner/wave |
|---|---|---|---|---|
| **PO-1** | India retirement catalogue — approve future creation of EPF, PPF, NPS as `HOME_OR_CROSS_BORDER_COUNTRY(IN)` items on the existing `retirement_accounts` domain; available to eligible NRIs; no auto-conversion of existing records; no product-specific tax/forecasting logic implied. | **RESOLVED — PRODUCT OWNER APPROVED, 2026-08-27** | `02-module-matrix.md` §Retirement (India retirement architecture); `03-catalogue-matrix.md` (absence re-confirmed, not yet added) | Wave 3, `06-implementation-waves.md` |
| **PO-2** | Twenty unrestricted Australian items — no blanket restriction; each item classified individually into one of the five canonical classes (12 → `HOME_OR_CROSS_BORDER_COUNTRY(AU)`, 8 → `GLOBAL_WITH_JURISDICTION_VARIANT`); existing records/totals/reports unaffected; applicability controls new creation only. | **RESOLVED — PRODUCT OWNER APPROVED, 2026-08-27.** *Classification decision only. Actual Wave 2 outcome (2026-08-30): **11 of the 12** `HOME_OR_CROSS_BORDER_COUNTRY` items are functionally implemented; `investment.australian_shares` is an unresolved contradiction; the 8 variant items are **classified only, 0/8 functional**. Net: **11/20 functionally realigned**.* | `03-catalogue-matrix.md`/`.csv` (full per-item disposition + rationale); actual outcome in `G0_JA1_Wave2_Final_Scope_Decision_2026-08-30.md` | Wave 2 (partial); remainder in Future Phase A and Future Phase B, `06-implementation-waves.md` |
| **PO-3** | Existing users with missing country (98/344 DEV) — no permanent AU/IN default; no IP-as-confirmation; explicit confirmation required before jurisdiction-sensitive functionality; GLOBAL-only access until confirmed; existing records/totals preserved regardless of confirmation state. | **RESOLVED — PRODUCT OWNER APPROVED, 2026-08-27** | `02-module-matrix.md` §Missing-country architecture (full future flow: auth/session, catalogue/API, confirmation, historical integrity) | Wave 4, `06-implementation-waves.md` |
| **PO-4** | Financial Twin unresolved-country behaviour (`twinData.ts:126`, JA-D1) — confirmed defect; remove silent AU fallback; fail closed to an "unavailable" state or a separately-certified global cohort; preserve confirmed-AU/IN behaviour. | **RESOLVED — PRODUCT OWNER APPROVED, 2026-08-27 (remediation direction, not the fix itself)** | `04-calculation-dependency-matrix.md` §Defect Remediation Specifications — JA-D1 (future input source, response contract, tests, rollback boundary, exit criteria) | Wave 1, `06-implementation-waves.md` |
| **PO-5** | Four India-profile SMSF owners — preserve all four; do not delete/modify/assume invalid; existing ownership does not itself grant new-creation permission; distinguish residence/primary-financial-country/cross-border/record-country/creation-capability/view-maintain-permission; identify (do not implement) the exact future trigger reconciliation needed. | **RESOLVED — PRODUCT OWNER APPROVED, 2026-08-27** | `09-cross-border-model.md` §6 (six-concept distinction table, gate-by-layer assessment, "can the trigger express this" analysis, exact future scenario table) | Wave 4 (cross-border-relationship store) + a later trigger-revision wave, `06-implementation-waves.md` |
| **PO-6** | Later-wave scope — Financial DNA/Resilience core stay global (no unresearched country-specific scoring); Goals reuse existing dormant applicability column; Investment Intelligence India Tax & Cost stays India-only, no invented equivalents for other countries; Reports preserve historical jurisdiction context; Resources reuses its existing jurisdiction system, no second model. | **RESOLVED — PRODUCT OWNER APPROVED, 2026-08-27** | `02-module-matrix.md` §Financial DNA, §Resilience, §Goals, §Investment Intelligence, §Reports, §Resources (each updated individually) | Wave 5 (DNA/Resilience/Goals/II/Forecasting), Wave 6 (Reports/Resources), `06-implementation-waves.md` |

**All six decisions are now marked RESOLVED throughout every affected deliverable** — the discovery baseline's old §Q ("Product Owner Decisions Required") has been retired; no deliverable in this package still presents any of PO-1 through PO-6 as an open question (verified in §L below).

## D. Resources discrepancy resolution

**What the original discovery baseline claimed:** "Zero jurisdiction metadata anywhere in `lib/resources/`" (in an earlier draft of `00-README.md`/`02-module-matrix.md`, since corrected on the branch itself before this closure task began — commit `b568993`, 2026-08-26).

**What current evidence proves (independently re-verified fresh in this closure pass, 2026-08-28, not merely re-reading the branch's own prior correction):**
- `grep -n "jurisdiction" supabase/migrations/0049_reconcile_phase0c_resources_lineage.sql` returns real, live schema: `resource_posts.jurisdiction` (line 484) and `resource_faqs.jurisdiction` (line 656), both `text not null default 'global' check (jurisdiction in ('global', 'australia', 'india', 'australia_india_cross_border'))`; a third `jurisdiction` column at line 631; a server-side RPC (lines ~1817-1918) taking `p_jurisdiction text default null` and applying "selected + global" filter logic at the database layer.
- `grep -ril "jurisdiction" lib/resources/` returns **26 files**, not zero — including `lib/resources/types.ts` (`ResourceJurisdiction` type, line 67), `lib/resources/public/queries.ts` (a real, working `applyJurisdictionFilter()` at lines 123-126, explicitly citing "spec §87" for its "selected jurisdiction + Global" semantics), `lib/resources/admin/filters.ts`, `lib/resources/admin/queries.ts`, `lib/resources/faq/*`, `lib/resources/video/*`, `lib/resources/search/*`, `lib/resources/editor/*`, `lib/resources/glossary/*`, `lib/resources/money-update/*`, and `lib/resources/discovery/*`.
- **Root cause of the original false claim:** the original audit pass grepped for the literal string `"country"` — which never matches, because Resources uses its own field name, `jurisdiction`, not `country`/`country_code`/`country_applicability`. This was a real methodology gap (an incomplete search), not two correct-but-differently-scoped observations, and not evidence the metadata was added after the fact — `git log` on migration `0049` shows it predates the SMSF-era `country_applicability` foundation (`0049` vs `0084`).
- **Filtering enforcement boundary:** server-enforced at two independent layers — the application query-builder (`applyJurisdictionFilter()` in `lib/resources/public/queries.ts`, applied before the Supabase call is issued) and a database-layer RPC taking the identical `p_jurisdiction` parameter — not merely a UI-level hide.
- **Supported jurisdiction values:** `global`, `australia`, `india`, `australia_india_cross_border` (a single-value `text` column with a CHECK constraint, English-word vocabulary — deliberately different from `master_financial_items.country_applicability`'s `char(2)[]` ISO-code convention, and not required to be unified per Decision PO-6).

**Corrected conclusion:** Resources is **not** a zero-differentiation module. It is a second, independently-built, already-live, already-working jurisdiction system, predating the SMSF-era foundation. **This closure does not build a second Resources jurisdiction system, and Decision PO-6 explicitly directs reuse of the existing one** — satisfied by inspection, since it already exists and works. The only genuinely remaining gap is non-blocking: (a) an optional future decision on whether to align Resources' bespoke vocabulary with the canonical ISO-code convention used elsewhere, and (b) a content-tagging accuracy audit (are AU-specific articles correctly tagged `australia` rather than left at the `global` default) — both assigned to Wave 6 (`06-implementation-waves.md`), neither blocking this closure (spec §7's own resolution requirement is satisfied by the evidence above, not by completing Wave 6's optional follow-on work).

## E. Canonical applicability architecture

Full detail: `01-canonical-architecture.md` §7 (five classes: GLOBAL, HOME_JURISDICTION, HOME_OR_CROSS_BORDER_COUNTRY, GLOBAL_WITH_JURISDICTION_VARIANT, EXISTING_RECORD_ONLY) and §8 (canonical jurisdiction concepts — 17 distinct concepts kept separate, with today's authoritative source or explicit "does not exist yet" for each). Resolver inputs, existing-record rules, new-creation rules, cross-border rules, and fail-closed behaviour are all defined in §7's "Architecture rules governing all five classes" subsection. No second applicability engine is proposed anywhere in this package (spec §16 blocker, explicitly avoided).

## F. Twenty-item Australian reclassification

Full detail with individual rationale: `03-catalogue-matrix.md` §"The 20 Australian items — individual disposition". Summary: 12 items → `HOME_OR_CROSS_BORDER_COUNTRY(AU)` (SMSF-adjacent structures, HECS/HELP, ATO payment plans, Australian super products, government co-contribution, Transition-to-Retirement, account-based/allocated pension, and the cross-border `australian_shares` holding); 8 items → `GLOBAL_WITH_JURISDICTION_VARIANT` (council rates, body corporate, defined benefit, employer contributions, salary sacrifice, personal/non-concessional contributions, spouse contribution). Every one of the 20 has an explicit, individually-reasoned disposition — none was left as an undifferentiated blanket restriction.

## G. India retirement architecture

Full detail: `02-module-matrix.md` §Retirement, "India retirement architecture (Decision PO-1 — full detail)". EPF/PPF/NPS approved for a future wave (Wave 3) as `HOME_OR_CROSS_BORDER_COUNTRY(IN)` items on the existing `retirement_accounts` domain; explicit calculation exclusions stated (no tax/forecasting/compliance logic implied by catalogue existence alone); no automatic conversion of existing generic retirement records. **Not created in this task** — still absent from the live catalogue today, confirmed unchanged.

## H. Missing-country architecture

Full detail: `02-module-matrix.md` §Missing-country architecture. Covers authentication/session behaviour, catalogue/API behaviour, confirmation (timestamp, source, audit trail, suggestion-only IP/VPN handling), and historical/economic integrity for the 98 DEV users with `country_of_residence = NULL`. Not implemented — Wave 4.

## I. SMSF cross-border architecture

Full detail: `09-cross-border-model.md` §6. Covers the four India-profile SMSF cases, the six concepts Decision PO-5 requires kept distinct, a layer-by-layer assessment of current SMSF enforcement (UI/API/service/DB-trigger/RLS/catalogue/reports/aggregation), an explicit finding that the current DB trigger **cannot** express the future distinction without a change, the exact bounded future remediation requirement (atomic trigger revision alongside a not-yet-built cross-border-relationship store), and the spec's exact required scenario table reproduced verbatim with today's actual-behaviour mapping against it.

## J. Confirmed-defect remediation specifications

Full detail: `04-calculation-dependency-matrix.md` §Defect Remediation Specifications. JA-D1 (Financial Twin, `twinData.ts:126`) and JA-D2 (Resilience, `resilienceStress.ts:84`) are each specified separately (per spec §11's explicit instruction not to bundle them) with: correct future input source, unresolved-country response contract, UI/API behaviour, global-cohort conditions (JA-D1) / cross-border handling (JA-D2), logging/telemetry constraints, required positive/negative/mismatch tests, historical-output protection, rollback boundary, and objective exit criteria. **Neither file was touched in this task** — both defects remain live and unfixed, which is explicitly not a closure blocker (spec §16).

## K. Updated implementation waves

Full detail: `06-implementation-waves.md`, rewritten to the Product Owner's mandated structure: Wave 0 (this documentation closure) → Wave 1 (JA-D1/JA-D2 defect fixes) → Wave 2 (catalogue realignment, the 20 items) → Wave 3 (India retirement catalogue) → Wave 4 (existing-user confirmation + cross-border-relationship store) → Wave 5 (engine/domain alignment) → Wave 6 (Reports/Resources) → Final certification wave. Each wave states objective, scope, dependencies, explicit exclusions, required migrations, required tests, negative controls, calculation-integrity gates, data-safety gates, exit criteria, rollback boundary, and required Product Owner authority. **No wave is implemented by this closure; no wave is authorised to start by this closure.**

## L. Documentation consistency and verification

Exact commands and results — see the Final numerical summary below for the consolidated figures. Full detail:

- `git status` before this closure task's edits: clean (`nothing to commit, working tree clean`). After this task's edits (not yet committed at time of writing, to be committed as a single documentation-only commit): only files under `docs/jurisdiction-applicability/` modified — confirmed via `git status --porcelain` showing no path outside that directory.
- `git diff --stat` confirms only the following files touched: `00-README.md`, `01-canonical-architecture.md`, `02-module-matrix.md`, `03-catalogue-matrix.csv`, `03-catalogue-matrix.md`, `04-calculation-dependency-matrix.md`, `05-live-dev-usage-audit.md`, `06-implementation-waves.md`, `07-jurisdiction-standard.md`, `08-testing-strategy.md`, `09-cross-border-model.md` — all ten deliverables, all inside `docs/jurisdiction-applicability/`.
- **No application source file changed** — confirmed: zero files under `lib/`, `app/`, `components/`, `supabase/migrations/`, `supabase/seed_master_items.sql` appear in the diff.
- **No migration file changed** — confirmed as above; specifically `supabase/migrations/0084_geo_jurisdiction_smsf.sql`, `0089_smsf_switch_to_summary.sql`, `0090_smsf_current_balance_integrity_guard.sql` SHA-256 hashes recorded before this task's edits and re-verified identical after: `0084` = `279bece2e5e1405108b6c341fe48e3f71bf5af3816a1424fd3c441b8d5c121f6`, `0089` = `247646d099fe1a9c54e132d952b1debb98b7ff2775325ea2b24058186b27505a`, `0090` = `472840a54833608bb8aa8f4923d59e17224ec662cc9abc736540e65adf8e35ec` — all three also byte-identical to their `origin/main` counterparts (`git diff origin/main -- <file>` empty for all three).
- **Matrix parseable, row count confirmed:** Python `csv.reader` parse of `03-catalogue-matrix.csv` succeeds; 216 data rows, 12 columns each, zero rows with a wrong column count.
- **No duplicate catalogue identifiers:** `Master Key` column checked for duplicates — zero found (before and after the PO-2 reclassification edit).
- **No missing proposed applicability classes:** every one of the 216 rows carries a non-empty `Proposed Scope` value (GLOBAL / GLOBAL cross-border-signalling / GLOBAL_WITH_JURISDICTION_VARIANT / HOME_OR_CROSS_BORDER_COUNTRY(AU) / HOME_JURISDICTION).
- **No invalid applicability values:** every `Proposed Scope` value maps to one of the five canonical classes defined in `01-canonical-architecture.md` §7 (or an explicitly-labelled sub-case of GLOBAL, e.g. cross-border-signalling by name).
- **All twenty Australian candidates have an explicit disposition:** confirmed by direct enumeration (`03-catalogue-matrix.md`) — 12 `HOME_OR_CROSS_BORDER_COUNTRY(AU)` + 8 `GLOBAL_WITH_JURISDICTION_VARIANT` = 20.
- **EPF/PPF/NPS documented without being falsely represented as existing rows:** confirmed — `03-catalogue-matrix.md` explicitly states they are "still absent from the live catalogue today", and a fresh grep for `epf|ppf|nps` (case-insensitive) across the whole CSV and the whole repo returns zero matches outside comments/documentation prose.
- **All six Product Owner decisions appear as resolved:** confirmed by grep for `PO-1` through `PO-6` and for the string `RESOLVED` / `PRODUCT OWNER APPROVED` across all ten deliverables — every decision reference carries a resolved marker; zero remaining instances of "PO decision required" / "unresolved" language referring to any of the six (the old §Q section itself was removed from `00-README.md`, replaced by §C's decision table).
- **Resources claims supported by file-level evidence:** confirmed in §D above — exact file paths, line numbers, and migration references given, independently re-verified in this closure pass via direct grep, not merely re-cited from the branch's own prior commit.
- **Obsolete contradictory claims search:** grepped all ten deliverables for "CONDITIONAL PASS" and "zero jurisdiction differentiation" (the two headline phrases the discovery baseline used for Resources before its own correction) — the only remaining instances are inside explicit "what the original claim said" historical/retraction context (§D above, `02-module-matrix.md` §Resources), never asserted as current fact.
- **No assertion that code/migrations/DEV were changed:** confirmed by direct re-reading of every edited file's language — every reference to a fix, catalogue restriction, or new column is explicitly marked "not implemented"/"future wave"/"documented, not created".
- **Secret scan:** no credentials, API keys, service-role tokens, or connection strings were added to any deliverable in this closure pass (all edits are prose/tables describing architecture, not scripts containing secrets; the discovery baseline's own live-DEV audit script, which did use a service-role key per its own disclosure, was not modified or re-run in this closure pass).
- **Conflict-marker scan:** grepped all ten deliverables for `<<<<<<<`/`=======`/`>>>>>>>` — zero matches.
- **Markdown-link/path validation:** every in-repo file path cited in cross-references (e.g. `lib/services/twinData.ts:126`, `supabase/migrations/0049_reconcile_phase0c_resources_lineage.sql`) was independently confirmed to exist at the cited path during this closure pass's own investigation (§D, §L above) — not merely copied from the discovery baseline without re-checking.
- **Application tests run (only where necessary to verify a specific claim, per spec §15's explicit instruction not to require a full-suite run for a documentation-only closure):** `npx vitest run tests/unit/jurisdictionApplicability.test.ts` → **5/5 passed**, re-executed fresh in this closure pass (2026-08-28) — confirms the underlying applicability predicate this entire closure's architecture rests on is still behaving as documented. No other test suite was run — not required to verify any claim in this documentation-only closure.

## M. Remaining issue register

Per spec §14's instruction to include only genuinely unresolved matters — **none of the following block closure** (spec §16's "do NOT block closure" list explicitly covers every item below):

| ID | Issue | Classification | Blocks closure? | Future owner/wave | Required action |
|---|---|---|---|---|---|
| RI-1 | Both confirmed code defects (JA-D1, JA-D2) remain unfixed in live code. | Confirmed defect, remediation specified | **No** (spec §16 explicit exclusion) | Wave 1 | Implement per `04-calculation-dependency-matrix.md` §Defect Remediation Specifications, with the required tests and exit criteria. |
| RI-2 | EPF/PPF/NPS do not yet exist in the catalogue. | Approved future work, not yet built | **No** (spec §16 explicit exclusion) | Wave 3 | Add the three catalogue items per `02-module-matrix.md` §India retirement architecture. |
| RI-3 | 98 DEV users remain unconfirmed (`country_of_residence = NULL`). | Approved future work, not yet built | **No** (spec §16 explicit exclusion) | Wave 4 | Build the confirmation UI/API/audit-trail per `02-module-matrix.md` §Missing-country architecture. |
| RI-4 | The 20 reclassified catalogue items remain unrestricted/unlabelled in DEV/production (no `country_applicability`/label-variant change applied). | Approved future work, not yet built | **No** (spec §16 explicit exclusion) | Wave 2 | Apply the backfill migration per `06-implementation-waves.md` Wave 2, with per-item live-DEV preservation proof first. |
| RI-5 | No explicit, stored cross-border-relationship set exists yet (`secondary_country` is dormant and single-valued). | Architecture gap, identified not built | **No** — required only to *fully* enforce `HOME_OR_CROSS_BORDER_COUNTRY`, not to define the architecture | Wave 4 | Build the one-to-many cross-border-relationship store per `01-canonical-architecture.md` §7/§8. |
| RI-6 | The current SMSF DB trigger cannot express the future AU-primary-vs-explicit-cross-border distinction. | Architecture gap, identified not built | **No** (spec §16 explicitly excludes "a future SMSF cross-border trigger refinement still required") | A later wave, atomic with RI-5's relationship store | Revise the trigger and the relationship store together, in one atomic deployment, per `09-cross-border-model.md` §6.3 — never loosen the trigger before the relationship store exists. |
| RI-7 | The 4 India-profile SMSF cases' true provenance (genuine cross-border history vs. test fixture) remains unconfirmed from read-only aggregates alone. | Disclosed ambiguity, not resolved by guessing (spec §60) | **No** — Decision PO-5 requires preservation regardless of provenance | Any future task with explicit Product Owner authority to investigate further | A dedicated lineage investigation (e.g. cross-referencing creation timestamps against known test-fixture patterns) — not authorised or time-boxed into this closure. |
| RI-8 | The 98 missing-country users' true composition (real onboarding drop-off vs. test/seed fixtures) remains unconfirmed from read-only aggregates alone. | Disclosed ambiguity, not resolved by guessing (spec §60) | **No** | Any future task with explicit Product Owner authority | Same method as RI-7, applied to this population. |
| RI-9 | Report section-builder files (`components/reports/**`) have not been fully swept for AU-only terminology leaks. | Disclosed residual gap, carried forward unchanged from the discovery baseline | **No** | Wave 6 | Full terminology sweep per `06-implementation-waves.md` Wave 6. |
| RI-10 | Resources' bespoke vocabulary (`global`/`australia`/`india`/`australia_india_cross_border`) is not aligned with the canonical ISO-code convention used elsewhere. | Optional consistency decision, not a defect | **No** — explicitly not required by Decision PO-6, which directs reuse, not rebuild | Wave 6 | Product Owner decision on whether alignment is worth the migration cost; no action required if the answer is no. |

**Zero items in this register are closure blockers.** No blocker from the spec's own §16 checklist was found to be currently true of this architecture (walked through item-by-item during this closure pass — every one of the fourteen listed blocker conditions was checked and found not to apply, as detailed across §C-§L above).

## N. Local handoff

- **Branch/worktree:** `g0-jurisdiction-applicability-discovery`, worktree `D:/FHIP/.claude/worktrees/g0-jurisdiction-discovery`.
- **Local commit SHA:** `b7b0201c62b6a8b30feea3544fcc6725ad4120bf` — a single documentation-only commit on top of `b568993`, local-only (no `origin/g0-jurisdiction-applicability-discovery` remote branch exists; confirmed via `git branch -vv`, which shows this branch tracking `origin/main` at "ahead 7, behind 63", not a same-name remote).
- **Documentation files changed:** all 10 files under `docs/jurisdiction-applicability/` (`00`-`09`, both `03.md` and `03.csv`).
- **Source files changed:** none.
- **Migration files changed:** none (0084/0089/0090 byte-for-byte confirmed unchanged; no new migration created).
- **DEV queried?** No — this closure pass reused the discovery baseline's existing live-DEV query results (`05-live-dev-usage-audit.md`'s provenance note); zero new DEV queries were issued in this pass. **DEV written?** No.
- **Production accessed or changed?** No — no production credentials exist in this environment and none were sought.
- **Pushed?** No. **Merged to `main`?** No.
- **Exact command to inspect the diff:** `git -C D:/FHIP/.claude/worktrees/g0-jurisdiction-discovery show b7b0201c62b6a8b30feea3544fcc6725ad4120bf` (this closure's own commit) or `git -C D:/FHIP/.claude/worktrees/g0-jurisdiction-discovery diff b568993 b7b0201 -- docs/jurisdiction-applicability/` (full range from the pre-closure HEAD).
- **Exact next Product Owner authorisation required:** explicit go-ahead to begin **Wave 1** (`06-implementation-waves.md`) — the two confirmed defect fixes (JA-D1, JA-D2) are the recommended next step, since they are the only wave that changes live calculation behaviour for already-affected real users and has zero dependency on any other wave.

## Final numerical summary

| Item | Value |
|---|---|
| **Verdict** | **G0-JA-1 FULL PASS — PRODUCT DECISIONS INCORPORATED; ARCHITECTURE READY FOR PHASED IMPLEMENTATION** |
| Current branch | `g0-jurisdiction-applicability-discovery` |
| Current commit (pre-closure-commit) | `b568993dd1f1022b66ac05cba9ddfe252f096c1a` |
| Current `origin/main` commit | `ba23cd6a38eae89662da69fc825f136385a22f4d` |
| Number of discovery commits (pre-closure) | 6 |
| Number of deliverables reviewed | 10 |
| Number of deliverables changed in this closure | 10 of 10 received at least a change; 9 received substantive content changes, 1 (`05`) received a provenance note only |
| Final catalogue-matrix row count | 216 (unchanged) |
| Number of Australia-flavoured items classified | 20 (12 `HOME_OR_CROSS_BORDER_COUNTRY(AU)` + 8 `GLOBAL_WITH_JURISDICTION_VARIANT`) |
| Number of India retirement products approved for future addition | 3 (EPF, PPF, NPS) |
| Number of existing missing-country profiles | 98 (of 344 total DEV profiles, 28.5% — discovery-baseline figure, re-used, not re-queried) |
| Number of India-profile SMSF cases preserved | 4 (of 8 total SMSF rows in DEV) |
| Number of confirmed code defects allocated to remediation | 2 (JA-D1 Financial Twin, JA-D2 Resilience) |
| Resources discrepancy status | **RESOLVED** — 26 files in `lib/resources/` plus migration `0049`'s `resource_posts.jurisdiction`/`resource_faqs.jurisdiction` confirmed live and working |
| Number of resolved Product Owner decisions | 6 of 6 (PO-1 through PO-6) |
| Number of remaining architecture blockers | **0** |
| Application source files changed | **0** |
| Migration files changed | **0** |
| Migrations created or applied | **0** |
| DEV writes | **0** |
| Production access/writes | **0** |
| Push status | **Not pushed** |
| Phased implementation ready to begin? | **Yes**, pending explicit Product Owner authorisation per wave |
| Exact recommended next wave | **Wave 1 — Global applicability safety and confirmed defects (JA-D1, JA-D2)** |
