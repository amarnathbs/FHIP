# R8 — Classification Provenance

## 1. Every classified transaction can answer "why"

`EconomicTypeResult.explanation` (`economicTypeEngine.ts`) is always a
deterministic, human-readable sentence built from real match facts — never
an LLM-generated summary (spec section 45/57):

- `"Matched your own rule "description_contains"."` — user rule
- `"Matched canonical merchant "Woolworths" from an approved alias match."` — merchant
- `"Matched approved global rule "income_salary_generic"."` — global rule
- `"No rule or merchant matched this transaction. Needs manual review."` — unresolved

## 2. Persisted provenance, not just a transient string

| Field | Where | What it proves |
|---|---|---|
| `fdh_transactions.classification_method` | transaction row | Which TIER won (`merchant_master`/`global_rule`/`user_rule`) |
| `fdh_transactions.classification_confidence` | transaction row | HIGH/MEDIUM/LOW/UNRESOLVED, mapped to a fixed numeric bucket (never a fabricated percentage — spec section 44) |
| `fdh_classification_history.global_rule_id` / `.user_rule_id` | append-only history | Exactly WHICH rule fired, by real foreign key — never a free-text description that could drift from the actual rule |
| `fdh_classification_history.changed_by_type` | append-only history | `system` (the engine) vs `user` (a correction) — the two are structurally distinguishable at write time (migration 0067 blocks an authenticated client from self-attesting `system`) |
| `fdh_transaction_links.match_evidence` | link row | The exact comparison facts (amount, date delta, accounts, same-reference flag) behind a proposed transfer/settlement/refund link |
| `fdh_transaction_links.created_by_method` | link row | `algorithm` (R8's matching engine) vs `user_manual`/`admin` |

## 3. Version/provenance chain across releases

A classified transaction's full lineage is reconstructable without
re-running anything: `fdh_transactions.parser_version_id` (which R7 adapter
produced the row) → `fdh_transactions.classification_method` +
`fdh_classification_history` (how R8 classified it) →
`fdh_transaction_corrections` (whether and how a human later overrode it).
No step in this chain is ever silently lost — `user_override = true` is
permanent, and `fdh_classification_history` is append-only (no UPDATE/
DELETE policy at all).
