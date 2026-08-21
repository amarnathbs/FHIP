# FDH-1 — Investment Boundary

**Product Owner Decision 2.** There must never be two competing canonical
investment portfolios.

---

## 1. The split

| Financial Data Hub owns | Investment Intelligence owns |
| --- | --- |
| Investment document **acquisition** | Canonical investment **accounts** |
| Document **identification** | Canonical **securities** |
| Future broker / CAS / CAMS / KFintech **parsing** | **Holdings** |
| **Extraction** | Investment **transactions after acceptance** |
| **Staging** of extracted records | **Valuations** |
| Parser-version **provenance** | Portfolio **analytics** |
| **Reconciliation** of the document | **XIRR / CAGR / TWRR** |
| **Extraction confidence** | **Benchmarks**, active return |
| **User review** | **Risk metrics** |
| **User approval** | Goal relationships, investment reporting |

## 2. End-to-end flow

```
investment statement
        │
        ▼
FINANCIAL DATA HUB          acquire → extract → reconcile → review → approve
        │
        │  ← FDH-11: approved-extraction → II ingestion adapter
        │     (CONTRACT SKETCHED BELOW, NOT IMPLEMENTED)
        ▼
INVESTMENT INTELLIGENCE     canonical instruments, accounts, transactions,
        │                   holdings, valuations, analytics
        ▼
FHIP aggregation / future bridge
```

## 3. What FDH-1 did NOT create

The specification forbids FDH from creating permanent competing canonical
tables where Investment Intelligence already owns the equivalent entity.
**FDH-1 created none.**

| II canonical entity | FDH equivalent created? |
| --- | --- |
| `ii_instruments` (security master) | **No** |
| `ii_instrument_identifiers` | **No** |
| `ii_accounts` (canonical investment accounts) | **No** |
| `ii_transactions` (unit movements) | **No** |
| `ii_holding_snapshots` (holdings) | **No** |
| `ii_tax_lots` | **No** |
| `ii_prices_nav` (valuations) | **No** |

There is no `fdh_holdings`, no `fdh_securities`, no `fdh_security_master`, no
`fdh_valuation_snapshots`, no `fdh_portfolio_*` and no `fdh_investment_*` table
of any kind.

**Nor any investment-ledger column.** A test walks every column definition in
all four migrations (335 column definitions) and fails if any is named — or ends in —
`units`, `nav`, `isin`, `folio`, `quantity`, `scheme_code`, `ticker`,
`cost_basis` or `market_value`.

**And FDH touches no `ii_` object at all.** The migrations contain no reference
to any `ii_` table, and no FDH source file imports from
`lib/services/investment-intelligence/**` or
`lib/engines/investment-intelligence/**`.

## 4. The two apparent overlaps, explained

### 4.1 `fdh_transactions` vs `ii_transactions`

These share an English word, not an entity.

| | `ii_transactions` | `fdh_transactions` |
| --- | --- | --- |
| What moves | **Units** of a scheme | **Cash** on a bank or card statement |
| Carries | units, NAV, folio, instrument, tax lot | amount, currency, direction, merchant |
| Parent account | `ii_accounts` — a **holding** | `fdh_financial_accounts` — a **document source** |
| Produced by | II's manual importer / CAS parsing, after acceptance | a bank/card statement import |

A SIP instalment appears in **both**, and correctly so: as a debit on the bank
statement (FDH: `economic_transaction_type = 'investment'`, a cash outflow) and
as a unit purchase in the fund (II: units, NAV, folio). They are two true facts
about one event, recorded in the two domains that own them. Neither is a copy of
the other, and neither is the canonical portfolio's second head — because FDH's
row has no units and cannot be valued.

The test that guarantees this is structural, not linguistic: it asserts that the
`fdh_transactions` table body contains none of `units`, `nav`, `isin`, `folio`,
`instrument` or `scheme`, and does contain `amount_original numeric(20,4)`,
`credit_debit`, and a foreign key to `fdh_financial_accounts`. No amount of
renaming satisfies it.

### 4.2 The `*_source` account types

`fdh_financial_accounts.account_type` includes `brokerage_source`,
`super_source`, `epf_source` and `nps_source`, and
`fdh_financial_institutions.institution_type` includes `broker`,
`investment_platform`, `depository` and `mutual_fund_platform`.

These exist because **FDH owns investment document acquisition**: a user's NPS
statement arrives from somewhere, and FDH must record where. The `_source`
suffix is deliberate — it names a document origin, not a holding. Such a row
carries no instrument, no units, no NAV and no valuation date, and a test
asserts the account table body contains none of those concepts.

## 5. Known overlap to reconcile at FDH-11 — recorded honestly

Investment Intelligence already has **`ii_source_documents`** (migration `0032`
on the II R1 branch), its own document-acquisition table, built for II's manual
CAS import path before Decision 2 existed.

Under Decision 2, document acquisition is FDH's. **FDH-1 does not touch, alter,
migrate or duplicate `ii_source_documents`**, and it does not attempt to resolve
the overlap — that would mean changing a certified module from inside a
foundation phase, which is explicitly out of scope.

**Open item for FDH-11.** Decide one of:

* **(a)** FDH becomes the sole acquisition path for investment documents and
  `ii_source_documents` becomes a downstream record populated by the adapter; or
* **(b)** `ii_source_documents` remains II's internal record of what it
  accepted, with FDH owning acquisition and the adapter writing an II-side
  reference.

Option (b) looks cheaper and less disruptive to a certified module, but this is
a Product Owner decision informed by FDH-11's real requirements, not an FDH-1
one.

## 6. The future adapter contract (documented only)

Should FDH ever need TypeScript awareness of Investment Intelligence, the rule
is: **an interface/adapter contract, never a direct dependency on II
internals.** FDH must never import an II calculation engine and must never
modify an II formula.

The shape sketched for FDH-11 — **not implemented, not exported, not referenced
by any code today**:

```
FDH side (owns):   an APPROVED extraction from an investment document —
                   institution, document type, statement period, parser id,
                   parser version id, extraction confidence, reconciliation
                   status, and the extracted rows as FDH understands them.

Boundary:          a single adapter function, owned by FDH-11, whose input is
                   the FDH approved-extraction record and whose output is
                   whatever II's ingestion contract accepts. It is the ONLY
                   point of contact.

II side (owns):    resolving the instrument, creating or matching the canonical
                   account, writing ii_transactions / ii_holding_snapshots,
                   valuation, analytics. II decides what it accepts; FDH does
                   not write II tables.
```

Constraints that hold whatever FDH-11 chooses:

1. FDH never writes an `ii_` table directly.
2. FDH never imports an II engine.
3. FDH never modifies an II formula, constraint or migration.
4. The adapter is one-way: FDH → II. FDH does not read II analytics.
5. Both sides keep their own provenance. II records which FDH extraction fed
   it; FDH records that the extraction was accepted.

## 7. Tests that enforce this document

`tests/unit/fdh1Isolation.test.ts`:

| Test | Guarantees |
| --- | --- |
| creates no table restating a canonical II entity | no `fdh_instruments`, `fdh_holding_snapshots`, `fdh_tax_lots`, `fdh_prices_nav`, `fdh_instrument_identifiers` |
| creates no holdings/securities/valuation/NAV/folio/portfolio/instrument table | pattern check over all 24 FDH table names |
| creates no units, NAV, ISIN, folio or quantity column anywhere | 335 column definitions checked |
| does not touch any `ii_` table | migrations and source both |
| proves `fdh_transactions` is a cash ledger, not the II unit ledger | structural, per §4.1 |
| keeps investment-source account types, which are document provenance | per §4.2 |

The negative-control run confirmed these tests genuinely fail: injecting a
`fdh_holding_snapshots` table into the FDH table list was caught.
