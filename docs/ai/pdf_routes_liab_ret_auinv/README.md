# PDF routes for liability, retirement and Australian investment statements

Decision (Product Owner, 19/10/2026, final): the three screens that accepted CSV only now accept PDF too. Branch
`feat/pdf-routes-liability-retirement-au-investment-20261019`. The report is `../PDF_ROUTES_REPORT_2026-10-19.md`; start there.

| File | What it is |
|---|---|
| `00_COMMON_SPEC.md` | The rules shared by the three classes: what is reused, the flow, the refusal table, units, signs, dates, the one rounding rule, the kill switches |
| `01_SPEC_LIABILITY.md`, `02_SPEC_RETIREMENT.md`, `03_SPEC_AU_INVESTMENT.md` | Per class: the existing CSV route found in the code, fields, certified layouts, reconciliation rules, refusal and review conditions. Written before the readers and the corpus |
| `corpus/` | 25 deterministic synthetic PDFs (no real personal data; the numbers are invented and fail their real check digits) and `MANIFEST.sha256` |
| `EXPECTED_VALUES.md` | The hand-computed expected values with the arithmetic shown, generated from `scripts/pdf_routes_corpus.ts` |
| `04_DEV_PACK.md` | The exact steps and read-only checks to repeat the DEV verification, and the production steps in order |
| `evidence/` | Sanitised results of the DEV run (ids as 8 character prefixes, no document text, no secrets) |
| `MUTATION_CONTROLS_RESULT.md` / `.json` | Each guard removed in turn; the control passes only if a named test fails |

Evidence labels used everywhere: UNIT-TESTED, PGLITE-VERIFIED, DEV-verified, PRODUCTION-VERIFIED, NOT PERFORMED. Nothing in this branch is PRODUCTION-VERIFIED. No database migration is used (see the report).

Repeat the checks locally:

```
npx vitest run tests/unit/pdfRoutesCorpus.test.ts tests/unit/pdfLiabilityReader.test.ts tests/unit/pdfRetirementReader.test.ts tests/unit/pdfInvestmentReader.test.ts tests/unit/pdfRoutesServices.test.ts tests/unit/pdfRoutesRoutes.test.ts tests/unit/pdfRoutesMasking.test.ts tests/unit/pdfRoutesCostAndFlags.test.ts
node scripts/pdf_routes_mutation_controls.mjs          (about 25 minutes; restores every source file)
npx tsx scripts/pdf_routes_corpus.ts docs/ai/pdf_routes_liab_ret_auinv/corpus     (regenerates the corpus; the test fails if it differs)
git checkout -- scripts/                                (after any full-suite run)
```
