# A1.4 — Architecture Decision Register

The 10 items the brief requires be flagged, not decided, by A1 — each with a recommended option, alternatives, and risks. **A1 rules on none of these.**

## PO-1 — The three proposed domain-neutral roles

**Options:** (a) approve all three (Data Governance Contributor, Data Governance Approver, Support Access Grantee) now, ahead of any FDH-13 wave; (b) approve none, leave every affected capability on Super Admin (interim) indefinitely; (c) approve Contributor and Approver now (their capabilities are closer to being designed) but defer Support Access Grantee until Wave F's consent model exists; (d) some other domain-neutral shape.
**Recommended:** (c) — per `A1_03` §2's own per-candidate test. Contributor/Approver touch only unimplemented Financial-Data-Governance tasks and are reusable beyond FDH by the same reasoning already accepted for the propose/review/approve shape; Support Access Grantee's justification is strong but its capabilities (CAP-27/28) are not designed yet, so creating the role early would grant a role with nothing safe to hold.
**Risks:** approving early (a) risks a role with an undesigned access surface sitting unused, inviting scope creep into "what else could this role do" without a fresh review; approving nothing (b) leaves Super Admin as a permanent single point of both authority and audit-attribution ambiguity for FDH governance, which is itself a Standard §5 least-privilege tension worth resolving eventually.

## PO-2 — Final nav labels/ordering

**Options:** (a) adopt `A1_06`'s split of "General" into "Recommendations" + "Reference Data & Benchmarks" verbatim; (b) choose different final labels/ordering for the 9 areas; (c) keep "General" and rename it to something else without splitting.
**Recommended:** (a) — a split resolves PO5-2 by removing the category-mismatch entirely rather than papering over it with a new single name for two unrelated domains.
**Risks:** (a) requires reopening the certified Analyst Wave 1 nav contract and its tests (already known, `A1_18`); (c) leaves the original naming problem unsolved under a new label. Also bundled here per Wave 5's own carried items: PO5-3 ("Add @GKTC Video" component naming) and PO5-4 (should CSV bulk import confirm before running?) — both cosmetic/workflow-safety calls, not architecture, listed for completeness but not re-analysed by A1.

## PO-3 — Final Admin Home model

**Options:** (a) `A1_09`'s role-aware work-queue model, replacing/supplementing each domain's own dashboard; (b) each domain keeps its own dashboard, Home is purely a cross-domain queue aggregator with no domain-specific content of its own; (c) no Home page at all, nav-only.
**Recommended:** (b) — avoids duplicating or deprecating `admin/resources/page.tsx`'s existing, working dashboard; Home aggregates *queues* (its unique value) without needing to also become a general-purpose Resources dashboard.
**Risks:** (a) risks two competing "landing page" concepts for Resources staff; (c) forfeits the explicit Home value the brief asks for (single place showing what needs action across domains).

## PO-4 — Final privileged-RPC pattern + the service-role exception

**Options:** (a) adopt `A1_11` wholesale — Pattern A (atomic+audit) as default, Pattern S (server-boundary) as a narrowly-scoped, PO-approved-per-instance exception, never a default; (b) formalise Pattern S as a fourth standing pattern usable without per-instance approval; (c) retire Pattern S entirely and require every mutation, including bulk import, to go through a directly-`authenticated`-callable Pattern A RPC.
**Recommended:** (a) — matches the codebase's own existing precedent exactly (Wave 1/1B's exception was explicitly scoped, not a standing license) and avoids retrofitting two working, certified RPCs (`admin_upsert_recommendation_atomic`, `admin_import_recommendation_conditions`) for no functional gain.
**Risks:** (b) risks Pattern S becoming a routine escape hatch from the `auth.uid()` discipline (a real Standard §6 risk); (c) is the most consistent option but requires reworking two already-certified, already-live RPCs' access shape for a purely architectural purity gain, which is unlikely to be worth the regression risk.

## PO-5 — Audit retention policy (none exists yet, anywhere)

**Options:** (a) fixed retention (e.g. 7 years, matching common financial-record norms); (b) indefinite retention (current de facto behaviour for every existing audit table); (c) domain-specific periods.
**Recommended:** No recommendation — restated from `REG-14` verbatim: this is a repository-wide policy gap best resolved once for every Admin audit table (not solely for FDH), and it engages AU Privacy Act/India DPDP Act data-minimisation obligations that deserve a proper jurisdiction review (`A1_13` §3) rather than an architecture-document guess.
**Risks:** (b)'s current de facto state is itself a latent data-minimisation risk under both AU and India privacy law; (a)/(c) both require the jurisdiction review to happen before a number is picked, not after.

## PO-6 — Support-consent/break-glass approval model

**Options:** (a) require explicit user consent/notification for ordinary support access (CAP-27/35/36), never for break-glass (CAP-28, by definition an incident); (b) no consent requirement for either, notification-after-the-fact only; (c) consent required for both, with an emergency override clause for break-glass.
**Recommended:** No recommendation — restated from `REG-12`/`REG-13`: this is Wave F's own first deliverable, not decided by this architecture stage. `A1_14` names the required properties (9, §3) without picking among these options.
**Risks:** (b) is the weakest privacy posture and least likely to satisfy a future PIA; (c) may be operationally unworkable for a genuine incident if consent is a hard blocker.

## PO-7 — Analytics suppression thresholds beyond the already-approved minimums

**Options:** (a) keep the Standard §7.2 provisional thresholds (min cell 5, min distinct people 10, min evaluation runs 20) through to first production use, revalidating only if real data distributions demand it; (b) tighten them now, ahead of any real usage data; (c) make them configurable per-metric rather than one platform-wide constant (this is what `CAP-31`/ADM-45, `A1_01` §4, would exist to do).
**Recommended:** (a) for launch, with (c) as the mechanism that makes future tightening possible without a code change — the two are complementary, not alternatives.
**Risks:** (b) without real data risks either over-suppressing (destroying the feature's usefulness) or under-suppressing (a guess that turns out wrong is worse than a disclosed provisional number); (c) without governance (who may change the threshold, audited how) reintroduces a privacy-control-configuration risk of its own — `A1_02`'s CAP-31 already restricts this to Super Admin only, audited.

## PO-8 — Implementation ordering where dependencies compete

**Concrete competing dependencies found by this stage:**
- FDH-13 Wave E (`canViewFdhAnalytics`) is supposed to consume the canonical suppression engine, but `REG-15` also allows Wave E to *build* that engine if authorised first — these are not both "first," and the roadmap (`A1_20`) must pick one ordering.
- The canonical audit sink (A1.3) is a prerequisite for FDH-13 Wave A/B's own audit requirements (`FDH13-MD-011`, `AE-001/003/007`, all "Blocks FDH-13 closure = Yes") — but A1.3 itself is sequenced after A2 in the roadmap's default ordering.
**Recommended:** `A1_20`'s own proposed ordering (A2 → A1.3 concurrently-startable-with-A3 → A4) resolves both by placing the audit sink early enough to unblock FDH-13 Wave A/B before FDH-13 is itself authorised to start, and by defaulting to "canonical Analytics owns suppression first, FDH-13 Wave E consumes" per `REG-15`'s own stated preference. **Final sequencing sign-off is still a PO call**, not settled by this stage's proposal alone.
**Risks:** starting FDH-13 before the audit sink exists risks Wave A building against a moving foundation; delaying the suppression engine risks every domain wanting it (FDH, Recommendations, Analyst) queuing behind one team's roadmap.

## PO-9 — Any route/compatibility-field retirement

**Concrete candidate found:** `recommendations/gaps` stays a permanent 503-stub (`A1_08` §2) rather than being deleted outright, specifically to avoid an undocumented route retirement. **Also carried:** D5-13/PO5-6, `adminRoute()`'s raw-error-message forwarding — not a route retirement, but the same "needs an explicit decision rather than indefinite informal status" shape: either record it as a bounded §16.1 exception (stating the diagnosability reason, compensating control, and an expiry/review trigger) or close it the same way the other 21 raw-error sites were closed (G6).
**Recommended:** keep `recommendations/gaps` as a permanent stub (no retirement); close the `adminRoute()` gap via a fix (matching the other 21 sites) rather than a standing exception, since its own justification (diagnosability from the Network tab) is a developer convenience, not a security or product requirement strong enough to warrant a permanent documented exception.
**Risks:** retiring `recommendations/gaps` outright would remove a URL some caller might still reference; leaving `adminRoute()` informal indefinitely is exactly the kind of gap the Wave 6 Handover itself warned "compounds if left informal across more waves."

## PO-10 — Any change materially expanding a role's access

**Concrete candidates surfaced by this stage's own proposed capabilities:** CAP-26/30 (`canViewFdhAnalytics`/`canViewCanonicalAnalytics`) would be the first time Analyst's access expands beyond Resources into FDH/cross-domain data — even though both are aggregate/suppressed-only and consistent with Analyst's existing charter, this is still a materially new data source reaching Analyst's eyes and should be named explicitly rather than assumed automatically included once the capability exists.
**Recommended:** approve explicitly, per-capability, at the time each ships (Wave E for CAP-26, A4 for CAP-30) — not as a blanket "Analyst gets whatever Analytics ships" pre-authorization now.
**Risks:** blanket pre-authorization risks a future Analytics feature accidentally including a data source Analyst was never meant to see (e.g. if a future metric's underlying aggregate turns out to be reconstructable, per Standard §7's own reconstruction-risk requirement) without a fresh explicit check at ship time.
