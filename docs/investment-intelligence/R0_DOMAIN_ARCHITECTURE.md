# R0 — Domain Architecture

Status: FINAL (R0)
Depends on: `R0_CURRENT_STATE_DISCOVERY.md`

## 1. Architecture diagram

```
FHIP
 |
 +-- Existing modules (unchanged by this release)
 |     Dashboard / Net Worth (lib/engines/dashboard.ts)
 |     Assets, Investments, Retirement registers (manual entry + grid UI)
 |     Goals (user_goals + goal_funding_sources + goal engines)
 |     Forecasting (lib/engines/forecast/*)
 |     Reports (reportSections.ts + report_content_library)
 |
 +-- Investment Intelligence Core (country-neutral)
       |
       +-- Identity & ownership          (household/user/owner-member linkage)
       +-- Instrument master             (global instrument concepts + identifiers)
       +-- Accounts / folios             (the container a holding sits inside)
       +-- Source documents              (uploaded statements, evidence layer)
       +-- Transaction ledger            (parsed/reconciled transaction history)
       +-- Holding snapshots / tax lots  (point-in-time and lot-level truth)
       +-- Reference data                (benchmarks, prices/NAV, fund look-through)
       +-- Analytics                     (deterministic, versioned results)
       +-- Insights                      (classified observation/education/simulation/advice)
       +-- Publishing layer              (the ONLY bridge into Assets/Investments/Retirement)
       +-- Audit / consent               (append-only event log)
       |
       +-- Country Adapter: India (first implementation)
       |     India-specific instrument types (MF/AMC/folio, NPS, PPF/EPF, demat)
       |     India-specific source categories (CAMS, KFintech, NSDL, CDSL)
       |     India-specific tax/reference rules (exit load, STCG/LTCG bands, indexation)
       |
       +-- Future Country Adapter: Australia
       |     (reuses the same Core tables/contracts — no schema rewrite; see ADR-005)
       |
       +-- Future adapters (subsequent countries)
```

## 2. Responsibility definitions

### A. Identity & ownership
Investment Intelligence does **not** introduce a new ownership model. It reuses the existing FHIP identity chain: `auth.users` → `user_id` (RLS boundary, unchanged) → optionally `household_members.id` for the legal/beneficial owner within that user's household (the same reference table Goals already uses — see `R0_CURRENT_STATE_DISCOVERY.md` section 6). Investment Intelligence adds a **legal/source owner** concept (the name/PAN-holder recorded on a CAMS/KFintech statement) which is distinct from and must be explicitly mapped to an FHIP `household_members` row before a position can publish (see `R0_FHIP_PUBLISHING_CONTRACT.md`, OWNER). Belongs: globally (the mapping mechanism), India adapter (the source-owner extraction rules).

### B. Instrument master
Global, country-neutral instrument record (an ISIN-bearing security, a mutual-fund scheme, a generic "term deposit" concept, etc.) plus country-specific extensions. Belongs: core holds the neutral shape (name, instrument class, currency, country of domicile); India adapter holds AMFI scheme codes, plan/option (growth/dividend, direct/regular) and other India-only attributes.

### C. Accounts/folios
The container a holding lives inside — a demat account, a mutual fund folio, a broker account. Country-neutral concept (every country has *some* account/folio concept); the specific identifier shape (folio number format, demat CDSL/NSDL split) is India-specific. Belongs: core holds the neutral account shape; India adapter holds folio-number parsing/validation.

### D. Source documents
The uploaded evidence (CAS PDF, broker contract note, manual entry event) that a transaction/holding was derived from. Country-neutral concept; the specific source categories accepted (CAMS/KFintech consolidated CAS, NSDL/CDSL demat statement) are India-specific today. Belongs: core holds the generic source/document/provenance model (`R0_SOURCE_PROVENANCE_CONTRACT.md`); India adapter enumerates its accepted source types.

### E. Transaction ledger
Country-neutral event stream (buy/sell/switch/dividend/SIP/redemption) reconstructed from source documents. Belongs: core.

### F. Holding snapshots
Point-in-time certified balances (units, value, as-of date) derived from the transaction ledger or directly from a statement's closing balance. Country-neutral. Belongs: core.

### G. Tax lots
Lot-level acquisition records (date, quantity, cost) needed for cost-basis and future tax-analytics work (explicitly NOT built in R0 — see non-goals). Country-neutral shape; India-specific tax treatment (STCG/LTCG holding-period rules, grandfathering, indexation) is adapter-owned reference data, never baked into the core schema. Belongs: core holds the lot shape; India adapter holds the tax-rule application (future release).

### H. Reference data
Benchmarks, price/NAV series, fund look-through (underlying holdings of a fund-of-funds). Country-neutral shape; India-specific series (Nifty/Sensex indices, AMFI NAV feed) are adapter-owned data, following the same versioned-reference-data pattern already proven by `benchmark_sources`/`benchmark_datasets`/`benchmark_update_runs` in Module 8 (Financial Twin) — see `R0_CURRENT_STATE_DISCOVERY.md` section 2 and `ADR-010`. Belongs: core owns the generic reference-data versioning contract; India adapter owns the actual India series.

### I. Analytics
Deterministic, versioned computed results (concentration, X-ray, SIP consistency, performance — **not built in R0**, architecture only). Country-neutral engine shape (mirrors the existing `lib/engines/*` pure-function-plus-version pattern). Belongs: core.

### J. Insights
Classified output (observation/education/simulation/personalised_advice — see `R0_INSIGHT_CLASSIFICATION.md`). Country-neutral shape; specific rule content may be India-specific initially. Belongs: core (classification contract), India adapter (initial rule content).

### K. Publishing layer
The **only** bridge from Investment Intelligence into FHIP's existing `assets`/`investments`/`retirement_accounts` tables and hence into `computeDashboard()`'s net worth. Country-neutral. Belongs: core, and explicitly **outside** the India adapter — publishing must work identically regardless of source country, since it targets FHIP's own country-neutral registers. See `R0_FHIP_PUBLISHING_CONTRACT.md` and `R0_NET_WORTH_DEDUP_CONTRACT.md`.

### L. Audit/consent
Append-only event log for every Investment-Intelligence-specific lifecycle action (upload, parse, reconciliation, correction, publication, NAV update, export, access grant/revoke). Country-neutral. Reuses the *concept* already scaffolded (but unused) by `audit_events`/`financial_records_audit` (`R0_CURRENT_STATE_DISCOVERY.md` section 2) without assuming those specific dead tables are reusable as-is — see `ADR-008`. Belongs: core.

### M. Country-specific extensions
Anything that would require a schema change for a second country is, by definition, misplaced in the core. The test applied throughout this document and `R0_CANONICAL_DATA_CONTRACT.md`: *"Would adding Australia require changing this table's core columns, or only adding adapter rows/config?"* — if the former, the field does not belong in the core.

## 3. Explicit global vs. India vs. "outside Investment Intelligence" boundary

| Concept | Global (Core) | India adapter | Outside Investment Intelligence (existing FHIP) |
|---|---|---|---|
| User/household identity, RLS ownership | — | — | `auth.users`, `households`, `household_members` (reused as-is) |
| Legal/source owner → FHIP owner mapping mechanism | ✅ | — | — |
| Instrument neutral shape (name, class, currency, domicile) | ✅ | — | — |
| AMFI scheme code, plan/option, folio-number shape | — | ✅ | — |
| Source categories: manual/admin-correction | ✅ | — | — |
| Source categories: CAMS/KFintech/NSDL/CDSL/MFCentral | — | ✅ | — |
| Transaction ledger event shape | ✅ | — | — |
| STCG/LTCG/exit-load/indexation rule *content* | — | ✅ (future release) | — |
| Tax-lot shape | ✅ | — | — |
| Benchmark/NAV series versioning contract | ✅ | — | — |
| Nifty/Sensex/AMFI NAV series *data* | — | ✅ | — |
| Insight classification taxonomy | ✅ | — | — |
| Publishing → `assets`/`investments`/`retirement_accounts` mapping | ✅ | — | (target tables owned by existing FHIP registers, unchanged) |
| Household net worth, goal probability, retirement forecast | — | — | Forecasting (Module 10), unchanged, remains canonical |
| Goal target/priority/status | — | — | Goals (Module 7), unchanged, remains canonical |
| Household-level FX/base-currency translation | — | — | `lib/engines/fx.ts` / cross-border services, unchanged |
| Audit event *shape* | ✅ | — | — |

## 4. Why country-neutral-core-plus-adapter, not a single India-specific schema

Two country/currency pairs (`AU`/`AUD`, `IN`/`INR`) are already the entirety of what FHIP supports today (`R0_CURRENT_STATE_DISCOVERY.md` section 7 — `seed.sql`). The spec requires Australia to reuse the same core "without a schema rewrite" (design principle 9). A single India-shaped schema would force exactly the rewrite the spec forbids the moment Australian brokers/super funds are onboarded. The adapter boundary defined above (country-specific attributes live in reference/config tables and adapter-owned columns, never as required core columns) is the mechanism that avoids that rewrite — validated concretely in `R0_CANONICAL_DATA_CONTRACT.md`'s per-entity treatment of `country`/`currency`.

## 5. Relationship to existing FHIP architecture

Investment Intelligence sits **beside** Assets/Investments/Retirement/Goals/Forecasting, not inside or above them (design principle 1, 3, 10, 11). It has exactly one write path into the rest of FHIP — the publishing layer (K) — and exactly one read dependency on the rest of FHIP — the existing `master_financial_items`-style catalogue precedent for reference data (H) and the existing `goal_funding_sources` allocation mechanism it must integrate with (`R0_GOAL_INTEGRATION_CONTRACT.md`). No other Investment Intelligence Core responsibility (A–L) requires touching Assets/Investments/Retirement/Goals/Forecasting code or schema directly.
