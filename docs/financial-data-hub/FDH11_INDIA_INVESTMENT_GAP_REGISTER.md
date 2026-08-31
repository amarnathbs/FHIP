# FDH-11 — India Investment Gap Register

Per spec section 5's hard rule: **FDH-11 MUST NOT fix India Investment business-logic gaps.** Every entry below was discovered during FDH-11's mandatory India-module benchmark audit (spec section 18) and is recorded here, unfixed, for the India Investment module to address separately.

---

## IND-GAP-001

**Capability**: Unified portfolio summary (total value, holding count, base currency) as a single reusable query.

**Date discovered**: 2026-08-29, during FDH-11 architecture discovery.

**Evidence**: `GET /api/investment-intelligence/positions` returns per-position rows (including `currency_code`, confirmed present and correctly populated at every schema layer — `ii_instruments.base_currency`, `ii_accounts.currency_code`, `ii_transactions`/`ii_holding_snapshots.currency_code` are all `not null`). No single service/hook aggregates these into "total portfolio value, holding count, currency" — each analytics surface (`lib/engines/investment-intelligence/xray/lookThrough.ts`, `lib/services/investment-intelligence/r5Repository.ts`, `portfolioAttribution.ts`) computes its own ad hoc total independently.

**Test case**: `GET` a hypothetical `/api/investment-intelligence/portfolio-summary` — does not exist.

**User impact**: A unified Investments view (spec section 78: "India ₹32,40,000, 14 holdings") cannot be built by calling one existing India-side endpoint; it would need to either aggregate the raw positions endpoint client-side (duplicating logic already written three different ways inside II) or wait for India to expose one canonical summary.

**Severity**: Medium — blocks spec section 78's unified summary view, does not block AU-only or India-only usage.

**Current India-module behaviour**: Every consumer recomputes its own total.

**Required behaviour**: One canonical, reusable "portfolio summary" query/service, owned by Investment Intelligence, that FDH-11 (or any future unified view) can call without recomputing.

**Recommended remediation**: Add a single `computePortfolioSummary(userId)` service function to `lib/services/investment-intelligence/`, reusing the same pagination-safe (`fetchAllRows`) read pattern already established elsewhere in that module.

**Owning module**: INDIA INVESTMENT (Investment Intelligence).

**FDH-11 dependency**: None this pass — the unified summary view (spec section 78) was not built, precisely because this endpoint does not exist yet and FDH-11 must not fabricate one on India's behalf.

**FDH-11 workaround**: NONE. FDH-11 does not derive or maintain a parallel India portfolio-summary calculation.

**Status**: OPEN.

---

## IND-GAP-002

**Capability**: Depository (NSDL/CDSL) Consolidated Account Statement parsing for demat equity holdings.

**Date discovered**: 2026-08-29, during FDH-11 architecture discovery (used as the "India capability benchmark" spec section 18 requires before scoping AU statement parsing).

**Evidence**: `IiParserCode` (`lib/services/investment-intelligence/types.ts`) is a closed union of exactly `'cams_detailed_v1' | 'kfintech_detailed_v1'` — both mutual-fund RTA statement formats. `ii_accounts.account_type` includes `'demat'` at the schema level (migration `0032`) and `manualDirectPositionService.ts` defaults manual equity entry to `accountType: 'demat'`, but no parser exists anywhere that reads an actual NSDL/CDSL depository CAS PDF/CSV — `R2_PARSER_ARCHITECTURE.md` itself names NSDL/CDSL as a documented *future* extension point ("Adding a future provider (MFCentral, NSDL, CDSL, a broker) is one new array entry"), not something already built.

**Test case**: Upload a real NSDL/CDSL depository CAS — no registered parser detects it; `detectSource()` in `parsers/registry.ts` can only ever return `cams_detailed_v1`/`kfintech_detailed_v1` or unresolved.

**User impact**: An Indian investor's *direct listed equity* holdings, when evidenced only by a depository CAS (as opposed to entered manually per R12's `ManualDirectPositionForm.tsx`), cannot be automatically extracted the way mutual-fund holdings can via CAMS/KFintech.

**Severity**: Low-Medium — R12 already provides a manual entry path for direct equity/ETF, so this is a missing *automation* convenience, not a missing capability.

**Current India-module behaviour**: Direct equity/ETF must be entered manually (R12, deliberately scoped that way — "NSDL/CDSL/broker-statement parsing remains deferred exactly as R11 left it... R12 does not pull those adapters forward," per `R12_ASSET_CLASS_SCOPE_MATRIX.md`'s own explicit statement).

**Required behaviour**: An NSDL/CDSL depository-CAS parser implementing the existing `InvestmentDocumentParser` interface, registered in `PARSER_REGISTRY`.

**Recommended remediation**: A future India Investment module phase adds `nsdlParser.ts`/`cdslParser.ts` following `camsParser.ts`'s established shape.

**Owning module**: INDIA INVESTMENT.

**FDH-11 dependency**: None. FDH-11's own AU broker-CSV adapters are architecturally identical in *pattern* to what an NSDL/CDSL adapter would need, but FDH-11 explicitly does not build the India-side adapter itself (spec section 17: "India Statement Parsers Are Out of Scope").

**FDH-11 workaround**: NONE.

**Status**: OPEN — already a known, deliberate deferral per R12's own documentation, not newly created by FDH-11; recorded here per spec section 5's process regardless.

---

## Summary (spec sections 91, 129, 153)

India gaps discovered: **2**. India gaps documented: **2**. India gaps assigned to India module: **2**. India gaps improperly fixed inside FDH-11: **0**.
