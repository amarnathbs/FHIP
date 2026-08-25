# R11 Security Verification

Full raw results of `scripts/r11_rls_certification.mjs`, run against a freshly-instantiated PGlite database with EVERY migration (`0001`-`0083`) replayed from disk (not a hand-built schema subset).

## Result: 32/32 PASSED, 0 FAILED

```
=== SETUP SANITY ===                                                    1/1
=== SECTION 1: II cross-tenant regression ===                           2/2
=== SECTION 2: professional relationship lifecycle ===                  1/1
=== SECTION 3: read isolation on every new professional_* table ===     8/8
=== SECTION 4: MANDATORY scope self-upgrade blocked ===                 2/2
=== SECTION 5: MANDATORY self-activation blocked ===                    1/1
=== SECTION 6: MANDATORY revoked-token-retry + irreversibility ===      3/3
=== SECTION 7: MANDATORY audit history unforgeable ===                  2/2
=== SECTION 8: professional_notes bounded write ===                     4/4
=== SECTION 9: report-access-log write is service-role only ===         1/1
=== SECTION 10: cross-source schema (migration 0082) sanity ===         4/4
=== SECTION 11: negative control (isolation removed MUST leak) ===      2/2
=== SECTION 12: RLS coverage (every public table) ===                   1/1
                                                                    -------
R11 RLS/SECURITY CERTIFICATION: 32 passed, 0 failed
```

183 public tables total after migration `0083`, all RLS-enabled (0 without RLS).

## Actors used

Client A (`11111111-…`), Client B (`22222222-…`, attacker), Professional P1 (`33333333-…`, authorised for A), Professional P2 (`44444444-…`, authorised for nobody relevant to A/P1). Every test uses REAL rows connected by REAL foreign keys — no malformed-UUID test counts as security evidence here (spec section 82).

## Cross-tenant security — exact results

- Tenant A reads own `ii_transactions`: 1 row seen (expected 1) — PASS.
- Tenant A reads Tenant B's `ii_transactions` by explicit `where user_id=B`: 0 rows leaked — PASS.
- Client B reads A/P1's relationship, scopes, consent audit, and P1's profile (no relationship exists between B and P1): 0 rows leaked in every case — PASS (4 separate checks).

## Professional cross-client security — exact results

- P2 reads P1's client relationship: 0 rows leaked — PASS.
- P2 reads P1's scopes: 0 rows leaked — PASS.
- P1 attempts to write a note on P2's relationship: BLOCKED by the INSERT policy's `WITH CHECK` — PASS.

## Same-user authoritative forgery — exact results (valid-FK)

- Client A attempts direct INSERT into `professional_permission_scopes` (self-service scope grant bypassing the intended API route): BLOCKED, 0 rows inserted — PASS.
- Client A attempts direct INSERT into `professional_consent_audit`: BLOCKED — PASS.
- Client A attempts direct UPDATE of an existing `professional_consent_audit` row: 0 rows affected — PASS.

## Professional scope forgery — exact results

- P1 attempts direct INSERT of a new scope grant for themselves: BLOCKED, 0 rows inserted — PASS.
- P2 attempts direct UPDATE of their own pending relationship to `active`: 0 rows affected, status remained `pending_invite` — PASS.

## Revoked-token-retry — exact results

- Relationship revoked by service-role action → P1's own subsequent SELECT of the SAME relationship row reads `status='revoked'` on the very next query — PASS.
- Attempt to un-revoke, performed AS THE SERVICE ROLE (not merely `authenticated`): the `enforce_professional_relationship_transition()` trigger raised an exception; `status` remained `'revoked'` — PASS.

## Negative control (proving the isolation tests are not vacuous)

- With RLS deliberately disabled on `professional_relationships`: Client B DOES see A/P1's relationship (1 row, expected 1) — confirms the earlier 0-row isolation result was a real block, not an accidentally-empty table.
- RLS restored: Client B sees 0 rows again — PASS.

## Reproduce

`node scripts/r11_rls_certification.mjs` from the repository root. Requires `@electric-sql/pglite` (present in the shared `node_modules`, no network access required — everything runs in-process).
