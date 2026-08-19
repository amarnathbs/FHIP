# R3 — Publishing Architecture

Status: FINAL (R3)
Depends on: `R0_FHIP_PUBLISHING_CONTRACT.md`, `R0_NET_WORTH_DEDUP_CONTRACT.md`, `R0_CANONICAL_DATA_CONTRACT.md`, `R1_DATABASE_SCHEMA.md`, `R2_PORTFOLIO_TRUTH_AND_RECONCILIATION.md`, `R3_ARCHITECTURE_EXCEPTION.md`

## 1. Layered flow (unchanged from R0, now implemented)

```
Source Document → Investment Intelligence (ii_source_documents → ii_transactions
→ ii_holding_snapshots) → Certified Canonical Position (ii_portfolio_truth_status)
→ ii_fhip_publications → existing FHIP register projection (investments row)
→ computeDashboard() / reportSections.ts / forecast calculators (UNCHANGED)
```

Every arrow above is a real, traced code path (`R3_FHIP_CALCULATION_TRACE.md`), not a diagram-only claim.

## 2. New files

| File | Role |
|---|---|
| `supabase/migrations/0042_ii_r3_fhip_publishing_bridge.sql` | Schema: economic-position identity + lineage on `ii_fhip_publications`, source markers on `investments`/`assets`/`retirement_accounts`, relaxed uniqueness, one-active-publication-per-position constraint, extended audit vocabulary. |
| `lib/services/investment-intelligence/publicationLogic.ts` | **Pure, DB-free** decision functions — routing, ITEM/OWNER/COST BASE/RISK BAND/ANNUAL CONTRIBUTION mapping, eligibility gate, duplicate detection, financial impact, refresh ordering, cross-border currency preview, idempotency key. |
| `lib/services/investment-intelligence/investmentPublicationService.ts` | `InvestmentPublicationService` — the one orchestration layer every API route calls: `checkEligibility`, `buildPreview`, `publishPosition`, `refreshPosition`, `unpublishPosition`, `republishPosition`. |
| `app/api/investment-intelligence/positions/[id]/{eligibility,preview,publish,refresh}/route.ts` | Bounded, position-scoped routes. |
| `app/api/investment-intelligence/publications/{route,[id]/unpublish,[id]/republish}.ts` | Bounded, publication-scoped routes. |
| `app/api/investments/[id]/route.ts` (modified) | Direct-edit protection (spec section 38). |
| `components/grid/FinancialDataGrid.tsx`, `components/investment-intelligence/InvestmentIntelligenceClient.tsx` (modified) | Minimal UI: source badge + locked fields on the FHIP grid; Publish-to-FHIP preview/confirm flow in the Investment Intelligence page. |

## 3. Why pure-logic/orchestration are split into two files

The single highest-stakes property in this release — one economic position contributes to net worth exactly once — must be provable with fast, deterministic, DB-free tests, because this sandbox cannot apply the migration that the DB-backed code depends on (see `R3_TESTING_AND_VERIFICATION.md`). Every decision that determines *whether* and *how* a position affects FHIP totals (eligibility, duplicate detection, financial-impact arithmetic, refresh ordering, currency conversion availability) lives in `publicationLogic.ts` as functions of plain data, with zero imports of any Supabase client. `investmentPublicationService.ts` is a thin shell that fetches rows, calls these functions, and writes the result — it is honestly classified as LOCAL-DB/LIVE-DEV-blocked (see the testing doc), while the decision logic itself is exhaustively, genuinely unit-tested (106 new tests, `tests/unit/iiR3*.test.ts`).

## 4. Publication router (spec section 43)

`computePublicationTarget(instrumentClass, accountType)` — **unchanged from R1** (`lib/services/investment-intelligence/publishing.ts`, frozen and already tested by `tests/unit/iiPublishing.test.ts`). R3 does not fork or duplicate this function; `publicationLogic.ts` re-exports it. Routing table (generic, not MF-hardcoded):

| `instrumentClass` | `accountType` | Target |
|---|---|---|
| any | `retirement` | `retirement_accounts` |
| `fixed_deposit`, `cash` | any (non-retirement) | `assets` |
| everything else (`mutual_fund`, `equity`, `etf`, `bond`, `gold`, `crypto`, `other`) | any (non-retirement) | `investments` |

`isProductionCertifiedAssetClass(instrumentClass)` is the **separate** R3 production gate layered on top of routing: only `mutual_fund` returns `true` in this release (R2 certifies Indian mutual funds only). Every other instrument class routes *correctly* (proven by `tests/unit/iiR3DedupScenarioMatrix.test.ts`'s DD-006/007/008/003 structural cases) but is blocked from actually publishing by `evaluateEligibility()`'s `ASSET_CLASS_NOT_YET_CERTIFIED` reason. A future release activating a new asset class changes exactly two lookup tables (`INSTRUMENT_CLASS_TO_MASTER_ITEM_KEY`, `isProductionCertifiedAssetClass`) — no router rewrite.

## 5. Atomicity and idempotency (spec sections 45-46)

This codebase has never used a Postgres RPC / multi-statement transaction (`grep -rln "\.rpc(" lib app` returns zero matches, verified before designing this). Introducing that pattern for R3 alone was judged a bigger architectural departure than a documented compensating-state workflow — recorded here, not hidden:

1. **Idempotency key** — `computeIdempotencyKey({accountId, instrumentId, canonicalPositionId, publicationTarget})`, a deterministic string. Before any write, `publishPosition()` looks up an existing `ii_fhip_publications` row with the same key; if one is already `published`, the request returns the existing result with no new write — a double-click/retry produces exactly one outcome.
2. **Write order** — the target FHIP row (`investments`) is written **first**; the `ii_fhip_publications` row is written **second**, pointing at it.
3. **Compensation** — if the second write fails, the first write is explicitly reverted (a freshly-inserted row is archived; a freshly-linked manual row is restored from its captured `pre_publication_manual_snapshot`), an `ii_audit_events` row (`publication_failed`, `compensated: true`) is recorded, and the caller receives an error. No request can leave `ii_fhip_publications` pointing at a row that either doesn't exist or wasn't actually updated, and no request can leave a target row silently mutated with no publication record backing it.
4. **DB-level backstop** — even if the idempotency-key pre-check somehow raced (two concurrent requests both pass the pre-check), `uidx_ii_fhip_publications_one_active_position` (migration `0042`) makes a second concurrently-inserted `published`-status row for the same `(account_id, instrument_id)` a hard constraint violation at the database level — the application-level idempotency check is defense-in-depth, not the sole guarantee.

## 6. Publication granularity and identity (spec sections 23-24)

**Granularity**: one `ii_fhip_publications` row per **snapshot-publish-event** (i.e. per `canonical_position_id = ii_holding_snapshots.id`), with exactly one row per economic position (`account_id, instrument_id`) ever holding `status='published'` at a time (enforced by the partial unique index above). A refresh inserts a *new* publication row (new snapshot → new immutable `ii_holding_snapshots.id` → `unique(canonical_position_id)` doesn't collide) and marks the prior one `superseded` — this is deliberately **not** "update the same publication row forever," because `R0_CANONICAL_DATA_CONTRACT.md` makes `ii_holding_snapshots` immutable and per-as-of-date; a full audit trail of every certified valuation this position was ever published at is a direct, free consequence of that immutability, exactly matching spec sections 33-35's "keep both old and new, never silently rewrite."

**Identity**: `(account_id, instrument_id)` is the stable economic-position identity spanning refreshes (denormalised onto `ii_fhip_publications` in migration `0042` specifically so this can be a DB constraint, not just an application convention). `published_row_id` (the target `investments.id`) stays the same across every refresh of the same position — this is what makes goal-linkage continuity (`goal_funding_sources.linked_investment_id`) survive a refresh with zero relinking.

## 7. Publication lifecycle

`ii_fhip_publications.status`: R1's frozen 3-value vocabulary (`published`, `unpublished`, `superseded`) is kept **unchanged**, extended with exactly one new value, `failed` (a persisted terminal state for a compensated/failed write attempt — see section 5). `REVIEW_REQUIRED`/eligibility states are **never persisted** — they are computed at preview/publish-attempt time (`IiEligibilityStatus`, `publicationLogic.ts`) and returned directly to the caller; nothing is written to the database until a publish actually clears the gate. This was a deliberate simplification over inventing a `DRAFT`/`READY` DB state: fewer persisted states means fewer places for an inconsistent state to exist.

## 8. Bounded API surface (spec section 61)

No unrestricted `ii_fhip_publications` CRUD exists. Every route requires `requireUser()`, is scoped by the RLS-respecting `createClient()` (never the service-role client for a user-facing mutation — matching `accounts.ts`'s existing pattern exactly), and calls exactly one `InvestmentPublicationService` function:

| Route | Service function | Purpose |
|---|---|---|
| `GET /positions/[id]/eligibility` | `checkEligibility` | Read-only gate check |
| `GET /positions/[id]/preview` | `buildPreview` | Read-only preview + duplicate candidates + financial impact |
| `POST /positions/[id]/publish` | `publishPosition` | The one write path (ADD_NEW or REPLACE_LINK_EXISTING) |
| `POST /positions/[id]/refresh` | `refreshPosition` | Newer-snapshot supersession |
| `POST /publications/[id]/unpublish` | `unpublishPosition` | Stop active inclusion, preserve canonical data |
| `POST /publications/[id]/republish` | `republishPosition` | Deterministic re-activation |
| `GET /publications` | (direct RLS read) | Provenance/status listing for the UI |

"link-existing-manual-record" and "resolve-conflict" (spec section 61's named operations) are implemented as **parameters** to the single publish endpoint (`linkToExistingInvestmentId`, `acknowledgedNoDuplicate`) rather than separate routes — a deliberate simplification consistent with spec section 62's instruction to centralise business logic in one service rather than duplicate it across handlers. Both decisions are made by the same `publishPosition()` function; a separate route would only re-derive the same gate.
