# R11 Security Model

Spec sections 77-92. Every new R11 table has RLS enabled before being considered complete — verified structurally by `scripts/r11_rls_certification.mjs` Section 12 (`select ... where not c.relrowsecurity` returns 0 rows across all 183 public tables in the freshly-replayed database, migrations `0001`-`0083` included).

## Test actors used

Client User A, Client User B (attacker), Professional P1 (authorised for A), Professional P2 (authorised for nobody relevant to A/P1). All fixtures are REAL rows with real foreign keys — `scripts/r11_rls_certification.mjs` never tests malformed-UUID rejection as security evidence (spec section 82's explicit requirement).

## Mandatory attack scenarios — result summary (full detail in `R11_SECURITY_VERIFICATION.md`)

| # | Attack | Result |
|---|---|---|
| 1 | Professional scope self-upgrade (direct INSERT into `professional_permission_scopes`) | BLOCKED — no INSERT policy for `authenticated` at all |
| 2 | Professional self-activates own pending invite | BLOCKED — no UPDATE policy for `authenticated`; 0 rows affected |
| 3 | User forges own delegated relationship's system audit fields | BLOCKED — no INSERT/UPDATE policy on `professional_consent_audit` for `authenticated` |
| 4 | Trusted service processes documents / creates reconciliation / applies precedence / creates consent audit / enforces lifecycle | CONFIRMED WORKING — this is the entire `documentProcessing.ts`/`access.ts` write path, exercised throughout the regression suite |
| 5 | Structured-data-scoped professional attempts raw-file storage access | STRUCTURALLY UNREACHABLE — see `R11_RAW_DOCUMENT_GOVERNANCE.md` |
| 6 | Professional without `VIEW_REPORTS` attempts report access | DENIED — `checkReportAccess` pins the scope check |
| 7 | **Revoked-token-retry** (mandatory) | DENIED immediately, at 3 independent levels — see `R11_CONSENT_AND_REVOCATION.md` |
| 8 | Cross-household link attack (linking A's evidence to B's canonical holding) | Structurally impossible — every R11 table keys off `account_id`/`instrument_id`, both of which are already `user_id`-scoped via existing R1/R2 RLS (`ii_accounts`/`ii_instruments`' own policies, untouched); `resolveCrossSourceTransactionMatch` is only ever called with candidates already filtered to one `user_id`'s `documentProcessing.ts` run |
| 9 | User/professional directly marks `source=RECONCILED` / sets priority / declares winner / marks conflict resolved | BLOCKED for the professional (no write path to `ii_reconciliation_cases` at all — no RLS grant to professionals on that table); the pre-existing R2 "own ii_reconciliation_cases: for all" policy still lets the CLIENT resolve their own cases through the existing bounded UI flow — unchanged R2 behaviour, not something R11 introduced or widened |
| 10 | Audit/consent history forgery | BLOCKED — `professional_consent_audit` has no authenticated write policy of any kind; rows are written exclusively by `SECURITY DEFINER` triggers as a side effect of a real, already-validated state transition |

## Professional-specific mandatory scenarios

| # | Attack | Result |
|---|---|---|
| A | P1 accesses B's data (B never invited P1) | DENIED — `NO_RELATIONSHIP` |
| B | P2 reads P1's client relationship/scopes | DENIED — RLS filters by `professional_user_id = auth.uid()`; 0 rows leaked |
| C | P1 writes a note on a REVOKED relationship | BLOCKED — the INSERT policy's `WITH CHECK` re-verifies `status='active'` at write time |
| D | P1 writes a note on P2's relationship | BLOCKED — the INSERT policy's `WITH CHECK` re-verifies `r.professional_user_id = auth.uid()` |
| E | P2 forges a report-access-log entry | BLOCKED — no INSERT policy for `authenticated` |

## Trigger-based defense in depth (beyond RLS)

Two triggers exist specifically because RLS alone cannot express "even the trusted service must never do X": `enforce_professional_relationship_transition()` (identity columns immutable; `revoked`/`expired`/`declined` are terminal) and `enforce_professional_scope_irreversible_revocation()` (a revoked scope grant can never be un-revoked). Both were proven to actually fire against the SERVICE ROLE, not just against `authenticated` (`scripts/r11_rls_certification.mjs` Section 6) — closing the gap where a future application bug in the trusted service could otherwise undo a revocation.
