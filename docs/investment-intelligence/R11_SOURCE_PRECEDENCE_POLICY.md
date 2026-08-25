# R11 Source Precedence Policy

Versioned per spec section 30. Stored in `ii_source_precedence_policy` (migration `0082`), world-readable, admin/service-write-only (identical discipline to `ii_reconciliation_config`/`ii_sources`). Exactly one row has `is_active = true` at a time, enforced by `uidx_ii_source_precedence_policy_active`.

## Active policy: `r11-v1`

```json
[
  { "source_key": "cams", "rank": 1 },
  { "source_key": "kfintech", "rank": 1 },
  { "source_key": "manual", "rank": 2 }
]
```

## Rule

1. Lower `rank` wins outright, regardless of freshness.
2. Equal `rank` (CAMS vs KFintech): resolved by statement `as_of_date` freshness — the newer statement wins.
3. Equal `rank`, equal/unknown `as_of_date`: a final deterministic tiebreak on `source_document_id` (lexicographic), guaranteeing a total order regardless of the order candidates were passed in.

Never by import order at any step — this is what `resolvePrecedenceWinner`'s import-order-independence tests (PP-03, PP-04, PP-08 in `tests/unit/iiR11CrossSourceIdentity.test.ts`) exist to prove.

## Rationale for the specific ranking

- **CAMS and KFintech are precedence-equal**: both are AMFI-registered RTA statement providers, both have R2-certified parsers covering the identical regulated mutual-fund universe. Neither is inherently more authoritative than the other for the same real transaction — freshness is the only principled tiebreaker.
- **Manual import is lowest precedence**: it is explicitly documented (`manualImporter.ts`'s own header comment) as "NOT the production CAS parser" — a controlled/deterministic import path, not an RTA-issued statement. It should fill genuine gaps (e.g. an account an RTA statement hasn't covered yet) but never override RTA-sourced evidence for the same transaction.
- **NSDL, CDSL, broker, MFCentral are unranked** (absent from the `precedence_rules` array): no parser exists for them in R11 (see `R11_SCOPE_AND_ARCHITECTURE_RECONCILIATION.md`). `resolvePrecedenceWinner`'s `rankOf()` falls back to `Number.MAX_SAFE_INTEGER` for any unranked source, meaning it always loses to a ranked source but is still handled deterministically (never throws) if one is ever added without immediately updating the policy — a future release adds a rank when it adds the parser, not a rework of this function.

## Precedence never erases evidence

`resolvePrecedenceWinner` decides which `source_document_id` is recorded as `is_originating = true` on the canonical `ii_transactions` row. The losing source's evidence is still recorded via `ii_transaction_source_links` (`is_originating = false`, `match_basis` populated) — nothing is deleted. This mirrors R2's own "a later statement re-reporting a transaction FHIP already holds canonically" design (`ii_transaction_source_links`, migration `0040`) rather than inventing a second evidence-retention mechanism.

## Versioning

A future precedence change (e.g. adding NSDL with its own rank, or re-ranking manual relative to a newly-certified adapter) inserts a NEW row with `is_active=true` and flips the current row's `is_active` to `false` in the same transaction — the old policy version remains queryable by `policy_version` for any historical reconciliation case that recorded which policy version it used (`ii_reconciliation_cases.evidence.precedencePolicyVersion` where applicable). No migration ever rewrites an already-applied policy row's `precedence_rules`.
