# Deliverable 6 — Updated Implementation-Wave Architecture & Migration Strategy

**Rewritten 2026-08-27 (G0-JA-1 closure, spec §12).** The discovery baseline's original Wave 1-6 numbering (catalogue-first, defects in Wave 5) is **superseded** by the Product Owner's explicit wave ordering below, which fixes the two confirmed defects *before* any catalogue realignment. None of this has been implemented — every wave below is scoped from real evidence gathered in `01`-`05`/`09` and the six Product Owner decisions (`00-README.md` §C), not invented. **Do not assume all waves should be merged together** (spec §12's own instruction) — each is independently scoped, gated, and requires its own Product Owner authorisation to start.

## Wave 0 — Documentation closure (THIS TASK)

- **Objective:** incorporate the six approved Product Owner decisions into the existing G0-JA-1 deliverables; resolve the Resources discrepancy; give the 20 Australian catalogue items an individual disposition; define the canonical five-class applicability architecture; define missing-country and SMSF cross-border future architecture; define bounded remediation specs for the two confirmed defects.
- **Scope:** documentation and architecture only.
- **Dependencies:** none (built entirely on already-completed discovery evidence, re-verified against current `origin/main`).
- **Explicit exclusions:** no application source, migration, catalogue, DEV, or production change of any kind.
- **Required migrations:** none.
- **Required tests:** re-run `tests/unit/jurisdictionApplicability.test.ts` to confirm the existing applicability logic is undisturbed (5/5, re-run 2026-08-27 — see `00-README.md` §L).
- **Negative controls:** N/A (no code changed).
- **Calculation-integrity gates:** N/A (no calculation-affecting change).
- **Data-safety gates:** confirm zero DEV/production writes; confirm migrations `0084`/`0089`/`0090` byte-for-byte unchanged (verified — see `00-README.md` §L).
- **Exit criteria:** closure report delivered with a verdict per spec §17; all ten deliverables internally consistent (spec §13 audit, `00-README.md` §L).
- **Rollback boundary:** trivial — documentation-only local commits on a branch not pushed or merged; reverting is a plain `git revert`/branch deletion with zero application impact.
- **Required Product Owner authority:** none further needed to *close* Wave 0 (the six decisions were already given); authority IS needed before any later wave starts.

## Wave 1 — Global applicability safety and confirmed defects (JA-D1, JA-D2)

- **Objective:** fix the two confirmed defects — `lib/services/twinData.ts:126`'s silent AU fallback (JA-D1) and `lib/engines/resilienceStress.ts:84`'s currency-derived country (JA-D2) — per the bounded remediation specifications in `04-calculation-dependency-matrix.md` §Defect Remediation Specifications; establish fail-closed unresolved-country service behaviour where genuinely required by these two fixes specifically.
- **Scope:** exactly the two named defects. Nothing else. This wave runs *before* catalogue realignment because these are confirmed, disclosed, real-user-affecting behaviour bugs already in production-adjacent code today, not speculative future scope.
- **Dependencies:** none beyond Wave 0's documentation baseline (the remediation specs it implements).
- **Explicit exclusions:** no catalogue-wide mutation (no `country_applicability` backfill of any kind belongs in this wave); no Financial DNA/Resilience scoring redesign beyond the two named lines; no new global-cohort build unless one is separately certified (JA-D1's "global cohort only if genuinely certified" condition may mean this wave ships the "unavailable" contract without a global cohort, deferring the cohort itself to a later decision).
- **Required migrations:** none (pure application-logic fixes, no schema change, confirmed in `04-calculation-dependency-matrix.md`).
- **Required tests:** positive AU test, positive IN test, missing-country negative control, unsupported-country test (JA-D1); aligned-currency regression, AU+INR mismatch test, IN+AUD mismatch test (JA-D2) — full list in `04-calculation-dependency-matrix.md`.
- **Negative controls:** missing-country fixture must not receive an AU-cohort result (JA-D1); currency-mismatched fixtures must not receive an inverted home/foreign split (JA-D2).
- **Calculation-integrity gates:** confirmed-AU and confirmed-IN outputs byte-identical before/after, for both fixes.
- **Data-safety gates:** no historical report/snapshot regenerated using the new logic (Decision PO-6/Reports).
- **Exit criteria:** all tests above pass; code review confirms zero remaining silently-defaulting country derivation in either file; a real DEV missing-country/mismatched-currency fixture demonstrates the corrected behaviour live, not just in a unit test (mirroring the SMSF PGlite-plus-live-DEV standard, `08-testing-strategy.md`).
- **Rollback boundary:** each fix is independently revertible (different files, no shared migration); reverting one does not require reverting the other.
- **Required Product Owner authority:** explicit go-ahead to begin Wave 1 — this closure does not itself authorise starting it (spec's own final instruction: "await explicit Product Owner approval").

## Wave 2 — Catalogue applicability realignment (the 20 Australian items)

> **ACTUAL OUTCOME (2026-08-30) — Wave 2 is PARKED at a CONDITIONAL PASS.**
> Authoritative record: [`G0_JA1_Wave2_Final_Scope_Decision_2026-08-30.md`](./G0_JA1_Wave2_Final_Scope_Decision_2026-08-30.md). The plan text below is the **original wave plan**; it was not delivered in full and its exit criteria were **not** met.
>
> **G0-JA-1 WAVE 2 CONDITIONAL PASS — 11/20 ITEMS FUNCTIONALLY REALIGNED; AUSTRALIAN SHARES APPLICABILITY REDESIGN AND 8-ITEM SEMANTIC CERTIFICATION DEFERRED**
>
> | Group | Count | Current status | Deferred owner |
> |---|---:|---|---|
> | AU-restricted items implemented consistently | 11 | Functionally implemented | None — complete within Wave 2 |
> | `investment.australian_shares` | 1 | Classification/data/runtime contradiction unresolved | Future phase A |
> | `GLOBAL_WITH_JURISDICTION_VARIANT` items | 8 | Classified only; 0/8 functionally certified | Future phase B |
> | **Total** | **20** | **11/20 functionally realigned** | — |
>
> Migration `0102` is deployed. The rejected hotfix `2fa2090` and its migration `0103` are **not** released and must not be treated as resolving anything. Further Wave 2 applicability rework is **paused** until Mandatory Country Confirmation is fully released. Open issues: `W2-AR-1`, `W2-SV-1`, `W2-MCC-1` (see [`G0_JA1_Wave2_Issue_Register.md`](./G0_JA1_Wave2_Issue_Register.md)).

### Original wave plan (as written before implementation — retained for history)

- **Objective:** implement the individual dispositions already decided in `03-catalogue-matrix.md`/`.csv` (Decision PO-2) — 12 items to `HOME_OR_CROSS_BORDER_COUNTRY(AU)`, 8 items to `GLOBAL_WITH_JURISDICTION_VARIANT` (label/help-text localisation, no restriction).
- **Scope:** `country_applicability` backfill for the 12 `HOME_OR_CROSS_BORDER_COUNTRY` items (mirroring migration `0084`'s own idempotent backfill pattern) — but **only once the explicit cross-border-relationship store this class depends on exists** (see Wave 4 dependency below) or a narrower interim rule (e.g. AU-home-only, cross-border-creation deferred) is separately approved; label/help-text jurisdiction-variant infrastructure for the 8 `GLOBAL_WITH_JURISDICTION_VARIANT` items (no `country_applicability` change — these stay creatable by everyone); wiring `assertItemCreationAllowedForUser()` into any additional POST route (`liabilities`, `investments`, `retirement` if not already covered) that gains its first restricted item.
- **Dependencies:** Wave 1 complete (establishing the fail-closed pattern this wave's new restrictions rely on); a per-item pre-restriction check against live DEV usage (the discovery baseline checked SMSF specifically, not all 20 items individually — required before any of the 12 `HOME_OR_CROSS_BORDER_COUNTRY` items is actually restricted, per `06-implementation-waves.md`'s original Wave-1-equivalent caution, carried forward).
- **Explicit exclusions:** no change to any of the 8 `GLOBAL_WITH_JURISDICTION_VARIANT` items' actual availability (they remain global); no retroactive reclassification of existing records; no India retirement catalogue work (Wave 3).
- **Required migrations:** yes — one new migration for the `HOME_OR_CROSS_BORDER_COUNTRY` backfill (number TBD at merge time per the project's own established migration-collision precedent, `fdh3_r6_migration_reconciliation`).
- **Required tests:** one parametrised applicability-unit-test case per newly-restricted item; PGlite cert extending the SMSF pattern; live-DEV before/after row-count proof per item (existing-record preservation).
- **Negative controls:** forged direct-API creation of a newly-restricted item by an ineligible user must be rejected, mirroring SMSF's `42501` proof.
- **Calculation-integrity gates:** Net Worth/per-category totals identical pre/post for every existing record not itself newly restricted.
- **Data-safety gates:** zero existing rows hidden, deleted, or recounted.
- **Exit criteria:** all 12 items' creation-gates live-DEV-verified; all 8 items' label/variant infrastructure shipped without any availability change; full regression suite green.
- **Rollback boundary:** the backfill migration is a pure `UPDATE`, reversible by a corresponding `UPDATE ... SET country_applicability = NULL` migration.
- **Required Product Owner authority:** explicit go-ahead to begin Wave 2.

## Future phase A — Australian Shares applicability redesign

*Added 2026-08-30. Owns Wave 2 issue `W2-AR-1`. **Not scheduled, not estimated, not started.** Requires separate Product Owner authorisation.*

- **Scope:**
  - Replace the current inconsistent metadata/runtime behaviour for `investment.australian_shares`.
  - Use the user's **confirmed home country**.
  - Add verified cross-border eligibility **only after** the canonical cross-border store exists.
  - **Preserve all existing records.**
  - **Remove all currency and silent-default eligibility signals.**
  - Independently certify new creation, existing records, security and calculations.
- **Dependencies:**
  - Mandatory Country Confirmation production release.
  - Future cross-border architecture, where non-AU creation is required.
  - Separate Product Owner authorisation.
- **Explicitly out of scope here:** any reuse of the rejected hotfix `2fa2090` — its AU default and its AUD-currency eligibility signal must not be copied or cherry-picked, and its migration `0103` must not be applied.

## Future phase B — Jurisdiction Terminology and Semantic Variant Certification

*Added 2026-08-30. Owns Wave 2 issue `W2-SV-1`. **Not scheduled, not estimated, not started.** Requires separate Product Owner authorisation.*

- **Scope:**
  - Review all eight `GLOBAL_WITH_JURISDICTION_VARIANT` items **individually**.
  - Determine, per item: true variant, separate product, or neutral global item (`TRUE_LABEL_VARIANT` / `JURISDICTION_SPECIFIC_PRODUCT` / `NEUTRAL_GLOBAL_ITEM`).
  - **Do not build resolver infrastructure until at least one true variant is proven.**
  - Preserve EPF/PPF/NPS as separate products.
- **Certification bar:** an item may be called a true label variant only on proof that all seven remain identical across jurisdictions — financial meaning; input fields; calculation treatment; tax and regulatory assumptions; reporting treatment; forecast behaviour; user eligibility. If any differ materially, separate catalogue identities are required.
- **Dependencies:**
  - Item-level product decisions.
  - Calculation and reporting evidence.
  - Separate Product Owner authorisation.

## Wave 3 — India retirement catalogue (EPF/PPF/NPS)

- **Objective:** implement Decision PO-1 — add `retirement.epf`, `retirement.ppf`, `retirement.nps` (exact keys TBD) as `HOME_OR_CROSS_BORDER_COUNTRY(IN)` catalogue items.
- **Scope:** new catalogue rows only, reusing the existing `retirement_accounts` domain (per PO-1's explicit instruction not to build a product-specific schema without proven need); no calculation/tax/forecasting logic bundled in.
- **Dependencies:** the same explicit cross-border-relationship store as Wave 2 (for the NRI/cross-border eligibility half of PO-1's requirement) — may ship AU-primary-equivalent-for-India-only first (India-primary eligibility) and defer full cross-border eligibility to align with Wave 4, if sequencing requires it; this sequencing choice is for whichever future task executes this wave, not decided here.
- **Explicit exclusions:** no automatic conversion of any existing generic retirement record into EPF/PPF/NPS; no product-specific tax/forecasting logic; no institution-import/bank-adapter support claim.
- **Required migrations:** yes — new catalogue rows via the standard `master_financial_items` insert pattern.
- **Required tests:** same jurisdiction-gate unit/PGlite tests as Wave 2's items; a new "GEO-06: IN→AU with existing NPS/EPF" regression case (currently untestable per `08-testing-strategy.md`, unblocked once these items exist).
- **Negative controls:** forged creation of an EPF/PPF/NPS row by a non-eligible user rejected.
- **Calculation-integrity gates:** N/A for pre-existing data (brand-new catalogue items have no existing rows to preserve); Forecasting/DNA must be confirmed to NOT silently apply India-specific logic to these new items unless separately built and certified (per PO-1's "do not create product-specific tax or forecasting logic merely by adding catalogue entries").
- **Data-safety gates:** confirm zero existing generic-retirement rows were converted.
- **Exit criteria:** three new items selectable, correctly gated, zero existing-data mutation, explicit documentation of which calculation engines do/do not yet support them.
- **Rollback boundary:** new catalogue rows only; reversible by removing/deactivating the rows if zero live usage exists yet.
- **Required Product Owner authority:** explicit go-ahead to begin Wave 3.

## Wave 4 — Existing-user confirmation and cross-border context

- **Objective:** implement Decision PO-3's missing-country confirmation architecture (full detail in `02-module-matrix.md` §Missing-country architecture) and build the explicit cross-border-relationship store that Waves 2/3/§10's SMSF reconciliation all depend on.
- **Scope:** confirmation UI/API; confirmation timestamp + source columns on `user_profiles` (or an audit table); an explicit "enabled cross-border countries" relationship (one-to-many, not a second scalar — see `01-canonical-architecture.md` §7/§8); GLOBAL-only enforcement for unconfirmed users; audit trail.
- **Dependencies:** none blocking from Waves 1-3, but Waves 2/3's `HOME_OR_CROSS_BORDER_COUNTRY` items are only fully meaningful once this wave's relationship store exists — may run concurrently with or before Waves 2/3 depending on future sequencing decisions.
- **Explicit exclusions:** no permanent default of the 98 unresolved users to AU or IN; no use of IP/VPN-derived location as confirmation (suggestion only); no anonymous display-country capability grant.
- **Required migrations:** yes — new confirmation-state columns and a new cross-border-relationship table.
- **Required tests:** APP-08 (missing home country → approved fallback policy, currently blocked on exactly this wave per `08-testing-strategy.md`); a full confirmation-flow E2E test; an audit-trail write test.
- **Negative controls:** an unconfirmed user's forged API request for a `HOME_JURISDICTION`/`HOME_OR_CROSS_BORDER_COUNTRY` item's creation must fail closed.
- **Calculation-integrity gates:** confirming a country must not alter any existing total.
- **Data-safety gates:** no existing record hidden/altered by a later confirmation; no historical report regenerated.
- **Exit criteria:** the 98 DEV users can be confirmed through a real flow without data loss; audit trail live-verified.
- **Rollback boundary:** new columns/table are additive; a rollback simply stops enforcing on them without needing to reverse any existing-data change (since none is made).
- **Required Product Owner authority:** explicit go-ahead to begin Wave 4.

## Wave 5 — Engine/domain alignment (Goals, Financial DNA, Resilience extensions, Investment Intelligence, Forecasting)

- **Objective:** implement the remaining Decision PO-6 scope items not already covered by Waves 1-4: Goals' jurisdiction-specific product-goal availability (reusing the dormant `goal_types.country_applicability`); any *separately researched and certified* Financial DNA/Resilience country-specific behavioural or safety-net extension (not approved or scheduled by this closure — this wave only exists to receive such a proposal if one is later brought forward); Investment Intelligence's continued India-only Tax & Cost scoping (already correct, this wave is maintenance/verification only unless a defect is found); the `forecast_profiles.country_code` staleness gap (`09-cross-border-model.md` §4) — deciding whether a country change should trigger forecast-profile re-derivation.
- **Scope:** whichever of the above sub-items are separately authorised; this wave is explicitly a container for several independently-gated pieces of work, not one atomic change.
- **Dependencies:** Wave 4 (cross-border-relationship store) for Goals' cross-border product-goal eligibility.
- **Explicit exclusions:** no country-specific DNA/Resilience scoring without its own defensible research and separate certification (Decision PO-6, reaffirmed) — this wave does not pre-approve any such extension.
- **Required migrations:** depends on which sub-item is executed; none is pre-scheduled here.
- **Required tests:** calculation regression for whichever engine changes; forecast-profile re-derivation test if that sub-item proceeds.
- **Negative controls:** forecast assumption cascade must not silently substitute AU for an unresolved/changed country (already correct today per `02-module-matrix.md` §Forecasting — this wave must not regress it).
- **Calculation-integrity gates:** full forecast/DNA/resilience regression suite green before/after.
- **Data-safety gates:** no existing forecast profile silently mutated without explicit user action or a clearly-communicated re-derivation event.
- **Exit criteria:** each authorised sub-item independently certified.
- **Rollback boundary:** each sub-item independently revertible (different files/tables).
- **Required Product Owner authority:** explicit go-ahead per sub-item — this wave is not a single go/no-go decision.

## Wave 6 — Reports and Resources

- **Objective:** implement Decision PO-6's Reports requirements (jurisdiction terminology/applicability review, domestic/cross-border separation, historical-snapshot jurisdiction-context preservation) and the Resources consistency/content work identified in `02-module-matrix.md` §Resources (no new schema needed — see Resources discrepancy resolution, `00-README.md` §D).
- **Scope:** a full sweep of `components/reports/**`/`lib/services/reportSections*.ts` for AU-only terminology leaks (the discovery baseline's disclosed residual gap); Resources' optional bespoke-vocabulary-to-ISO-code alignment decision; a Resources content-tagging accuracy audit.
- **Dependencies:** none blocking.
- **Explicit exclusions:** no new Resources jurisdiction schema or second applicability engine (already-shipped `resource_posts.jurisdiction`/`resource_faqs.jurisdiction` is reused, per PO-6's explicit instruction and this closure's own re-confirmed evidence).
- **Required migrations:** none expected for Resources (existing schema is sufficient); possibly none for Reports (presentation-layer change only) unless a report-jurisdiction-context column is found missing during the sweep.
- **Required tests:** a report-content terminology-leak test suite (new); Resources content-tagging accuracy spot-check.
- **Negative controls:** N/A (presentation-layer, no new gate).
- **Calculation-integrity gates:** report content changes must never alter a reported financial total.
- **Data-safety gates:** historical report snapshots unaffected.
- **Exit criteria:** terminology sweep complete and documented; Resources vocabulary-alignment decision made (or explicitly deferred) by the Product Owner.
- **Rollback boundary:** presentation-layer only; trivially revertible.
- **Required Product Owner authority:** explicit go-ahead to begin Wave 6.

## Final certification wave

- **Objective:** end-to-end certification of the accumulated Wave 1-6 changes before any of it is considered production-ready as a whole.
- **Scope:** AU; IN; missing country; conflicting currency; cross-border AU↔IN; existing restricted records; unsupported country; API negative controls; direct data-write controls where relevant; RLS; reports; Resources; calculation regression; rollback rehearsal — the full GEO-01..10/APP-01..10 suite (`08-testing-strategy.md`) executed live, not just designed.
- **Dependencies:** all preceding waves that are in scope for a given certification pass (this wave may run after Wave 1 alone, or after all six — certification scope depends on how many waves have actually shipped by the time it runs).
- **Explicit exclusions:** no new feature work — certification only.
- **Required migrations:** none (certification does not ship schema changes itself).
- **Required tests:** the complete GEO/APP suite, both PGlite and live-DEV, per `08-testing-strategy.md`'s reaffirmed dual-testing standard.
- **Negative controls:** every forged-creation/bypass scenario across every wave shipped so far.
- **Calculation-integrity gates:** full Net Worth/income/liabilities/retirement/forecast regression across the entire certified population, not sampled.
- **Data-safety gates:** rollback rehearsal actually performed (not just documented) for at least one representative change from each certified wave.
- **Exit criteria:** unconditional pass on every item above, or an explicit, bounded, disclosed exception list.
- **Rollback boundary:** N/A (certification itself makes no change) — but it must prove each wave's own stated rollback boundary actually works.
- **Required Product Owner authority:** sign-off to treat the certified scope as production-ready.

---

## Financial gates required for every wave (spec §62, carried forward from discovery baseline)

Every wave, before merge, must reproduce:
- Net Worth pre/post identical for every existing record not itself the direct subject of the wave's restriction.
- Income/liabilities/retirement totals pre/post identical, same basis.
- A forecast regression run confirming no forecast output changes except where the wave *intends* an assumption-set change (Wave 5 only).
- Cross-border record preservation proof (the exact style of `05-live-dev-usage-audit.md` §4-6, re-run after the change).
- A country-change regression pass (`08-testing-strategy.md` GEO-01..10).
- RLS/API negative-control tests for any new server-side gate (mirroring the SMSF forged-creation tests).

## Migration strategy (spec §63, carried forward from discovery baseline)

- **Never revise `0084`, `0089`, `0090`** — confirmed byte-for-byte unchanged throughout this closure task as well (`00-README.md` §L).
- Current migration head on `origin/main` as of this closure (2026-08-27): **`0095`** (10 new migrations landed since the discovery fork point — `0082`, `0083`, `0086`, `0087`, `0088`, `0091`, `0092`, plus 3 education/funding-goal-linkage migrations — none touching `master_financial_items`, `country_applicability`, `jurisdiction`, `resource_posts`, or `resource_faqs`, confirmed by targeted grep). **Any future wave's actual migration number must be re-checked immediately before that wave's own merge**, per this project's own established, repeatedly-triggered collision pattern (project memory: `fdh3_r6_migration_reconciliation`).
- Use `node scripts/check-migration-versions-against-branch.mjs --against=origin/main` (already exists in this repo) before every future wave's merge.

## Testing standard carried forward (spec §64)

PGlite is sufficient for schema/function/migration-rebuild verification of any future wave's catalogue backfill or new trigger logic. Anything depending on hosted-role privileges, RLS, Auth claims, or PostgREST-specific behaviour **requires live DEV verification**, exactly as SMSF's own `0090` guard needed both a PGlite cert (73/73) and a separate live-DEV cert (8/8) before it could be trusted. Full detail and specific test-ID mapping in `08-testing-strategy.md`.
