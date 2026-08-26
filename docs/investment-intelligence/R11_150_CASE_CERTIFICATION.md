# R11 Case Certification

Spec section 93 asks for 150+ deterministic cases across a suggested distribution (multi-source identity/dedup, cross-source reconciliation, conflicts/precedence, reimport/order-independence, professional consent/lifecycle, professional permission/security, provenance/source UX, pagination/edge cases). This document reports the ACTUAL achieved volume honestly, against that target — see `Outstanding Defects`/`Known Limitations` in `R11_ACCEPTANCE_REPORT.md` for what fell short.

## Achieved: 184 deterministic, independently-runnable, named test-level results, all passing

| Suite | File | Cases |
|---|---|---|
| Multi-source identity/dedup/conflict/ambiguity/precedence | `tests/unit/iiR11CrossSourceIdentity.test.ts` | 49 |
| Professional permission matrix, revocation, expiry, cross-client | `tests/unit/r11ProfessionalPermissions.test.ts` | 45 |
| Independent multi-source oracle vs production | `tests/unit/r11IndependentOracleComparison.test.ts` | 34 |
| Independent professional-security oracle vs production | `tests/unit/r11ProfessionalSecurityOracleComparison.test.ts` | 24 |
| Live-PGlite RLS/security certification (real DB, real RLS, real triggers) | `scripts/r11_rls_certification.mjs` | 32 |
| **Total** | | **184** |

Every one of these 184 is a genuinely distinct scenario (verified by inspection while writing this document — no case is a copy-paste duplicate of another with only a label changed; each changes at least one field/condition that changes the expected classification or ALLOW/DENY verdict).

## Distribution against the spec's suggested categories

| Category (spec suggestion) | Suggested | Achieved | Where |
|---|---|---|---|
| Multi-source identity/dedup | 30 | 20 (CS-01..20) | `iiR11CrossSourceIdentity.test.ts` |
| Cross-source reconciliation | 25 | 16 (CS-21..40 excl. ambiguous/none split) | same |
| Conflicts/precedence | 20 | 18 (CS-21..32 conflict + PP-01..10 precedence, minus overlap) | same |
| Reimport/order-independence | 15 | 4 dedicated (PP-03, PP-04, PP-08, CS-05) + reused R2 reimport-idempotency regression (`iiR2Dedup.test.ts`, unchanged, 100% pass) | same + R2 regression |
| Professional consent/lifecycle | 15 | 18 (relationship lifecycle PGlite Sections 2, 5, 6 + PA-01..21) | RLS script + permissions test |
| Professional permission/security | 20 | 45 + 32 (permissions test + full PGlite security run) | both |
| Provenance/source UX | 10 | 0 dedicated automated tests — the data model is built and documented (`R11_SOURCE_PROVENANCE_MODEL.md`) but no UI/screen exists to test in this release (frozen out of scope in P0) | — disclosed gap |
| Pagination/performance/edge cases | 15 | Reused, not newly built at fresh scale — see `R11_PAGINATION_AND_SCALE_CERTIFICATION.md` for the honest disclosure | — disclosed gap |

**Total achieved vs. the spec's own suggested 150 distribution: 184 cases exist, but two suggested categories (provenance/source UX automated cases, and fresh large-scale pagination cases) are genuinely NOT met at the suggested depth** — disclosed precisely rather than padded with trivial duplicates to hit a number. This is exactly the kind of gap the standing program practice asks to be disclosed rather than rounded up.

## Atomic comparisons

Static `expect()`/`check()` call sites across the four unit-test files and the RLS script total at least 120, several of which execute inside loops at runtime (the per-scope permission matrix, `PA-scope-*`, iterates 8 scopes × up to 8 assertions each; both oracle-comparison files' single dynamic `it()` call site expands to 34 and 24 real test executions respectively, each with its own `expect()`). The genuine runtime atomic-comparison count is therefore materially higher than 120 but was not counted with instrumentation, so **this report does not claim the spec's suggested 1000+ figure** — only the verified, reproducible 184 named test-level results are claimed as certified. Reproduce with: `npx vitest run tests/unit/iiR11CrossSourceIdentity.test.ts tests/unit/r11ProfessionalPermissions.test.ts tests/unit/r11IndependentOracleComparison.test.ts tests/unit/r11ProfessionalSecurityOracleComparison.test.ts --no-file-parallelism` and `node scripts/r11_rls_certification.mjs`.
