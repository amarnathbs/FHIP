# A2–A5 Master Execution Programme — Reconciliation and Scope Baseline

**Source spec:** "FHIP ADMIN REDESIGN — A2-A5 Master Execution Programme" v1.0, 7 September 2026 (`FHIP_Admin_Redesign_A2-A5_Master_Execution_Programme (1).docx`).
**Branch:** `feature/admin-a2-a5-master-execution`.
**Baseline:** branched from `origin/main` at `a19358324e7fc23dca11a83800113710238b5b4b`, then merged `feature/admin-a2-canonical-shell-navigation` (`c87c11195302703afc9b323ceb886709fc328087`) as a clean fast, conflict-free merge (merge commit `fb4f78cb52717ed03ad9bb4f9a1ab80a057db45e`).

This document is Programme Charter 1/3's required "record the applicable baseline and evidence reference" for the whole dispatch, and answers the reconciliation question the dispatching session posed: **is this document's A2 scope the same as the earlier 32-section A2 spec `feature/admin-a2-canonical-shell-navigation` was built against, or does it add requirements?**

## 1. How this document's content was actually extracted

The plain-text extraction (`a2a5_extract.txt`, provided as the primary source) was produced by a paragraph-only read of the `.docx` and **silently dropped every single-cell table** in the source document — which is where most of this spec's actual per-item distinguishing content lives (the "Outcome:" line for each Programme Charter / NAV / ROLE / A2-WP / A3-WP / A4-WP / A5-CERT / ADV / CONTROL TEMPLATE / TERMINAL HANDOVER item, plus all 11 Charters' binding rules and all 6 Terminal Handovers' required outcomes). What the plain-text extraction left behind reads as generic, near-content-free boilerplate ("Record the applicable baseline and evidence reference... Apply the rule consistently...") repeated verbatim under every heading — which is misleading on its own.

A structure-preserving re-extraction was done with `python-docx`, walking the document body in original order (paragraphs interleaved with tables), producing `a2a5_full_structured.txt` (6,343 lines). All findings in this document set are based on that structured extraction, cross-checked against `docs/admin/A1_20_ROADMAP_A2_A5.md` (this repo's own prior planning document, PO-approved, which this spec's own A2/A3/A4/A5 section objectives track closely).

## 2. What the document actually contains

| Section | Count | Real distinguishing content per item | Everything else |
|---|---|---|---|
| PROGRAMME CHARTER 1–11 | 11 | One "Binding rule" sentence each (see §3 below) | Identical "Executor actions" / "Acceptance statement" boilerplate |
| NAV-01..08 | 8 | The Admin area name (Home, Content, Recommendations, Data Governance, Operations, Analytics, Security & Support, Administration) | Identical binding instructions/evidence/stop-conditions |
| ROLE-01..09 | 9 | The role name (Analyst, Author, Editor, Compliance Reviewer, Publisher, Resource Admin, Super Admin, Role-less, Anonymous) | Identical |
| A2-WP-01..40 | 40 (10 topics × 4 cycles) | 10 distinct topics: canonical shell foundation, typed navigation registry, capability-driven visibility, role-aware Admin Home, breadcrumbs/active state, contextual task help, compatibility routes, responsive navigation, accessibility foundation, honest result states | Fully identical binding instructions/evidence/stop-conditions across all 40 (confirmed by diffing A2-WP-01 against A2-WP-11/21/31 in the structured extract) |
| A3-WP-01..60 | 60 (10 topics × 6 cycles, area tag rotates independently) | 10 distinct topics: content/resources migration, recommendations migration, benchmarks/reference data, FDH governance integration, scheduled/operational workflows, workflow-state consistency, transactional mutation preservation, audit continuity, manual alignment, compatibility monitoring — each paired with a rotating area tag (Resources/Recommendations/Benchmarks/Reference Data/FDH Governance/Scheduling/Operations/Content) | Identical binding instructions/evidence/stop-conditions per topic |
| A4-WP-01..50 | 50 (10 topics × 5 cycles) | 10 distinct topics: privacy-safe analytics, suppression/differencing defence, support-access workflow, break-glass governance, audit retention controls, security-event operations, consent/approval evidence, export parity, pseudonymization controls, privacy review workflow | Identical per topic |
| A5-CERT-01..50 | 50 (10 topics × 5 cycles) | 10 distinct topics: integrated inventory reconciliation, clean-build certification, full deterministic suite, role-by-role browser certification, responsive/accessibility certification, security/privacy adversarial tests, synthetic-data reconciliation, route retirement readiness, rollback rehearsal, release/production certification | Identical per topic |
| CONTROL TEMPLATE 1–15 | 15 | 15 distinct register schemas (field lists) — see §4 | N/A (each is already unique) |
| ADV-01..10 | 10 | 10 distinct adversarial-probe names (unauthorized navigation discovery, direct-route bypass, actor spoofing, concurrent mutation duplication, audit rollback on business failure, suppression reconstruction by repeated filters, cross-role client cache leakage, compatibility redirect existence leak, support grant reuse/expiry bypass, break-glass without alert/review) | Identical binding instructions/evidence/stop-conditions |
| TERMINAL HANDOVER 1–6 | 6 | 6 distinct "Required outcome" sentences (changed-file inventory; A2-A4 carried-debt closure; A3/A4 handover integrity; merge-preparation procedure; production activation plan; final executor response) | Identical "Mandatory response fields" / "Non-negotiable close" |

**Net effect:** the document's genuine informational content is small and dense (11 charter rules + 8 nav areas + 9 roles + 10 A2 topics + 10 A3 topics (×8 rotating areas) + 10 A4 topics + 10 A5-CERT topics + 15 register schemas + 10 adversarial probes + 6 handover outcomes), applied with uniform rigor across every combination the numbering implies. This is consistent with, not contradictory to, the dispatching session's own description ("40 distinct A2 items though the underlying content cycles through only ~10 distinct topics... repeated across NAV areas"). Treating this as ~78 distinct requirements applied at full rigor everywhere they are relevant, rather than 235 independently-authored items, is the correct reading and is how this reconciliation and every other A2A5_* report proceeds.

## 3. Programme Charter binding rules (extracted in full)

1. **How to use this programme** — Treat every MUST as binding. Preserve certified behaviour. Record evidence at the point of work even though expensive certification is deferred to A5.
2. **Executive mandate** — Complete the Admin redesign as one integrated programme without repeatedly stopping for new phase prompts, while retaining explicit Product Owner controls over merge, deployment, role expansion, schema changes and production data.
3. **Authoritative baseline** — Begin only from the confirmed post-A1 main SHA. Record branch, worktree, dependency state and overlapping work before editing. *(Done — see the baseline line at the top of this document; `a9d09f1` is A1's own merge SHA and is the merge-base of both `origin/main` and the A2 branch.)*
4. **Scope boundary** — A2 changes the shell; A3 migrates workflows; A4 introduces approved analytics/privacy/support controls; A5 certifies and prepares release. Do not collapse these semantic boundaries.
5. **Testing strategy** — Run compile, lint and focused invariant tests after meaningful changes. Defer clean install, full suite, production build, exhaustive browser matrix and terminal evidence reconciliation to A5.
6. **Immediate stop conditions** — Stop for a P0/P1 defect, authorization bypass, personal-data exposure, unexplained data variance, required role expansion, schema/RLS/RPC need outside approval, production-write need or scope conflict.
7. **Product Owner reserved decisions** — Merges, deployments, migrations, production activation, new roles, material capability expansion, route retirement and raw-document access require explicit authorization.
8. **Canonical terminology** — Use "phases" for A2–A5, "work packages" within a phase, and "certification gates" for verification. Do not use "Wave" for this Admin programme. *(Applied throughout this A2A5_* document set — note this repo's OTHER admin work, `A02_WAVE2`..`A02_WAVE5`, predates this rule and is correctly left as-is; it is a different, already-named track, not renamed retroactively.)*
9. **Evidence doctrine** — A claim is proven only by reproducible evidence tied to a pinned SHA. Separate implementation status, test status, environment limitation and release status.
10. **Repository hygiene** — Use a dedicated branch/worktree, preserve unrelated changes, keep credentials out of artifacts, pin baselines, and maintain a complete changed-file inventory.
11. **Terminal outcome** — A5 may recommend merge only after all carried debt is closed or explicitly accepted. No phase completion statement alone authorizes release.

Every A2A5_* document in this set (§00–§06) is written to satisfy charter 9's separation explicitly: each finding is labelled **implemented** / **tested** / **environment-limited** / **not started**, never collapsed into a single "done".

## 4. The 15 Control Template register schemas (verbatim field lists, for reuse by every downstream report in this set)

1. **Capability decision record** — Task, Capability, Data, Enforcement, Audit, Approval.
2. **Route disposition register** — Canonical, Deep link, Compatibility, Unavailable, Withdrawn, Retirement.
3. **Privileged RPC register** — Invocation, Exception, Identity, Transaction, Hardening, Tests.
4. **Audit-event schema** — Actor, Purpose, Target, Outcome, Retention, Exclusions.
5. **Support access record** — Purpose, Scope, Consent, Approver, Expiry (max 60 min), Documents.
6. **Break-glass record** — Emergency, Operator, Scope, Alert, Expiry, Review.
7. **Analytics release checklist** — Cell size (≥5), People (≥10 distinct), Complementary, Differencing, Repeated query, Parity.
8. **Role expansion submission** — Justification, Capability, Data, Least privilege, SoD, Approval.
9. **Compatibility monitoring** — Caller inventory, Replacement, Authorization, Usage (≥1 release cycle), Rollback, Retirement.
10. **Test evidence record** — SHA, Baseline, Command, Arithmetic, Environment, Classification.
11. **Deferral record** — Item, Reason, Risk, Owner, Gate, Exit.
12. **Data reconciliation** — Fixture, Created, Mutated, Deleted, Re-query, Variance.
13. **Manual acceptance** — Task, Eligibility, Prerequisite, Steps, Outcome, Recovery.
14. **Release readiness** — Implementation, Tests, Security/privacy, Rollback, Docs, Authority.
15. **Terminal verdict rubric** — FULL PASS / CONDITIONAL PASS / FAIL / NOT TESTED / BLOCKED / DEFERRED (definitions match this spec's own vocabulary, not the older 4-value PASS/CONDITIONAL/FAIL/NOT STARTED vocabulary used by A2-WP/A3-WP/A4-WP/ADV item-level status — both are used side by side in this report set, matching which section of the source spec they answer).

## 5. Scope reconciliation: this spec's A2-WP-01..40 vs. the earlier 32-section A2 spec already built

`feature/admin-a2-canonical-shell-navigation` (commit `c87c111`) was built against an earlier, narrower "32-section A2 spec." This spec's A2-WP-01..40 (10 topics: canonical shell foundation, typed navigation registry, capability-driven visibility, role-aware Admin Home, breadcrumbs/active state, contextual task help, compatibility routes, responsive navigation, accessibility foundation, honest result states) is a **strict subset in substance, not a superset** — every one of these 10 topics maps directly onto a deliverable the earlier branch already built and documented:

| A2-WP topic | Earlier branch's deliverable | Doc |
|---|---|---|
| Canonical shell foundation | `components/admin/AdminShell.tsx`, `app/(app)/admin/layout.tsx` | `A2_02` |
| Typed navigation registry | `lib/admin/navigationRegistry.ts` (+ 25 integrity tests) | `A2_03` |
| Capability-driven visibility | `lib/admin/adminAreas.ts` (8-area capability-driven builder, reused not replaced) | `A2_03`, `A2_04` |
| Role-aware Admin Home | `app/(app)/admin/home/page.tsx`, `lib/admin/homeQueues.ts` | `A2_05` |
| Breadcrumbs and active state | Built into `AdminShell.tsx`; tested in `adminA2CanonicalShell.test.ts` | `A2_01` |
| Contextual task help | Reuses the pre-existing, unedited `lib/admin/taskHelp.ts` (A0.2 Wave 5) verbatim | `A2_13` §2 |
| Compatibility routes | Zero URL changes — register confirms no compatibility routes were needed this pass | `A2_06` |
| Responsive navigation | Mobile drawer with focus management, in `AdminShell.tsx` | `A2_01`, `A2_07` |
| Accessibility foundation | Skip link, landmarks, focus management | `A2_01`, `A2_07` |
| Honest result states | Loading/empty/forbidden states tested explicitly | `A2_09` |

This spec's NAV-01..08 (8 areas: Home, Content, Recommendations, Data Governance, Operations, Analytics, Security & Support, Administration) matches the same 8-area IA `A1_06`/`A1_07` define and the earlier branch implemented — **no new area, no renamed area**. ROLE-01..09 (9 roles/states) matches the same 7 canonical roles plus role-less plus anonymous the earlier branch's role matrix (`A2_04`) already covers.

**Conclusion: this spec's A2 scope is the SAME scope as what `feature/admin-a2-canonical-shell-navigation` already built, expressed as a more rigorously-templated work-breakdown, not an expansion.** The correct action — per the dispatching session's own instruction to "reuse/extend that branch's real work rather than rebuilding from scratch" — is exactly what this branch does: merge the existing work in unchanged, and treat this spec's A2 items as a checklist for closing the **verification debt** that branch already disclosed (see `A2A5_01_A2_CLOSURE_ADDENDUM.md`), not as a call to re-implement anything.

## 6. What genuinely is new relative to the earlier A2 pass

- **A3-WP-01..60** (workflow migration in bounded packages) — genuinely new; `A1_20`'s own A3 package was architecture-only, zero code, before this dispatch. See `A2A5_02_A3_STATUS.md`.
- **A4-WP-01..50** (audit sink, security-event stream, suppression engine, support/break-glass) — genuinely new; zero code exists anywhere in this repo for any of these four pieces before this dispatch. See `A2A5_03_A4_DESIGN_AND_STATUS.md`.
- **ADV-01..10** (adversarial probes) and **A5-CERT-01..50** (terminal certification) — genuinely new as a *named, formal* gate, though several of their underlying assertions (authorization-bypass testing, direct-route testing) were already informally exercised by A1/A2's own test suites. See `A2A5_04_ADV_ADVERSARIAL_RESULTS.md` and `A2A5_05_A5_CERTIFICATION_STATUS.md`.

## 7. Repository hygiene (Charter 10) confirmation

- Dedicated branch: `feature/admin-a2-a5-master-execution`, dedicated worktree `D:\FHIP\.claude\worktrees\agent-a989dc6719abeee1d`.
- Pre-existing untracked `_tmp_*` scratch files in this worktree (visible in `git status`) predate this dispatch, are unrelated to Admin work, and are left untouched — not committed, not deleted.
- No credentials are present in any file this dispatch created (no `.env.local` was created; none was found in the environment — see `A2A5_01_A2_CLOSURE_ADDENDUM.md` §"Live-DEV" for what that blocks).
- Baseline SHAs pinned throughout this document set.
