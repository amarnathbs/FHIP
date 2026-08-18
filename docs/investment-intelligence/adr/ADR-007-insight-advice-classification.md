# ADR-007: Insight / Advice Classification

## Status
Accepted (R0)

## Context
Observations, education, simulations and personalised advice must have distinct classifications (design principle 15); personalised product-level investment advice is outside the current consumer MVP unless separately approved under a compliant workflow (design principle 16). FHIP already has a text-pattern advice-boundary gate (`lib/advice-boundary/check.ts`, `violatesAdviseBoundary()`) applied somewhere else in the product, confirming the platform already treats this as a real, enforced concern rather than a purely aspirational one (`R0_CURRENT_STATE_DISCOVERY.md` section 1).

## Decision
Adopt a four-tier classification (`observation | education | simulation | personalised_advice`) on `ii_insights`, with `personalised_advice` rows structurally gated (`gated boolean not null default true`, requiring a non-null `compliance_approved_at` before ever being surfaced) rather than merely documented as "should be hidden." Full taxonomy and ten worked examples: `R0_INSIGHT_CLASSIFICATION.md`.

## Alternatives considered
1. **A binary "advice / not advice" flag** — rejected: collapses the useful distinction between a neutral fact (observation), a general explanation (education), and a deterministic what-if (simulation) — each has different compliance review requirements per the spec, and collapsing them would either over-gate harmless observations or under-gate borderline simulations.
2. **Rely solely on the existing `lib/advice-boundary/check.ts` text-pattern gate, with no structural database field** — rejected as the sole mechanism: a regex-based check on *generated copy* is a useful last-line defense but is not itself an auditable, queryable classification of *why* a given insight was or wasn't shown — the structural `classification`/`gated`/`compliance_approved_at` fields make the gate provable and reportable, not just enforced.
3. **Build the classification without a hard database gate, relying on the R1 service layer to "just not query personalised_advice rows"** — rejected: convention-only enforcement of exactly the kind of high-consequence boundary (regulated financial advice) that should fail closed, not depend on every future call site remembering to filter correctly.

## Consequences
- Positive: `personalised_advice` insights can exist in the schema (for future compliant-workflow development) without any risk of accidentally surfacing to a consumer today, since the gate is structural, not just a code-review convention.
- Positive: consistent with, and can be layered on top of, the existing `advice-boundary` text-pattern check rather than replacing it.
- Negative: adds an explicit compliance sign-off step (`compliance_approved_at`) to the eventual workflow for personalised advice — an intentional friction, not an oversight.

## Migration implications
`ii_insights` is new and additive. No existing table changes. `lib/advice-boundary/` is not modified by R0 (R0 makes no code changes at all); R1 should extend it, not fork a parallel mechanism.

## Testing implications
R1's advice-boundary test (spec Section 19G, worked in `R0_INSIGHT_CLASSIFICATION.md` section 3) must be re-run as an automated test once `ii_insights` exists, and must include a test proving a `personalised_advice` row with `compliance_approved_at IS NULL` cannot be returned by any consumer-facing query path.
