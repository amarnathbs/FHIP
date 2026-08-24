# II-R10 — Storytelling Rules

Status: REUSED governed layer (`report_content_library`,
`lib/services/reportContentData.ts`, `lib/engines/reportNarrative.ts`) for
the 18 pre-existing sections; the 5 new II chapters use a narrower,
intentionally low-risk narrative approach documented below rather than
extending that library this session.

## Pre-existing storytelling layer (unchanged)

`report_content_library` (Report v3 Phase 3a, migrations 0025-0027) is the
single governed source for narrative copy across the Free and pre-existing
13 Premium sections, replacing the old hardcoded `reportCopy.ts` constants.
Not touched this session.

## The 5 new II chapters' narrative approach (this session)

Rather than inventing new threshold bands/rule-keyed templates for
Investment Performance, SIP, X-Ray, Tax & Cost and Review Centre this
session, each chapter's narrative text is deliberately constructed ONLY
from:

1. **Counts and dates** the loader already computed (e.g. "3 of 5 currency
   portfolios have enough history...", "12 of 15 SIP series are
   presentable...") — arithmetic on already-certified data, not a new
   interpretation of it.
2. **Text the source engine already produces and explicitly marks safe to
   render** — SIP's `observations` array (`R5InsightClassification`,
   literally documented in `sipOrchestrator.ts` as "Descriptive statements,
   safe to render verbatim. Never advice"), the tax engine's own
   `disclaimer`/`residencyNote`/`ruleVersionNote` strings, and Review
   Centre items' own `title`/`description` fields (the Review Centre's own
   deterministic rule engine already produced these — R10 renders them
   verbatim, never reinterprets them).
3. **A single top-line fact selected by a real comparison** (e.g. "your
   largest sector exposure... is X at Y%" — the largest bucket by
   `effectiveWeight`, asserted correct in
   `tests/unit/reportsIIChapters.test.ts`).

This means: **no new effective-dated rule library, no new compliance
taxonomy classification tags, and no new threshold-band configuration were
created this session** for the 5 II chapters — narrative content is either
a safe pass-through of engine-produced text, or a plain factual count/date
statement. This is a deliberately conservative choice: writing a genuinely
new rule library (rule key, condition, priority, compliance classification,
effective date, versioned templates per spec section 33-36) for 5 new
domains in one session, without the certification volume to prove it
correct across many scenarios, was judged higher-risk than staying
descriptive.

## Compliance classification (spec section 31, 34)

Every new chapter's content is `OBSERVATION` (counts, dates, verbatim
engine text) or the engine's own `SIMULATION` classification (Tax & Cost:
`results.classification === 'SIMULATION'`, carried through unchanged).
None of the 5 new chapters contains `EDUCATION` copy (a "what does XIRR
mean" explainer, spec section 38/98) or any `PERSONALISED_ADVICE` — the
Review Centre chapter's own `limitationText` explicitly states "These are
deterministic observations, not personalised financial advice."

## Narrative contradiction protection (spec section 37, 89)

`tests/unit/reportsIIChapters.test.ts` includes:
- A source-module-assertion test that the SIP chapter's rendered
  observations are byte-identical to the engine's own array (nothing
  synthesised).
- A test that Review Centre item text is rendered verbatim, plus an
  explicit assertion the narrative never contains "on track" or "no action
  needed" language when a gap-detected item is present.
- A test that the X-Ray chapter's "largest sector" claim in the narrative
  always matches the actual highest-weighted bucket in the same
  `sectionData`, not a stale or mismatched value.

No general-purpose cross-chapter contradiction suite (e.g. Goals chapter
says ON_TRACK while a different chapter implies off-track) was built this
session — the 5 new chapters do not currently cross-reference goal status
at all, so that specific contradiction class has no surface to test yet.
