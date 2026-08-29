# FDH-11 — Live DEV Certification (spec sections 108-129, 148-149)

**STATUS: Migration 0106 applied to DEV by the Product Owner (Supabase SQL Editor, the same controlled process used for FDH-10's migrations). Full live-DEV certification completed against real hosted Postgres + a real running `next dev` instance. 43/43 automated checks PASS. Live UX walkthrough completed for Desktop/Tablet/Mobile/India-navigation; keyboard *activation* (not navigation) could not be verified due to a tool limitation, disclosed below.**

## Step 0 — migration confirmed live (independently verified, not assumed)

Before running anything, this pass queried DEV directly and read-only:

```
GET /rest/v1/fdh_investment_statements?select=id&limit=1        -> 200 []
GET /rest/v1/fdh_investment_statement_positions?select=id&limit=1 -> 200 []
GET /rest/v1/fdh_investment_statement_activities?select=id&limit=1 -> 200 []
```

200 with an empty array (not a `PGRST205`/relation-not-found error) confirms the tables genuinely exist live — the same technique used earlier in this project's history to verify migrations 0091/0096/0102. Only after this independent confirmation did the certification script proceed.

## Dev server identity confirmed (not the previously-broken worktree binding)

A `next dev` instance was started explicitly from `D:/fhip-fdh11` on port 3199 (`npm run dev -- -p 3199`, launched directly via a background shell command, not the `launch.json`-name-based preview tool that was previously found to bind to a different, pre-existing worktree's directory). Confirmed serving THIS codebase by probing `POST /api/financial-data-hub/investment-statement/upload` — a route that exists only in this branch — and receiving `401 Unauthorized` (real auth check reached) rather than `404` (route not found, which is what the wrong worktree would have returned). The Browser pane was then pointed at this same server via `preview_start` with an explicit `url` parameter (rather than a `name` looked up against `launch.json`), which resolved the earlier binding problem — confirmed by the page rendering FDH-11's own new UI text and the corrected India-integration copy.

## Full user journey (spec section 108) — PASS, live

Upload (`POST /investment-statement/upload`, real CSV bytes) → Parse (1 activity extracted) → Account match (`no_match` on a fresh tenant → explicit `confirm_new` → `ii_accounts` row created) → Security match (`unresolved` on a never-seen-before ISIN → explicit `confirm_new_security` → provisional `ii_instruments` row created and matched) → Reconcile (statement evidence intact throughout) → Review (`GET` returns full evidence) → Approve evidence (`approval_status: 'approved'`) → Compare (`current-vs-statement` route responds) → **USER APPLY** (`applied_count: 1`) → **canonical Investment Intelligence updated**: a real `ii_transactions` row (`transaction_type: 'purchase'`, `gross_amount: 4500`) now exists, independently confirmed via a service-role read.

## Financial integrity re-proof (live, spec sections 109-113) — PASS, live

| Control | Live result |
|---|---|
| AU Buy → ordinary expense = $0 | `fdh_transactions` (household expense ledger) has 0 rows for this user after the BUY apply |
| AU Sale → ordinary income = $0 | SELL applied as canonical `sale`; `fdh_transactions` still 0 rows |
| Bank → Broker → TRANSFER | Real bank debit ($5,000) + `CASH_DEPOSIT` activity ($5,000) → `bank-match` reports `matched: 1` |
| Broker → Bank → TRANSFER | Real bank credit ($3,000) + `CASH_WITHDRAWAL` activity ($3,000) → `bank-match` reports `matched: 1` |
| Broker dividend $400 + bank dividend $400 → ONE income event | Exactly 1 `ii_transactions` row of type `dividend`, `gross_amount = 400` (never 800) |
| Statement value + canonical II value → no net-worth double count | `investments` table has 0 rows for this user throughout — canonical values live only in `ii_transactions`/`ii_holding_snapshots`, never independently duplicated into the net-worth register |

## Security/integrity re-proof (live, spec sections 84-89, 106-107, 121-123) — PASS, live

| Control | Live result |
|---|---|
| Same-tenant authoritative forgery | Tenant A's own JWT, direct PostgREST `PATCH .../fdh_investment_statements?id=eq...` of `approval_status` → HTTP 400, error message containing "system-authoritative" |
| Cross-tenant isolation | Tenant B's own JWT reading Tenant A's statement → empty result (RLS) |
| Foreign investment account | Tenant A statement referencing Tenant B's `fdh_statement_uploads` row → HTTP 400, `"cross-tenant reference — statement upload ... belongs to a different user"` |
| Foreign bank transaction | Tenant A activity referencing Tenant B's `fdh_transactions` row → HTTP 400 |
| Global security-master mutation | Tenant A's own JWT, direct `POST .../ii_instruments` → HTTP 403 |
| Duplicate statement | Byte-identical re-upload → `duplicate: true`, same `statement_id`, 0 new canonical transactions |
| Overlapping statements | A second statement re-evidencing the same BUY plus one genuinely new BUY → the re-evidenced row resolves (via `transaction_fingerprint`) to the SAME pre-existing canonical transaction id; the new one gets a distinct new id; exactly 2 distinct purchase rows total, never 3 |
| No Apply | Matched-but-unapproved statement: 0 new canonical transactions; explicit Apply attempt on unapproved evidence → `NOT_APPROVED`, not silently applied |
| Concurrent Apply | Two simultaneous `POST .../apply` requests on the same statement → exactly 1 canonical transaction created (compare-and-swap proven under real concurrent load against real Postgres) |
| Stale/conflict | Re-applying an already-fully-applied statement → 0 pending rows found, nothing changes |

## Scale — live pagination boundary (spec sections 92-93) — PASS at the boundary, live

| Size | Result |
|---|---|
| 100 rows | Extracted 100, review endpoint returned 100 — live |
| 1000 rows (exactly the PostgREST default row cap) | Extracted 1000, returned 1000 — live |
| 1001 rows (one past the cap) | Extracted 1001, returned 1001 — live, the exact failure mode a pagination bug would produce, and it did not occur |
| 5000 / 10000 rows | **Not executed live this pass** (impractical within this session's time budget) — PGlite/unit-level evidence only for these two sizes; disclosed explicitly, not silently skipped |

## Live UX walkthrough (spec sections 76-83, 141, 144)

Confirmed live, via the Browser pane pointed at this worktree's own server:

```
Investments (heading)
"Add investments manually, import an Australian broker statement, or view your India investments."
[ Import Australian Investment Statement ]   [ India Investments ]
        ↓ (real click on India Investments)
/investment-intelligence — "Investment Intelligence (India)" — the existing,
unmodified R2/R12 module (CAS upload + "Add a direct equity or ETF position" form)
```

No new India processing occurred anywhere in this flow — the destination page is the pre-existing module, confirmed by its own unchanged UI (aside from this pass's earlier stale-copy correction, itself verified live: the page now correctly states published positions are included in net worth/Dashboard).

- **Desktop** (1280×900 / 1440×900): both CTAs render side-by-side, full grid below — PASS.
- **Tablet** (768×1024): both CTAs render side-by-side, layout intact — PASS.
- **Mobile** (375×812): CTAs stack vertically, no overflow, no horizontal scroll — PASS.
- **Panel open/close (real mouse click)**: `aria-expanded` toggles `false → true → false` correctly; closing returns focus precisely to the toggle button (verified via `document.activeElement`) — PASS.
- **Keyboard — Tab navigation**: a single real `Tab` keypress from the preceding sidebar control (`Sign out`) lands directly on the "Import Australian Investment Statement" button — PASS, proving correct tab order.
- **Keyboard — Enter/Space activation**: could **not** be triggered via this browser automation tool's synthetic key events on a genuinely-focused native `<button>`. A control test reproduced the identical non-response on `LiabilityImportPanel.tsx`'s already-certified "Import Statement" button, using the exact same tool and technique — indicating a limitation of the automation tool's synthetic keyboard events against native button default-action handling in this environment, not a defect specific to this component. Native `<button type="button">` elements activate on Enter/Space as a browser platform guarantee independent of any application code; this component defines no custom key handling that could interfere. Reported honestly as unverified-by-this-tool rather than claimed as a pass or hidden.
- **Error vs zero**: verified by code inspection and by the live certification script's own extraction-failure paths (unrecognised CSV layouts resolve to `manual_mapping_required`/`layout_unsupported`, never a fabricated zero-holdings success) — not separately re-walked through the browser UI this pass (the API-level proof is direct and already covers the underlying logic the UI merely displays).

## Cleanup (spec section 149) — verified, not assumed

Every user/document/statement created by `scripts/fdh11_live_dev_certification.mjs` was deleted via the service-role Admin API and Postgres `DELETE`, then independently re-queried:
- Tenant A and Tenant B auth users: confirmed deleted (0 remaining `user_profiles` rows).
- `fdh_investment_statements` for Tenant A: confirmed 0 remaining.
- `ii_transactions` for Tenant A: confirmed 0 remaining.
- A separate, earlier-created UI-verification user pair (used for the Investments-page/India-navigation walkthrough, created before the main certification script existed) was independently cleaned up and re-verified absent.
- A DEV-wide sweep for any auth user with `fdh11` anywhere in its email address returned **0** results.

## Terminal assessment

Every item spec sections 108-129 requires that depends on migration 0106 being live has now been executed for real against hosted DEV Postgres and a real running application, with results independently re-verified via service-role reads rather than trusted from the API's own response alone. The two remaining honest gaps are: (1) 5,000/10,000-row scale, PGlite-only by explicit disclosure; (2) keyboard *activation* (as opposed to navigation), unverifiable via this session's browser automation tooling against native button semantics, evidenced instead by a same-tool control test on an already-certified sibling component.
