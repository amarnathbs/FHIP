# II-R10 — Compliance & Language

## Taxonomy (spec section 31, 34)

`OBSERVATION`, `EDUCATION`, `SIMULATION`, `PERSONALISED_ADVICE` — reused
from II-R9's Review Centre (`ii_review_items.compliance_classification`),
not redefined by R10.

## This session's 5 new chapters

| Chapter | Classification | Basis |
|---|---|---|
| Investment Performance (R4) | OBSERVATION | Counts/dates/status only; no interpretive claim about direction of over/underperformance is made in the narrative |
| SIP Contribution (R5) | OBSERVATION | Renders the engine's own `observations` array, itself pre-classified `OBSERVATION` in `sipOrchestrator.ts` |
| Portfolio X-Ray (R5) | OBSERVATION | Attribution facts (weights, concentration) stated plainly, explicitly caveated as "does not add to your recorded net worth" |
| Tax & Cost (R6) | SIMULATION | Carries the engine's own `classification: 'SIMULATION'` and disclaimer string unchanged |
| Priority Review Items (R9) | Per-item, inherited from `ii_review_items.compliance_classification` | R10 renders the item's own classification; does not reclassify |

No chapter emits `EDUCATION` copy (a dedicated "what is XIRR" glossary
explainer, spec section 38/98) or `PERSONALISED_ADVICE` this session.

## Action language (spec section 32)

None of the 5 new chapters contains action/instruction language at all —
they are purely descriptive ("X% weight", "N disposals", "item title +
description"). This is the most conservative possible reading of spec
section 32 (no "Review whether..." phrasing was even attempted this
session) — a genuine gap relative to the Free/existing-Premium chapters'
`personal_action_plan`, which already does phrase things as "Review your
Investments page." A future pass could extend that same
`MODULE_REVIEW_STEP` pattern to the new chapters; not done this session.

## Adviser-style framing (spec section 5, 15)

No chapter claims to be adviser-prepared. The Tax & Cost chapter explicitly
carries "SIMULATION ONLY — NOT TAX ADVICE." The Review Centre chapter's
`limitationText` states "These are deterministic observations, not
personalised financial advice."
