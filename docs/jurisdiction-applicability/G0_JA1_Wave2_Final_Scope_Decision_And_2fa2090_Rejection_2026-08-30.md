> **HISTORICAL — SUPERSEDED**
>
> This report does not represent the current Wave 2 status. Read:
> [`G0_JA1_Wave2_Final_Scope_Decision_2026-08-30.md`](./G0_JA1_Wave2_Final_Scope_Decision_2026-08-30.md)
>
> **Current status:**
> - 11/20 items functionally realigned;
> - Australian Shares applicability unresolved;
> - 8 proposed variants classified but 0/8 functionally certified;
> - `2fa2090` rejected and unreleased.

---

# G0-JA-1 Wave 2 — Final Scope Decision and Closure-Hotfix Disposition

**Date:** 2026-08-30
**Type:** Product Owner decision record. Supersedes the completeness claims in `G0_JA1_Wave2_Detailed_Report_2026-08-28.md` and `G0_JA1_Wave2_Detailed_Report_2026-08-29_CLOSURE.md`, and formally rejects the closure hotfix `2fa2090` as currently designed. Documentation-only — no code, migration, branch, or deployment action taken as part of this record.

---

## 1. Decision on the eight label-variant items — Path 2 (formally narrow the claim)

**Decision: do not build a generic label-variant/rendering mechanism now.** The issue is deeper than display text.

### 1.1 Why a simple label substitution is unsafe

Several of the eight items classified `GLOBAL_WITH_JURISDICTION_VARIANT` are not guaranteed to be the same financial concept across Australia and India — treating them as one underlying item with a swapped label risks misrepresenting the product, not just its wording:

| AU label | Naive IN substitution | Why this is not safe as a same-item relabel |
|---|---|---|
| Superannuation | Provident Fund | Superannuation is not automatically equivalent to Indian EPF, PPF, or NPS — different contribution rules, tax treatment, withdrawal conditions, and regulatory bodies. EPF, PPF, and NPS remain separate future India-retirement catalogue products, as already decided elsewhere in this project — they are not label aliases of Superannuation. |
| Personal concessional / non-concessional contribution | (no direct IN equivalent) | These are specifically Australian tax/superannuation concepts (concessional-cap taxation, co-contribution eligibility) with no structural equivalent to relabel onto. |
| Salary sacrifice | (no direct IN equivalent) | Eligibility, contribution caps, and tax treatment are Australian-specific; there is no guarantee an equivalent Indian mechanism carries the same properties. |
| Council rates | Property tax | Broadly similar in function (a local-government property levy) but not confirmed to be the same canonical item for calculation/reporting purposes without explicit semantic review. |
| Body corporate | Owners-corporation / strata / housing-society charges | Plausibly the same underlying concept, but this requires explicit semantic confirmation, not an assumed one-to-one relabel. |

Relabelling any of these onto one shared item identity without that confirmation could silently corrupt calculations, reports, guidance, or regulatory meaning for whichever jurisdiction inherits the wrong assumptions.

### 1.2 Required Wave 2 status (corrected)

Wave 2's verdict is corrected to:

> **CONDITIONAL PASS — 12 restricted-item applicability implemented; eight proposed jurisdiction variants classified but not functionally or semantically certified.**

**No claim that all 20 items are fully realigned is permitted.** The prior framing ("20-item realignment complete") is retracted.

### 1.3 Immediate documentation corrections (applied by this record)

The Wave 2 report and issue register are corrected to state, explicitly:

- Eight items are classified `GLOBAL_WITH_JURISDICTION_VARIANT`.
- No variant resolver or rendering mechanism exists.
- Current labels remain unchanged (no relabelling has occurred).
- **Functional variant coverage: 0/8.**
- No claim of full 20-item functional completion is permitted, now or previously.
- The future semantic-certification wave (below) owns this work.
- **EPF, PPF, and NPS are not label aliases of Superannuation and remain separate future India-retirement catalogue products**, per the existing, unchanged decision elsewhere in this project.

`docs/jurisdiction-applicability/G0_JA1_Wave2_Detailed_Report_2026-08-28.md` and `G0_JA1_Wave2_Detailed_Report_2026-08-29_CLOSURE.md` should be read together with this record as the corrected, current status — this record is the authoritative one where the two conflict.

### 1.4 Recommended future phase: Jurisdiction Terminology and Semantic Variant Certification

A separate future phase, not yet scheduled or scoped for implementation, should classify each of the eight items into exactly one of three outcomes before any label-rendering mechanism is built:

| Outcome | Meaning |
|---|---|
| **True label variant** | Same financial concept and calculation identity; only wording changes |
| **Jurisdiction-specific product** | Separate catalogue identity, rules, and calculations required |
| **Neutral global item** | Use one jurisdiction-neutral label everywhere |

**For every item proposed as a true label variant, that phase must require proof that all of the following remain identical across jurisdictions:**

1. Financial meaning
2. Input fields
3. Calculation treatment
4. Tax/regulatory assumptions
5. Reporting treatment
6. Forecast behaviour
7. User eligibility

**If any of the seven differ materially, the item must become a separate catalogue product, not a relabelled shared item.** Only items that survive this proof should ever use a shared jurisdiction-label mechanism — the mechanism itself should not be built until at least one item has passed this certification, so it is designed against a real, proven case rather than speculatively.

---

## 2. Closure hotfix `2fa2090` — **REJECTED, do not push, merge, or deploy**

**Decision: `2fa2090` (branch `fix/g0-wave2-closure-hotfix`, worktree `D:/fhip-g0-wave2`) must not be released as currently designed.**

### 2.1 Why

`2fa2090` contains exactly the behaviours already identified as problematic:

- **Missing/invalid country defaults to Australia** (`resolveCountryForApplicability()`'s fallback) — an unresolved or forged country value (e.g. `'ZZ'`) is silently treated as AU for catalogue-applicability purposes.
- **AUD preferred currency acts as an Australian Shares eligibility signal** (`CURRENCY_ALTERNATE_SIGNAL`, scoped to `investment::australian_shares`) — a user's currency preference stands in for their actual home country.

Both were accepted at the time as narrow, explicit, PO-approved trade-offs *because no better signal existed* — the platform had no compulsory, verified country-of-residence field to resolve against.

**That premise no longer holds.** [[Mandatory Country Confirmation]] (`country_of_residence`, `country_confirmed_at`, `country_source` on `user_profiles`) is now a compulsory, gate-enforced field for every user before they can access financial data at all. Once that gate is live, there is no longer a legitimate "unresolved country" case for an active user to fall back through — and no reason to infer country from currency preference when a confirmed, authoritative country value exists on every user.

**Australian Shares eligibility, and every other restricted-item applicability decision, must resolve through the user's confirmed home country** (`user_profiles.country_of_residence`, once confirmed) **or the future canonical cross-border model — never through preferred currency, and never through a silent default.** Continuing to ship `2fa2090`'s currency-inference and default-to-AU logic would reintroduce exactly the problem Mandatory Country Confirmation exists to eliminate, on the same day that gate is meant to close it.

### 2.2 Disposition

- `2fa2090` stays committed, **not pushed, not merged, not deployed** — unchanged from its current state.
- It is not scheduled for release in its current form. Before it (or a successor) can be authorised, catalogue applicability resolution needs to be **redesigned to read the confirmed `country_of_residence` field directly**, removing both the AU-default fallback and the currency-based signal entirely.
- This redesign is not authorised as work yet — it is recorded here as the known next step, pending your separate go-ahead, after Mandatory Country Confirmation's own remaining closure items are done.

---

## 3. Final Product Owner decisions, recorded verbatim

1. **Defer the eight label variants with honest conditional scope** — Wave 2 = `CONDITIONAL PASS`, 0/8 functional variant coverage, no 20-item completion claim.
2. **Do not release `2fa2090`** — rejected in its current form; superseded by Mandatory Country Confirmation.
3. **Complete Mandatory Country Confirmation first** — its own remaining closure items take priority over any Wave 2/catalogue-applicability rework.
4. **Later, perform item-by-item semantic certification before building any label mechanism** — via the Jurisdiction Terminology and Semantic Variant Certification phase (§1.4), not before.

No code, migration, or deployment action was taken to produce this record. It is a documentation and decision record only.
