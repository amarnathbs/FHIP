# Final Role/Capability Matrix (Post-Dispatch)

Extends `A1_04_ROLE_CAPABILITY_MATRIX.md` (unchanged, still authoritative for CAP-01 through CAP-36) with exactly what this dispatch changed. **No cell in `A1_04` itself was edited** — this document is additive, per Standard §14 (no hidden scope expansion).

## 1. CAP-16 split (A3.3) — role grants unchanged, only the capability's internal structure changed

| Capability | Analyst | Author | Editor | Compliance Reviewer | Publisher | Resource Admin | Super Admin |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| CAP-16a `requireBenchmarksAdmin` (was part of CAP-16) | — | — | — | — | — | — | Y |
| CAP-16b `requireRecommendationsAdmin` (was part of CAP-16) | — | — | — | — | — | — | Y |
| CAP-16c `requireAIPlatformAdmin` (was part of CAP-16) | — | — | — | — | — | — | Y |

**Identical to the original CAP-16 row in every cell.** No role gained or lost access. This table exists only to show the capability is now 3 independently-named rows instead of 1, per Standard §2 — the grant pattern itself did not change (mission §15.1's own A2 FULL PASS bar: "no new role or access expansion occurred," satisfied here for A3 too).

## 2. PC6/PC7 capabilities (pre-existing, newly given canonical-shell nav visibility this dispatch — not newly granted)

These were never in `A1_02`'s numbered catalogue (they predate/postdate that catalogue's own scope from a different workstream, Investment Intelligence PC6/PC7) — recorded here for the first time as part of this dispatch's reconciliation work, not renumbered into the CAP-NN scheme to avoid implying a formal capability-catalogue change that was not requested.

| Capability | Analyst | Author | Editor | Compliance Reviewer | Publisher | Resource Admin | Super Admin |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| `referenceDataQuality` (admin_users.`can_view_reference_data_quality`, PC6/N.11) | — | — | — | — | — | — | Y (if flag set) |
| `lookthroughDataQuality` (admin_users.`can_view_lookthrough_data_quality`, PC7/O.9) | — | — | — | — | — | — | Y (if flag set) |

Both are per-admin-user boolean flags on `admin_users`, not blanket Super-Admin grants — a Super Admin without the flag set does not see the corresponding Data Governance sub-group (confirmed by the capability-driven, not `isAdmin`-driven, gating logic verified in `A2A5_07` §9.2). **No grant was created, changed, or removed by this dispatch** — only the nav-layer visibility of an already-existing, already-correctly-gated destination.

## 3. Role definitions: unchanged

Per mission §4.2, only the 7 existing canonical roles were used throughout this dispatch. No new role was created. No material role expansion occurred (§1/§2 above are both non-expanding by direct comparison). The three previously-deferred domain-neutral role proposals (`A1_19` PO-1) remain deferred, untouched.

## 4. Verdict

**Matrix is internally consistent, fully reconciled with the actual code as of this dispatch's frozen candidate (`6dea53c`).** Zero orphan capability reference: every capability named in this document maps to real, currently-existing code (`lib/services/adminAuth.ts` for CAP-16a/b/c; `lib/admin/investmentIntelligenceAdminCapabilities.ts` for the PC6/PC7 pair).
