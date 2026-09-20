# A4.4a — Support-Access Certification

## Status: NOT STARTED (implementation). Design fully specified pre-existing (`A1_14`, PO-6-approved).

## 1. Why this remains NOT STARTED

`A1_20` names this mechanism's authorization risk "High... a new access-grant mechanism is a new attack surface almost by definition." No table, RPC, route, or role exists anywhere in this repository for it today (confirmed by direct search: no `support_access_grants`-shaped table in any migration). Building an unverified access-grant mechanism, then being unable to run ADV-09's own adversarial probes against it live, would leave exactly the kind of standing risk the mission's stop conditions (§14: "support access can be reused or extended without approval") exist to catch before it ships — not after.

## 2. Required properties (mission §10.4) — gap analysis against current state

| # | Required property | Current state |
|---|---|---|
| 1 | No standing access to personal financial information | Trivially true — no mechanism exists, so no standing access of any kind exists either |
| 2 | Recorded case/purpose per grant | NOT STARTED — no grant table exists |
| 3 | Exact user or narrow scope | NOT STARTED |
| 4 | Named operator | NOT STARTED |
| 5 | User consent where applicable | NOT STARTED |
| 6 | Approved task | NOT STARTED |
| 7 | Allowed fields/actions (scope allow-list) | NOT STARTED |
| 8 | Automatic expiry, default 60 minutes | NOT STARTED |
| 9 | New approval required for any extension | NOT STARTED |
| 10 | Non-reusability across users/incidents | NOT STARTED |
| 11 | Immutable audit | Schema-ready in principle (the `admin_audit_events`/`admin_security_events` design from `A1_12` could record this once built) but no grant-issuing code exists to produce such an event yet |
| 12 | Visible active-grant status | NOT STARTED |
| 13 | Revocation | NOT STARTED |
| 14 | Independent approver for sensitive access | NOT STARTED |

## 3. Negative tests this would need before certification (mission §11 ADV-09, restated as a build checklist)

Expired-grant use rejected; cross-user reuse rejected; cross-incident reuse rejected; scope-escalation attempt rejected; extension-without-new-approval rejected; raw-document access rejected (this mechanism should never reach raw documents at all — that is break-glass's exclusive, stricter path per `A1_14` §3 rule 9); consent-bypass rejected. **None of these can be tested because the mechanism does not exist.**

## 4. Verdict

**NOT STARTED.** Cannot reach FULL PASS in this environment (mission §15.3 — "support access is narrow, approved, expiring and non-reusable" requires an implementation to test against, which does not exist). No code was written for this mechanism this pass, deliberately, per §1 above.
