# FDH-6 — Economic Classes

The frozen 13-value `FDH_ECONOMIC_TRANSACTION_TYPES` enum (`lib/financial-data-hub/constants/enums.ts:315-329`, defined in FDH-1 migration `0047`, unchanged since):

`income, expense, transfer, investment, debt_principal, debt_interest, refund, asset_purchase, asset_sale, tax, fee, cash_withdrawal, unknown`

## Reachability, before and after FDH-6

| Class | Reachable before FDH-6 | Reachable after FDH-6 |
|---|---|---|
| income | yes — 11 global rules (FDH-2) | unchanged |
| expense | yes — merchant/category default | unchanged |
| transfer | only via manual user correction (no automatic write-back) | **yes** — `applyTransferClassOnConfirm()` writes it back to both sides when a matched `internal_transfer`/`credit_card_settlement` link is confirmed |
| investment | yes — 2 global rules (EPF/NPS, India) | unchanged |
| debt_principal | **no** — category existed, zero rules | **yes** — 7 new rules, migration `0075` |
| debt_interest | yes — 4 global rules | unchanged |
| refund | yes — 6 global rules | unchanged |
| asset_purchase | **no** — category existed, zero rules | **yes** — 5 new rules, migration `0075` |
| asset_sale | **no** — category existed, zero rules | **yes** — 5 new rules, migration `0075` |
| tax | yes — 1 global rule (AU) | unchanged |
| fee | yes — 8 global rules | unchanged |
| cash_withdrawal | yes — 3 global rules | unchanged |
| unknown | always (default/fallback) | unchanged |

## Why `debt_principal`/`asset_purchase`/`asset_sale` stayed narrow

Every new narrative pattern requires an UNAMBIGUOUS qualifier (`"HOME LOAN PRINCIPAL"`, `"BROKER FUNDING"`, `"MUTUAL FUND REDEMPTION"`, ...) — never a bare `"LOAN"` or `"HOME LOAN"` narrative with no PRINCIPAL/INTEREST distinction (spec section 50: "do not invent principal/interest splits... without supporting loan data"; section 55: "use \[asset] classes cautiously"). A generic `"HOME LOAN"` repayment with no qualifier stays `unknown`/review — the certification pack's `[FDH6-IN-08]` case proves this explicitly (`"EMI DEDUCTED HDFC BANK"` with no PRINCIPAL term stays `unknown`; `"EMI PRINCIPAL COMPONENT MAR"` resolves to `debt_principal`).

## Why `transfer` needed a write-back, not a new rule

FDH-2's own taxonomy comment (`0053`, `transfer_own_account` category) already disclosed this as a forward reference to FDH-6: a transfer-looking NARRATIVE is only ever a candidate (`flag_candidate` action, never `classify`) — the actual economic-class commitment happens once the transfer is CONFIRMED as a real cross-account movement, which is a relationship between two rows, not a property inferable from either row's narrative alone. See `FDH6_TRANSFER_INTELLIGENCE.md`.
