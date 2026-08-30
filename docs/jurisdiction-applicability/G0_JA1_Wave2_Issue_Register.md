# G0-JA-1 Wave 2 — Issue Register

**Date:** 2026-08-30
**Authoritative source:** [`G0_JA1_Wave2_Final_Scope_Decision_2026-08-30.md`](./G0_JA1_Wave2_Final_Scope_Decision_2026-08-30.md)
**Current Wave 2 status:** CONDITIONAL PASS — **11/20 items functionally realigned**; 1 Australian Shares contradiction unresolved; 8/8 variants classified, **0/8 functionally certified**.

Product Owner decisions already made are recorded as **decided**, not as pending. Only genuinely open work appears as Open.

---

## Register

| ID | Issue | Current state | Severity | Blocks Wave 2 FULL PASS | Future owner | Required action |
|---|---|---|---|---:|---|---|
| W2-AR-1 | Australian Shares class/data/runtime contradiction | Open | Material completeness | Yes | Australian Shares applicability redesign | Use confirmed home country or future verified AU cross-border context |
| W2-SV-1 | Eight variants not semantically certified | Open, 0/8 functional | Material completeness | Yes | Jurisdiction Terminology and Semantic Variant Certification | Review each item against seven identity tests |
| W2-MCC-1 | Mandatory Country Confirmation not yet released | Dependency pending — DEV migration + live certification complete; merge and production release outstanding | Release dependency | Yes for successor applicability implementation | MCC workstream | Merge to `main`, then controlled production migration and release |
| W2-HF-1 | Hotfix `2fa2090` rejected | Resolved decision | Historical | No | None | Preserve as rejected evidence; do not release |

---

## Detail

### W2-AR-1 — Australian Shares class/data/runtime contradiction

**State: Open.** Migration `0102`, as deployed, records `investment.australian_shares` with `applicability_class = 'HOME_OR_CROSS_BORDER_COUNTRY'`, `country_applicability = NULL`, and globally-creatable runtime behaviour. The class asserts a country-based restriction that neither the data nor the runtime enforces.

**Not resolved by anything currently released.** The rejected hotfix `2fa2090` and its unmerged migration `0103` must not be counted as a resolution.

**Required action:** eligibility must resolve from the user's confirmed home country, or from the future verified AU cross-border relationship. Existing records are always preserved. Currency must never grant eligibility; missing or invalid country must never default to AU.

**Owner:** Future Phase A — Australian Shares applicability redesign. Not authorised, not started.

### W2-SV-1 — Eight variants not semantically certified

**State: Open, 0/8 functional.** The eight `GLOBAL_WITH_JURISDICTION_VARIANT` items carry a metadata classification only. No jurisdiction-label resolver or rendering mechanism exists, and none is to be built now. Labels are unchanged.

**Required action:** review each of the eight items individually against the seven identity tests (financial meaning; input fields; calculation treatment; tax and regulatory assumptions; reporting treatment; forecast behaviour; user eligibility) and classify each into exactly one of `TRUE_LABEL_VARIANT`, `JURISDICTION_SPECIFIC_PRODUCT`, `NEUTRAL_GLOBAL_ITEM`. If any test differs materially, separate catalogue identities are required. EPF, PPF and NPS remain separate future Indian retirement products, not aliases.

**Owner:** Future Phase B — Jurisdiction Terminology and Semantic Variant Certification. Not authorised, not started.

### W2-MCC-1 — Mandatory Country Confirmation not yet released

**State: Dependency pending.** Mandatory Country Confirmation establishes the approved authoritative country source (`user_profiles.country_of_residence`, `country_confirmed_at`, `country_source`). It is implemented on `feature/mandatory-country-confirmation-beta-cleanup` (HEAD `8621968`, carrying migration `0111`).

> Migration `0111` has been applied to DEV and independently live-verified 28/28, with zero residual synthetic users. Mandatory Country Confirmation remains unmerged to `main` and is not production-live.

Production users are not yet confirmation-gated. The three gates are tracked separately: DEV migration + live certification is **complete**; merge to `main` is **not complete**; production migration and deployment are **not complete**.

**Required action:** complete responsive/OAuth/session UX certification, merge to `main`, and perform the controlled production migration and release. Live DEV certification of `0111` is no longer outstanding.

**Consequence:** Wave 2 applicability rework stays paused until this is fully released — successor applicability implementation depends on an authoritative country value that is not yet live.

**Owner:** MCC workstream.

### W2-HF-1 — Hotfix `2fa2090` rejected

**State: Resolved decision — no action pending.** Commit `2fa2090` on `fix/g0-wave2-closure-hotfix` (historical worktree `D:/fhip-g0-wave2`), carrying migration `0103`, is formally **REJECTED — do not push, merge or deploy**. It contains missing/invalid country defaulting to AU, and AUD preferred currency acting as an Australian Shares eligibility signal; both conflict with the canonical jurisdiction architecture.

**Required action:** preserve unchanged as historical evidence of a rejected design. Do not push, merge, deploy, apply `0103`, cherry-pick, copy its AU fallback or currency signal, delete, or rewrite it.

---

## Closed by Product Owner decision — not pending

| Former open question | Decision |
|---|---|
| Build the 8-item label-variant mechanism now, or narrow Wave 2's claimed scope? | **Narrow the claim.** Wave 2 is 11/20; 0/8 variants functional; no resolver to be built now. |
| Should `2fa2090` be pushed/merged/deployed? | **No — rejected.** |
| Should EPF/PPF/NPS be added as Superannuation label variants? | **No.** They remain separate future Indian retirement products. |
