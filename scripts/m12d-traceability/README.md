# M12D traceability tooling

Regenerates `docs/aie-programme/AIE_1_REQUIREMENT_TRACEABILITY_FINAL_2026-09-15.md`.
Exists so the matrix is reproducible rather than a hand-written assertion
(`AIE16-TRACE-07`: "verify no required evidence consists only of developer
narrative ... without reproducible commands").

## Run

```
node scripts/m12d-traceability/extract.mjs  inventory.json
node scripts/m12d-traceability/cite.mjs     . inventory.json citations.json
node scripts/m12d-traceability/generate.mjs docs/aie-programme/AIE_1_REQUIREMENT_TRACEABILITY_FINAL_2026-09-15.md
```

`annotate.mjs` is the one-shot pass that added the 91 requirement-id header
comments to 27 test and live-DEV files. It is idempotent — it skips any file
already containing `M12D TRACEABILITY` — and is kept for audit, not for re-running.

## What each file is

| File | Role |
|---|---|
| `extract.mjs` | Reads the Product Owner's seven `AIE-1.x` specifications from `C:\Users\user\Downloads\` and extracts **identifiers and the requirement's own one-line title only**. No requirement body, no financial data, no PII is ever copied into this repository. |
| `cite.mjs` | Indexes every requirement-id citation across the repository with `file:line`, separating fully-qualified from short-form ids and artifact kinds from documentation. |
| `rules.mjs` | The artifact vocabulary: real repository paths and real named live-DEV scenarios, plus the quoted governing decisions. |
| `families.mjs` | The per-(phase, family) evidence profile — 192 groups, one per numbered section of the specifications. |
| `overrides.mjs` | 220 per-requirement adjudications where the family profile would be wrong. This is where the honesty lives. |
| `generate.mjs` | Emits the matrix and the tallies. |

## Two guards that matter

**Self-contamination.** M5's predecessor script wrote its orphan list into a file
under a root it then scanned, and the next run reported 100% coverage with zero
orphans — wrong in the reassuring direction. `cite.mjs` therefore excludes this
entire directory, the generated matrix and the M12D closure report by name, and
was verified idempotent across consecutive runs.

**Short-form ambiguity.** The codebase cites `GW-03`, `PII-06`, `COST-08` with the
phase prefix dropped, and `COST-01` is defined by four different phases. A short
form is counted only where its family is unique to one phase across the whole
inventory (1,224 of 2,284 qualify); the rest are discarded rather than credited
four times over.

## Requirement-source path

The specifications live **outside version control**, at
`C:\Users\user\Downloads\`, as recorded in
`docs/investment-intelligence/II_POST_PC4_MASTER_SCOPE_LEDGER_2026-09-15.md` §2.
If they move, `SPEC_DIR` in `extract.mjs` and `cite.mjs` is the single place to
change.
