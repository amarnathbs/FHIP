# FDH-6 — User Rules & Learning Governance

## User rules — fully owned by R8/FDH-1, unmodified by FDH-6

`fdh_user_classification_rules` (FDH-1, migration `0047`), `createPersonalClassificationRule()` (R8, `classificationReviewService.ts`), tier-1 precedence (FDH-2/R8). A user's rule always outranks a global default for that user (`domain/classificationPrecedence.ts`'s own worked example, `applyUserOverrideExample`), and never writes `fdh_merchants`/`fdh_classification_rules` — structurally incapable of it (the authenticated role has no INSERT/UPDATE policy on either table).

FDH-6 adds exactly one behaviour on top: same-priority CONFLICTING user rules are now detected (`RULE_CONFLICT`) instead of resolved by silent array order — see `FDH6_CLASSIFICATION_PRECEDENCE.md`.

## Global learning governance — domain contract already complete (FDH-2), intake wiring explicitly out of scope

`lib/financial-data-hub/domain/globalLearningGovernance.ts` and `personalPayeeGuard.ts` (both FDH-2) already implement, tested, the FULL governance state machine and PII-screening heuristic:

- `open -> admin_review -> approved/rejected/merged`, `open` can never skip straight to a decision.
- `approved`/`merged` additionally require `piiScreeningStatus === 'passed'`.
- Terminal statuses (`approved`/`rejected`/`merged`) never transition further.
- `screenForPersonalPayee()` flags digit runs (7+, account/phone-number-shaped), email addresses, UPI-handle shapes, "TRANSFER TO/PAID TO/SENT TO ..." phrasing, and short bare-word narratives with no recognised business/institution indicator — conservatively (a false positive just means "held for admin review").

Both modules' own header comments explicitly say this is "NOT the admin review screen — a future phase builds that UI" and that FDH-2 wires up no HTTP route or server action that calls them. Building the actual candidate-intake pipeline (turning a personal rule's accumulated evidence into a `fdh_global_learning_candidates` row) and the admin review screen is out of FDH-6's scope per:
- spec section 91 ("do not build an admin transaction browser"),
- the existing code's own stated ownership boundary,
- spec section 125's own explicit allowance to report this area **N/A**.

**Result: no automatic global promotion exists anywhere in this codebase (proven by absence — no code path writes `fdh_merchants`/`fdh_classification_rules` from user-derived data), which is exactly what spec sections 13-15 require. Candidate-global workflow: N/A.**

## Personal payees (spec section 15)

Never promoted to the global merchant database. `GLOBAL_MERCHANT_VS_PRIVATE_COUNTERPARTY_BOUNDARY` (FDH-2) documents this as a real, importable fact; the certification pack's `[IN-03]` case proves a bare personal name (`"UPI/RAVI KUMAR/9876543210"`) never resolves to a merchant match.

## Classification history — unchanged, R8

`fdh_classification_history` (FDH-1 schema, R8 writer) remains append-only (SELECT+INSERT RLS, no UPDATE/DELETE policy at all), every automatic reclassification recorded with `previous_*`/`new_*`/`classification_method`/`confidence`/`changed_by_type`. FDH-6's `applyTransferClassOnConfirm()` writes through `correctTransaction()`, which layers a `fdh_transaction_corrections` row (spec section 68's before/after audit) rather than the classification-history table directly — the same pattern every other user correction already uses.
