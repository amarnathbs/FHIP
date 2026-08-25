# II-R10 — Report Provenance

Status: EXTENDED. `report_snapshots`'s pre-existing provenance model
(migration 0010, spec sections 66-69) now also covers the five new
Investment Intelligence chapters.

## Provenance model (pre-existing, unchanged in shape)

One `report_snapshots` row per material source captured at generation time:
`snapshot_type`, `source_entity_id`, `source_version`, `source_as_of_date`,
`snapshot_metadata_json`. Immutable once written — no UPDATE path exists
anywhere in the app for this table even before this session (confirmed
during discovery), and after this session's security fix (migration 0070)
it is additionally impossible to write directly via REST as any role other
than service_role.

## New rows added this session (`lib/services/reportsData.ts::generateReport`)

| snapshot_type | source_version | Populated when |
|---|---|---|
| `ii_performance` | the R4 engine's own `engineVersion` string | `premium.investmentPerformance` is non-null |
| `ii_sip` | the R5 SIP engine's own `engineVersion` string | `premium.sip` is non-null |
| `ii_xray` | the R5 X-Ray engine's own `engineVersion` string | `premium.xray` is non-null |
| `ii_tax` | the R6 tax engine's own `engineVersion` string | `premium.taxAndCost` is non-null |
| `ii_review` | fixed string `'ii-r9-review-centre'` (Review Centre has no single "engine version" concept — each item carries its own `rule_version`, already surfaced per-item in the chapter's `sectionData.items[].ruleVersion`) | `premium.reviewItems` is non-null |

Every `source_version` value above is read directly off the canonical
engine's own result object (`results.engineVersion`) — never a string R10
invents or hardcodes independently of the engine.

## User-facing provenance (spec section 67-68)

Each of the five new chapters carries `sourceReferences` in its
`BuiltSection` (visible in `report_sections.source_references_json`):
`{ module: 'ii-r4-performance' | 'ii-r5-sip' | 'ii-r5-xray' |
'ii-r6-tax-cost' | 'ii-r9-review-centre', engineVersion, asOfDate }`. The
in-app preview does not currently render this block to the end user as a
formatted "Portfolio data as of..." sentence (spec section 67's UX
suggestion) — it is present in the data contract and available to a future
UI pass, but no new UI copy was added this session beyond each chapter's
own narrative text (which does include the as-of date in plain language,
e.g. "as of 2026-08-24").

## Verified this session

- Unit-level (`tests/unit/reportsIIChapters.test.ts`): every chapter's
  `sourceReferences.engineVersion` was asserted to equal the exact fixture
  engine version passed in — the check that would catch a hardcoded/wrong
  version string being silently substituted.
- Not verified: a live report's `report_snapshots` rows were not
  independently re-queried and compared against the report's own
  `report_sections.source_references_json` end-to-end this session (the
  live-DEV test user had no II data, so no `ii_*` snapshot rows were
  actually created to inspect — see `R10_ACCEPTANCE_REPORT.md`).
