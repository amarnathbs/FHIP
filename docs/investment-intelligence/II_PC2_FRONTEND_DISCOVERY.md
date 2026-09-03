# II-PC2 — Investment Intelligence Front-End Discovery

Phase 0 inventory, taken against `origin/main` at `bd45308` before any UI change.

Everything below was established by tracing the actual route → component → API →
engine chain. Nothing is inferred from a service name (spec §6).

---

## 1. Route inventory

### Pages — `app/(app)/investment-intelligence/**`

| Route | Page component | Client component | APIs called | Auth gate | Country gate | Empty-state behaviour | Analytics exposed |
|---|---|---|---|---|---|---|---|
| `/investment-intelligence` | `page.tsx` | `InvestmentIntelligenceClient`, `ManualDirectPositionForm` | `source-documents`, `.../[id]/process`, `.../[id]/summary`, `reconciliation-cases/[id]/resolve`, `portfolio-truth/certify`, `positions/[id]/preview`, `positions/[id]/publish`, `positions/manual` | `supabase.auth.getUser()` → redirect `/login` | via API (`requireCountryConfirmedUser`) | "No statements uploaded yet." | **None** — deliberately, per R2 spec's performance-calculation firewall |
| `/investment-intelligence/performance` | `page.tsx` | `PerformanceClient` | `analytics` | same | via API | engine returns `empty:true` + message | R4: TWRR, XIRR, benchmark, risk, rolling, scheme returns |
| `/investment-intelligence/sip` | `page.tsx` | `SipIntelligenceClient` | `sip`, `sip/simulation` | same | via API | `empty:true`; also an explicit "no recurring series identified" state | R5 SIP Intelligence |
| `/investment-intelligence/xray` | `page.tsx` | `PortfolioXrayClient` | `xray`, `xray/overlap`, `xray/data-quality` | same | via API | `empty:true`; `DataUnavailable` panel, draws **no** charts | R5 Portfolio X-Ray |
| `/investment-intelligence/tax` | `page.tsx` | `TaxIntelligenceClient` | `tax/summary`, `tax/profile`, `tax/lots`, `tax/redemption-simulation`, `tax/cost-intelligence` | same | via API | `empty:true` with a distinct no-disposal message | R6 v3 India tax & cost |
| `/investment-intelligence/review` | `page.tsx` | `ReviewCentreClient` | `review`, `review/refresh`, `review/[id]/acknowledge`, `review/[id]/dismiss` | same | via API | empty item list | R9 Review Centre |

All six page components are thin server components: they gate auth and delegate
everything to a `'use client'` component. **None of them rendered any navigation
between each other.**

### Components — `components/investment-intelligence/**`

`InvestmentIntelligenceClient.tsx` (646), `PerformanceClient.tsx` (687),
`PortfolioXrayClient.tsx` (516), `SipIntelligenceClient.tsx` (546),
`TaxIntelligenceClient.tsx` (374), `ReviewCentreClient.tsx` (149),
`ManualDirectPositionForm.tsx` (194).

Related, outside this directory: `components/investments/InvestmentsSubNav.tsx`
(the Investments/Retirement tab pair — the repository's existing sub-navigation
precedent), `components/grid/FinancialDataGrid.tsx` (renders an "Imported via
Investment Intelligence" badge and a link back), `components/ui/AppShell.tsx`
(global sidebar).

---

## 2. API inventory — `app/api/investment-intelligence/**`

Every route uses `requireCountryConfirmedUser` + the RLS-respecting request
client. No user-facing route constructs a service-role client at the route
layer.

**The distinction that shaped the whole PC2 design** — which routes are cheap
reads and which execute an engine:

| Route | Cost | Side effect on GET |
|---|---|---|
| `analytics` | **Runs `runAnalytics`** | none |
| `sip` | **Runs `runSipAnalytics` twice** | **writes** 2 rows/series via `persistR5Results` (service role) |
| `xray` | **Runs `runXrayAnalytics`** | **writes** via `persistR5Results` |
| `xray/data-quality` | **Runs `runXrayAnalytics`** (despite the name) | none |
| `tax/summary` | **Runs `runTaxSimulation`** | **writes 3 tables**: tax lots, lot consumptions, capital-gains computations |
| `review` | cheap select | none (the engine lives in `review/refresh`) |
| `portfolio-truth` | cheap select | none |
| `positions` | cheap select (+ pure date helper) | none |
| `source-documents` (GET) | cheap select | none |
| `publications` | cheap select | none |
| `reconciliation-cases` | cheap select | none |
| `tax/profile` (GET) | cheap select | none |

Consequence for PC2: an Overview that fanned out to the five analytics routes to
populate status cards would not merely be slow — **merely opening the page would
rewrite the user's tax lots and capital-gains computations.** This is why PC2
adds one lightweight `overview` endpoint that reads plain tables instead
(spec §39-40).

---

## 3. Capability matrix

Engine/API/UI columns are traced, not assumed.

| Capability | Engine | API | UI | Discoverable from II root | Discoverable from global nav | User-ready |
|---|---|---|---|---|---|---|
| Import / source documents | yes | yes | yes (root) | yes (it *was* the root) | yes | yes, but claimed CSV support it does not have |
| Portfolio Truth | yes | yes | yes (root) | yes | yes | yes |
| Publish to FHIP | yes | yes | yes (root) | yes | yes | yes |
| Performance (TWRR/XIRR) | yes | yes | yes | **no** | **no** | route existed, unreachable |
| Benchmark comparison | yes | yes | yes | **no** | **no** | as above |
| Risk measures | yes | yes | yes | **no** | **no** | as above |
| SIP Intelligence | yes | yes | yes | **no** | **no** | as above |
| X-Ray look-through | yes | yes | yes | **no** | **no** | as above |
| Fund overlap | yes | yes | yes | **no** | **no** | as above |
| Sector / market-cap / AMC exposure | yes | yes | yes | **no** | **no** | as above |
| Tax & cost, FIFO realised gains | yes | yes | yes | **no** | **no** | as above |
| Tax simulator | yes | yes | yes | **no** | **no** | as above |
| Review Centre | yes | yes | yes | **no** | **no** | as above |
| Goals integration | canonical Goals | yes | `/goals` | **no** | yes (separate nav entry) | reachable, unrelated to II |
| Forecasting integration | canonical Forecasting | yes | `/forecast/investments` | **no** | yes | as above |
| Reports | canonical Reports | yes | `/reports` | **no** | yes | as above |
| Data quality / reconciliation | yes | yes | yes (root) | yes | yes | yes |
| Professional access (R11) | yes | yes | separate | n/a | n/a | unchanged by PC2 |
| Direct equity / ETF (R12) | yes | yes | manual form on root | yes | yes | yes |

---

## 4. Current user journey, and where it breaks

Login → sidebar "Investment Intelligence (India)" → `/investment-intelligence`
→ upload statement → process → reconciliation → certify → publish. That journey
works end to end.

Then:

> **How does a normal user discover Performance, SIP, X-Ray, Tax, or the Review
> Centre?**
>
> They cannot. There is no link to any of the five analytics routes from
> anywhere in the application — not from the II root page, not from the global
> sidebar, not from the Investments register. The only way in is to type the
> URL.

Per spec §7 that is a PC2 discoverability defect, and per §45 it fails the
discoverability gate outright. It is also the direct cause of the product
problem in §0: a user can publish investments successfully and still
reasonably conclude "I cannot see any investment analysis."

Verified counts on `origin/main`:

```
git grep -n "href=[\"'{\`]*/investment-intelligence\|href: '/investment-intelligence" origin/main -- app components lib
```

returns exactly three navigation links on `origin/main`, and **all three point
at the workspace root**:

- `app/(app)/investments/page.tsx:44` — the "India Investments" button
- `components/grid/FinancialDataGrid.tsx:804` — the "Review" link on a published row
- `components/ui/AppShell.tsx:92` — the single global sidebar entry

There is **no navigation link anywhere in the application** to
`/investment-intelligence/performance`, `/sip`, `/xray`, `/tax` or `/review`.
(The many `/api/investment-intelligence/...` occurrences in the client
components are data fetches, not navigation.)

---

## 5. Other defects found during discovery

1. **Misleading CSV contract (spec §15).** The upload control was labelled
   "PDF or CSV file" and accepted `.csv,text/csv`. The parser registry
   (`parsers/registry.ts`) contains exactly two adapters — CAMS and KFintech —
   and both identify a statement from PDF-extracted statement text. A CSV
   uploaded here is read as UTF-8 (`documentProcessing.ts`, `extractionMethod =
   'csv_text'`) and handed to those same parsers, which cannot recognise it, so
   it always terminates as `unsupported` with a blocking reconciliation case.
   *The backend's `text/csv` acceptance is nonetheless load-bearing* — the
   live-DEV test harness uploads CAMS statement TEXT with a `text/csv` mime to
   skip PDF extraction — so per §15 only the user-facing claim is corrected,
   not the backend capability.

2. **Document password retained on rejection (spec §16).**
   `InvestmentIntelligenceClient.handleProcess` cleared `passwordInputs` after a
   `throw` on a non-ok response, so the password survived in client state
   precisely on a wrong-password rejection — when it is still a live secret.

3. **Pre-existing responsive defects (spec §34/§54), both reproduced on
   `origin/main` with the PC2 sub-navigation removed:**
   - `ReviewCentreClient` status-chip row had no `flex-wrap` → 395px against a
     320px viewport.
   - `TaxIntelligenceClient` taxpayer-type select + Apply button did not wrap →
     339px against 320px.

4. **Pre-existing baseline test failures, unrelated to PC2.** Nine
   `tests/unit/resources*.test.ts` suites and one AI suite fail on clean
   `origin/main` in this environment. The resources suites read
   `D:/FHIP/.env.local` with `/^([A-Z0-9_]+)=(.*)$/`; that file is CRLF-
   terminated and BOM-prefixed, so **no** key parses and the suites die with
   "supabaseUrl is required". Reproduced identically on pristine `origin/main`
   (10 files failed, 1 test failed — the same signature as on the PC2 branch).

---

## 6. Design conclusions carried into implementation

- The five analytics pages already implement the §12/§13 "unavailable, never a
  zero" contract correctly (`DataUnavailable` in X-Ray, `status: 'unavailable'`
  unions in Performance/SIP, a distinct no-disposal message in Tax). PC2 must
  **not** rewrite them; it must make them reachable.
- `lib/engines/investment-intelligence/calculationStatus.ts` already defines a
  mature per-metric `CalculationStatus` union. PC2's card-level vocabulary is
  related but not identical (it needs `NEEDS_RECONCILIATION` and `UNSUPPORTED`,
  which have no meaning per-metric, and `CalculationStatus` is persisted into a
  checked column that must not gain values). PC2 therefore defines its own
  union plus a one-way bridge rather than widening a persisted enum.
- The global sidebar already follows spec §32's preferred shape (one workspace
  entry). It needs **no change**; the workspace needs its own sub-navigation.
- `components/investments/InvestmentsSubNav.tsx` is the existing sub-navigation
  precedent, but it uses the `role="tablist"`/`role="tab"` idiom. PC2's
  navigation performs real page navigations rather than swapping in-page
  panels, so it is marked up as a `<nav>` + list of links with `aria-current`
  instead — promising a tabpanel relationship that does not exist would
  mislead assistive technology.
- Terminology (spec §8/§37): the destination pages' own headings are
  "Investment performance", "Recurring investments", "What your funds actually
  hold", "India tax & cost intelligence", "Investment Review Centre". No
  user-facing surface says "SIP" or "X-Ray", so the spec's suggested labels are
  deliberately not used.
