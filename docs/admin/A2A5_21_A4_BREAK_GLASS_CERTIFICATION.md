# A4.4b — Break-Glass Certification

## Status: NOT STARTED (implementation). Design fully specified pre-existing (`A1_14`, PO-6-approved).

## 1. Why this remains NOT STARTED

Same reasoning as `A2A5_20` — no code exists, and this is if anything the more sensitive of the two mechanisms (`A1_14` §2: break-glass is "the one path that can reach a raw document at all"). Building it without live-negative-testing capability is the wrong order of operations.

## 2. Required properties (mission §10.5) — gap analysis

| # | Required property | Current state |
|---|---|---|
| 1 | Explicit emergency reason | NOT STARTED |
| 2 | Named operator | NOT STARTED |
| 3 | Narrow scope | NOT STARTED |
| 4 | Immediate immutable audit | Schema-ready in principle (`A1_12`'s design), no issuing code exists |
| 5 | Prominent alert | NOT STARTED — no alerting/notification infrastructure of any kind was found in this codebase for this purpose |
| 6 | Automatic expiry | NOT STARTED |
| 7 | Independent notification | NOT STARTED |
| 8 | Mandatory after-action review | NOT STARTED |
| 9 | Non-reusability | NOT STARTED |
| 10 | No silent extension | NOT STARTED |
| 11 | No deletion/alteration of the break-glass record | Would be enforced structurally by the same append-only trigger pattern as `admin_audit_events` once built — not yet applicable since no record type exists |
| 12 | Structural DB-level separation from audit-editing capability (`A1_14` §3 rule 12) | NOT STARTED — and notably, this specific property requires a *database constraint*, not a role convention, meaning it cannot be retrofitted casually; it must be designed into the schema from the start |

## 3. Negative tests this would need (mission §11 ADV-10, restated as a build checklist)

Non-emergency activation rejected; unauthorized operator rejected; missing-logging scenario proven impossible (not just "didn't happen in testing" — the logging must be structurally unbypassable, matching property 4 above); missing-alert scenario proven impossible; reuse rejected; overlong access rejected (auto-expiry enforced); after-action-review bypass rejected (the mechanism should not be usable again, or should escalate, if a prior activation's review was never completed — this specific property is not even decided in `A1_14`'s design yet, a genuinely open design question for whoever builds this). **None of these can be tested because the mechanism does not exist.**

## 4. Verdict

**NOT STARTED.** Cannot reach FULL PASS in this environment (mission §15.3). No code was written for this mechanism this pass, deliberately.
