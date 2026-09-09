# A1.4 — Architecture Decision Register

The 10 items A1 originally flagged, not decided, for the Product Owner. **All 10 have now been ruled on and resolved — none remains open.** Each entry below records A1's original options/recommendation/risks (unchanged, for the record) plus the Product Owner's actual ruling and where it has been folded into the rest of the A1 document set.

## PO-1 — The three proposed domain-neutral roles

**Options (as originally posed):** (a) approve all three (Data Governance Contributor, Data Governance Approver, Support Access Grantee) now, ahead of any FDH-13 wave; (b) approve none, leave every affected capability on Super Admin (interim) indefinitely; (c) approve Contributor and Approver now (their capabilities are closer to being designed) but defer Support Access Grantee until Wave F's consent model exists; (d) some other domain-neutral shape.
**A1's original recommendation:** (c) — per `A1_03` §2's own per-candidate test. Contributor/Approver touch only unimplemented Financial-Data-Governance (now Data Governance) tasks and are reusable beyond FDH by the same reasoning already accepted for the propose/review/approve shape; Support Access Grantee's justification is strong but its capabilities (CAP-27/28) are not designed yet, so creating the role early would grant a role with nothing safe to hold.
**Risks (as originally posed):** approving early (a) risks a role with an undesigned access surface sitting unused, inviting scope creep into "what else could this role do" without a fresh review; approving nothing (b) leaves Super Admin as a permanent single point of both authority and audit-attribution ambiguity for FDH governance, which is itself a Standard §5 least-privilege tension worth resolving eventually.

**Product Owner ruling (RESOLVED — final; deferral is the resolution, not a still-pending state), verbatim:**

> Do not approve or create any of the three proposed domain-neutral roles at A1. Defer all three. Use the existing canonical roles and capability-based authorization during A2. Reassess the candidates during A3/A4 only when real implemented tasks demonstrate that: existing roles cannot safely own the capability; a capability bundle alone is insufficient; separation of duties requires a distinct role; the role has sustainable operational ownership. "Super Admin (interim)" must remain temporary and cannot become permanent by default. This resolves PO-1. Once recorded in the Architecture Decision Register, A1 may be upgraded to FULL PASS.

**Effect:** none of the three candidates (Data Governance Contributor, Data Governance Approver, Support Access Grantee) is approved or created at A1 or A2. Every affected capability continues to resolve to the existing 7 canonical roles — in practice, Super Admin (interim) for every FDH-13 governance capability not yet assignable elsewhere — under ordinary capability-based authorization, exactly as A1 already documented. This is option (b) from A1's original framing (§ above), not A1's own recommended (c) — the Product Owner explicitly chose the more conservative path.

**Named reassessment criteria for A3/A4 (evidence-based, not calendar-based):** any of the three candidates may be reopened only when a real, implemented task demonstrates at least one of:
1. an existing canonical role cannot safely own the capability (a genuine least-privilege or blast-radius conflict, not merely convenience);
2. a capability bundle alone (without a role) is insufficient to express the needed authorization boundary;
3. separation of duties requires a distinct role (not achievable via per-record enforcement, e.g. proposer≠approver, alone);
4. the candidate role would have sustainable operational ownership (someone to actually hold and account for it, not a role created and left empty).

**Binding constraint restated:** "Super Admin (interim)" must remain explicitly temporary and must never become a permanent allocation by default — this was already true throughout A1's document set (`A1_03`, `A1_04`, `A1_09`, `A1_13`, `A1_16` CSV and MD) and remains unchanged and unweakened by this ruling; the Product Owner's ruling reiterates it as a standing requirement, not a new one. No role is created by A1, by A2, or by this closure pass.

## PO-2 — Final nav labels/ordering

**Options (as originally posed):** (a) adopt `A1_06`'s split of "General" into "Recommendations" + "Reference Data & Benchmarks" verbatim; (b) choose different final labels/ordering for the 9 areas; (c) keep "General" and rename it to something else without splitting.
**A1's original recommendation:** (a) — a split resolves PO5-2 by removing the category-mismatch entirely rather than papering over it with a new single name for two unrelated domains.
**Risks (as originally posed):** (a) requires reopening the certified Analyst Wave 1 nav contract and its tests (already known, `A1_18`); (c) leaves the original naming problem unsolved under a new label.

**Product Owner ruling: APPROVED, with a consolidation A1 had not itself proposed.** The Product Owner adopts option (b) in substance — a specific final structure, not A1's own (a) verbatim: **8 top-level areas** (not 9), in this order: **Home, Content, Recommendations, Data Governance, Operations, Analytics, Security & Support, Administration**. "Reference Data & Benchmarks" is not a standalone area — Benchmarks, reference data, and all FDH master-data/intelligence/parser/coverage governance are consolidated into one **Data Governance** area (renamed from A1's "Financial Data Governance"). "Security, Privacy and Support" is renamed "Security & Support" (no scope change). Explicit placement rules: Resources authoring/review/publishing → Content; Benchmarks/reference data/FDH governance → Data Governance; imports/processing-status/failures/system-health/scheduled-operations → Operations; Analyst dashboards/privacy-safe aggregates → Analytics; privacy requests/security events/consented support/break-glass → Security & Support; roles/capabilities/platform configuration → Administration. No separate FDH or Analyst navigation systems; hide empty groups and destinations the current user cannot use; do not expose Analytics until it contains a genuinely functional authorized destination. **Fully incorporated into `A1_06` (rewritten), `A1_07` (rewritten), `A1_08` (rewritten), and referenced from `A1_09`/`A1_16`/`A1_17`/`A1_20`/`A1_21`.** Bundled items PO5-3 ("Add @GKTC Video" naming) and PO5-4 (CSV import confirmation) remain not re-analysed by A1 — cosmetic/workflow-safety calls, unaffected by the nav ruling.

## PO-3 — Final Admin Home model

**Options (as originally posed):** (a) `A1_09`'s role-aware work-queue model, replacing/supplementing each domain's own dashboard; (b) each domain keeps its own dashboard, Home is purely a cross-domain queue aggregator with no domain-specific content of its own; (c) no Home page at all, nav-only.
**A1's original recommendation:** (b) — avoids duplicating or deprecating `admin/resources/page.tsx`'s existing, working dashboard; Home aggregates *queues* (its unique value) without needing to also become a general-purpose Resources dashboard.
**Risks (as originally posed):** (a) risks two competing "landing page" concepts for Resources staff; (c) forfeits the explicit Home value the brief asks for (single place showing what needs action across domains).

**Product Owner ruling: APPROVED as a role-aware work queue, not a metrics dashboard** — confirming A1's own (b)-shaped recommendation: Home never becomes a vanity-metrics dashboard and never replaces or duplicates a domain's own existing dashboard page. Every Home item must identify: who it's for, what needs doing, by when (if time-bound), the consequence of inaction, and which page completes it — exactly `A1_09`'s existing model. No individual financial information, no vanity metrics, no unauthorized cross-role summaries. **`A1_09` marked APPROVED as designed; `A1_08` §8 updated to state explicitly that Home supplements, never absorbs, `admin/resources/page.tsx`.**

## PO-4 — Final privileged-RPC pattern + the service-role exception

**Options (as originally posed):** (a) adopt `A1_11` wholesale — Pattern A (atomic+audit) as default, Pattern S (server-boundary) as a narrowly-scoped, PO-approved-per-instance exception, never a default; (b) formalise Pattern S as a fourth standing pattern usable without per-instance approval; (c) retire Pattern S entirely and require every mutation, including bulk import, to go through a directly-`authenticated`-callable Pattern A RPC.
**A1's original recommendation:** (a) — matches the codebase's own existing precedent exactly (Wave 1/1B's exception was explicitly scoped, not a standing license) and avoids retrofitting two working, certified RPCs for no functional gain.
**Risks (as originally posed):** (b) risks Pattern S becoming a routine escape hatch from the `auth.uid()` discipline; (c) requires reworking two already-certified, already-live RPCs' access shape for a purely architectural purity gain, unlikely to be worth the regression risk.

**Product Owner ruling: APPROVED with a documented service-role exception.** The preferred standard is authenticated invocation with authorization inside the RPC using trusted identity context (Pattern A). A service-role-only RPC is an approved exception **only** when: the API performs the canonical capability check first; the RPC is granted only to `service_role`; ordinary `authenticated`/anonymous roles cannot execute it; actor identity is obtained by trusted server code, never accepted from the browser; inputs are allow-listed and validated; business mutation and mandatory audit occur in one transaction; `SECURITY DEFINER`, fixed `search_path`, least privilege, and stable error contracts are enforced; denial/spoofing/rollback/idempotency/concurrency are tested; and **the exception and its justification are recorded in the RPC register**. The Product Owner explicitly reaffirms: `auth.uid()` does not provide meaningful end-user authorization when the database sees only a service-role invocation — this must never be pretended otherwise. **This permanently resolves A1_11 §6's auth.uid()-vs-service-role tension; it is no longer open anywhere in this document set.** Fully incorporated into `A1_11` (new §8, RPC register, listing the two existing Pattern S exceptions with their justification).

## PO-5 — Audit retention policy (none existed before this ruling)

**Options (as originally posed):** (a) fixed retention (e.g. 7 years, matching common financial-record norms); (b) indefinite retention (current de facto behaviour for every existing audit table); (c) domain-specific periods.
**A1's original recommendation:** No recommendation — restated from `REG-14` verbatim: a repository-wide policy gap best resolved once, engaging AU Privacy Act/India DPDP Act obligations deserving a proper jurisdiction review rather than an architecture-document guess.
**Risks (as originally posed):** (b)'s current de facto state is itself a latent data-minimisation risk under both AU and India privacy law; (a)/(c) both require the jurisdiction review to happen before a number is picked, not after.

**Product Owner ruling: APPROVED as an interim tiered standard, subject to later legal/privacy validation** — effectively option (c), tiered by risk class, adopted as a design default now rather than deferred indefinitely: privilege/role/privacy/support-access/break-glass/high-risk governance events, and content-approval/publication/recommendation/master-data governance events — **7 years**; routine operational/processing events — **2 years**; low-level failed-authentication/diagnostic security events — **1 year**, unless escalated into an investigation; security incidents or legal holds — **retained until the hold is formally released**. Audit records must use minimised metadata and never retain raw documents, secrets, or unnecessary financial figures. **Every period is explicitly marked "interim — legal/privacy validation required before A4 production activation"** — the jurisdiction review `A1_13` §3 already requires is not superseded by these numbers, only given a concrete starting point. Fully incorporated into `A1_12` (new §2.4) and referenced from `A1_13`/`A1_14`/`A1_20`.

## PO-6 — Support-consent/break-glass approval model

**Options (as originally posed):** (a) require explicit user consent/notification for ordinary support access (CAP-27/35/36), never for break-glass (CAP-28, by definition an incident); (b) no consent requirement for either, notification-after-the-fact only; (c) consent required for both, with an emergency override clause for break-glass.
**A1's original recommendation:** No recommendation — restated from `REG-12`/`REG-13`: Wave F's own first deliverable, not decided by the architecture stage. `A1_14` names the required properties (9, §3) without picking among these options.
**Risks (as originally posed):** (b) is the weakest privacy posture and least likely to satisfy a future PIA; (c) may be operationally unworkable for a genuine incident if consent is a hard blocker.

**Product Owner ruling: APPROVED as consented, time-limited, audited access with separate emergency controls** — closest to option (a)'s shape but with concrete parameters A1 had not itself proposed: no standing access to personal financial information or uploaded documents; normal support access requires a recorded purpose, narrow scope, user consent where applicable, a named operator, and automatic expiry; sensitive access additionally requires an independent approver; **default access duration is a maximum of 60 minutes, with a new approval required for any extension**; raw document viewing remains prohibited unless separately and explicitly authorized for that specific case; break-glass is reserved for genuine security or availability emergencies, requiring immediate immutable logging, prominent alerts, automatic expiry, and mandatory after-action review; access grants must never be reusable across users or incidents. **This resolves `REG-12`/`REG-13`'s "Wave F's own first deliverable" status for the consent *model*** — only UI copy, exact notification channel, and the separate `REG-13` co-holder question remain open. Fully incorporated into `A1_14` (§2/§3 rewritten to 12 properties, §5 updated).

## PO-7 — Analytics suppression thresholds beyond the already-approved minimums

**Options (as originally posed):** (a) keep the Standard §7.2 provisional thresholds (min cell 5, min distinct people 10, min evaluation runs 20) through to first production use, revalidating only if real data distributions demand it; (b) tighten them now, ahead of any real usage data; (c) make them configurable per-metric rather than one platform-wide constant.
**A1's original recommendation:** (a) for launch, with (c) as the mechanism that makes future tightening possible without a code change.
**Risks (as originally posed):** (b) without real data risks either over-suppressing or under-suppressing; (c) without governance reintroduces a privacy-control-configuration risk of its own.

**Product Owner ruling: APPROVED with additional protections, minimums retained.** Both existing minimums stay (displayed cell size ≥ 5; distinct people ≥ 10), plus: complementary suppression; protection against subtraction and differencing attacks; no individual drill-down; no exact pseudonymous financial profiles; rounding or bands for sensitive financial measures; controls against repeated filters reconstructing suppressed groups; identical protections for on-screen results, APIs, and exports; keyed-HMAC pseudonymization where stable pseudonyms are genuinely required; privacy review before introducing new dimensions or exports. **Fully incorporated into `A1_15`** (new intro paragraph + §3 rewritten with the four newly-explicit protections and the keyed-HMAC cross-reference to `A1_13`/`REG-10`).

## PO-8 — Implementation ordering where dependencies compete

**Concrete competing dependencies A1 found:** FDH-13 Wave E (`canViewFdhAnalytics`) is supposed to consume the canonical suppression engine, but `REG-15` also allows Wave E to *build* that engine if authorised first; the canonical audit sink (A1.3) is a prerequisite for FDH-13 Wave A/B's own audit requirements but was sequenced after A2 in the roadmap's default ordering.
**A1's original recommendation:** `A1_20`'s own proposed ordering (A2 → A1.3 concurrently-startable-with-A3 → A4) resolves both by placing the audit sink early enough to unblock FDH-13 Wave A/B, and by defaulting to "canonical Analytics owns suppression first, FDH-13 Wave E consumes" per `REG-15`.
**Risks (as originally posed):** starting FDH-13 before the audit sink exists risks Wave A building against a moving foundation; delaying the suppression engine risks every domain queuing behind one team's roadmap.

**Product Owner ruling: APPROVED — A2 → A3 → A4 → A5.** Within A3, migrate in this order: 1) Content and Resources workflows, 2) Recommendations, 3) Benchmarks and reference data, 4) FDH governance capabilities, 5) Scheduled and operational workflows, per the approved A3.1 dependency. **This is now the final, binding sequencing, not a proposal** — fully incorporated into `A1_20` (new "A3 internal sequencing" table, mapping PO-8's 5 steps onto A1's own A3.1/A3.2/A3.3 package labels) and its cross-package sequencing note.

## PO-9 — Any route/compatibility-field retirement

**Concrete candidate A1 found:** `recommendations/gaps` stays a permanent 503-stub (`A1_08` §2) rather than being deleted outright. **Also carried:** D5-13/PO5-6, `adminRoute()`'s raw-error-message forwarding.
**A1's original recommendation:** keep `recommendations/gaps` as a permanent stub (no retirement); close the `adminRoute()` gap via a fix rather than a standing exception.
**Risks (as originally posed):** retiring `recommendations/gaps` outright would remove a URL some caller might still reference; leaving `adminRoute()` informal indefinitely compounds across waves.

**Product Owner ruling: APPROVED — no blanket retirement.** Every route/compatibility-field retirement must follow: identify all callers and deep links; introduce the replacement; preserve authorization; use a compatibility redirect or stable withdrawn response where appropriate; monitor usage for at least one release cycle; document rollback; obtain explicit retirement authorization. **The one carve-out:** privacy-unsafe routes may be withdrawn immediately using a fail-closed response, as already done for `recommendations/gaps`. **Fully incorporated into `A1_08`** (new §10, the 7-step process plus the carve-out, applied to every disposition in that document — `recommendations/gaps` is confirmed as the one route using the carve-out, no other route in the map claims it).

## PO-10 — Any change materially expanding a role's access

**Concrete candidates A1 found:** CAP-26/30 (`canViewFdhAnalytics`/`canViewCanonicalAnalytics`) would be the first time Analyst's access expands beyond Resources into FDH/cross-domain data — even though both are aggregate/suppressed-only and consistent with Analyst's existing charter, this is still a materially new data source reaching Analyst's eyes.
**A1's original recommendation:** approve explicitly, per-capability, at the time each ships (Wave E for CAP-26, A4 for CAP-30) — not as a blanket "Analyst gets whatever Analytics ships" pre-authorization now.
**Risks (as originally posed):** blanket pre-authorization risks a future Analytics feature accidentally including a data source Analyst was never meant to see, without a fresh explicit check at ship time.

**Product Owner ruling: APPROVED — no blanket authorization, exactly matching A1's own recommendation.** Every material expansion of any role's access requires: task and business justification; the exact new capability; affected data classification; a least-privilege assessment; separation-of-duty impact; API and database enforcement; audit consequences; tests; and **explicit Product Owner approval**. This applies to CAP-26/CAP-30 specifically (neither is granted to Analyst by this ruling — each still needs its own approval at ship time, per A1's original recommendation) and to every other future capability grant, including anything PO-1 might eventually create. **Fully incorporated into `A1_04`** (footnote on the CAP-26/CAP-30 Analyst cells) **and this register** — no document may treat any capability listed as "(Y)"/"proposed" in `A1_02`/`A1_04` as already-granted; "(Y)" means designed, never authorized.

## Summary table

| Item | Ruling | Primary document(s) updated |
|---|---|---|
| PO-1 | **Resolved — deferred (final).** All three role proposals deferred to A3/A4, reassessed only against 4 named evidence criteria; existing canonical roles + capability-based authorization used through A2; "Super Admin (interim)" marked temporary everywhere, cannot become permanent by default | `A1_03`, `A1_04`, `A1_09`, `A1_13`, `A1_16`, this register |
| PO-2 | **Approved**, with consolidation (8 areas, not 9; Benchmarks folds into Data Governance) | `A1_06`, `A1_07`, `A1_08` |
| PO-3 | **Approved** as designed — role-aware work queue, not a dashboard | `A1_09`, `A1_08` §8 |
| PO-4 | **Approved** with documented service-role exception + RPC register | `A1_11` |
| PO-5 | **Approved** as interim tiered standard | `A1_12`, `A1_13` |
| PO-6 | **Approved** — consented, time-limited, audited, separate emergency controls | `A1_14` |
| PO-7 | **Approved** with additional protections | `A1_15` |
| PO-8 | **Approved** — A2→A3→A4→A5, A3 internally ordered 1–5 | `A1_20` |
| PO-9 | **Approved** — no blanket retirement, compatibility + evidence-based process | `A1_08` |
| PO-10 | **Approved** — no blanket expansion, per-capability approval required | `A1_04` |

**A1 ruled on none of these — the Product Owner did.** This register records what was asked, what A1 recommended, and what was actually decided, so the reasoning trail is never lost even where the ruling differs from A1's own recommendation (PO-1, PO-2, PO-6 all did — PO-1 chose the more conservative option (b) over A1's recommended (c)).

**All 10 items are now resolved.** With PO-1's deferral ruling recorded above, no item in this register remains open. Per the Product Owner's own words ("Once recorded in the Architecture Decision Register, A1 may be upgraded to FULL PASS"), A1's terminal verdict is upgraded accordingly — see `A1_21` §"Closure addendum".
