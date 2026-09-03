# Admin A0.2 Wave 5 — Recommendations Gap Review: Privacy Closure and Future Aggregate Design

**Branch:** `feature/admin-a02-wave5`
**Date:** 2026-09-03
**Status:** Interim disposition implemented. Aggregate replacement designed, deliberately **not** built.
**Product Owner decision:** Super Admin must not have standing access to identifiable individual financial figures through Recommendations Gap Review. A visible caution and a manual warning are insufficient.

---

## 1. Sensitive-data flow inventory (the complete path, as it was)

| Stage | What it was |
|---|---|
| Navigation entry | None of its own. Gap Review was a **section on `/admin/recommendations`**, not a nav item — so "hide the nav item" means removing the section, and the nav register in `lib/admin/adminNav.ts` needed no change. |
| Page | `app/(app)/admin/recommendations/page.tsx` → Super-Admin gate → `AdminRecommendationsClient` |
| Component | `components/admin/AdminRecommendationsClient.tsx` — `GapRun` interface, `gaps` state, `expandedGap` state, a per-row **Show context** disclosure rendering `JSON.stringify(g.context_snapshot, null, 2)` |
| Fetch | `loadAll()` requested `/api/admin/recommendations/gaps` in the same `Promise.all` as the library |
| API route | `app/api/admin/recommendations/gaps/route.ts` — `requireAdmin()`, then a **service-role** (`adminClient()`) read |
| Query | `user_recommendation_runs` · `select('id, user_id, forecast_profile_id, scenario_id, run_at, matched_count, context_snapshot')` · `eq('matched_count', 0)` · `order('run_at' desc)` · `limit(200)` |
| Row source | Written by `lib/services/recommendationsData.ts` → `runRecommendationEvaluation()` → `context_snapshot: { signals }` |
| Fields rendered | The entire `context_snapshot` verbatim, plus a truncated `user_id` and the run timestamp |
| Exports / downloads | **None** — no CSV, no blob, no `download` attribute. Verified, not assumed. |
| Browser storage | **None** — no `localStorage`, `sessionStorage` or `indexedDB` anywhere in the component. |
| Logs / audit | The route wrote no audit event and logged no row data. Only `safeDbError` could log, and only a Postgres error object, never the payload. |
| Tests / manuals | No test exercised the endpoint. The manual (ADM-06) documented it as an operational task. |

### 1.1 Could the endpoint be called outside the UI?

Yes — and that is precisely why hiding the UI was never going to be sufficient. `GET /api/admin/recommendations/gaps` was reachable by any Super Admin session directly (curl, devtools, a script), returning up to 200 identified financial profiles in one response.

**The underlying table is not the exposure.** `user_recommendation_runs` carries RLS `auth.uid() = user_id` (migration `0017`), so a direct PostgREST read as any authenticated user returns only their **own** rows. The exposure existed solely because the admin route used the **service-role client**, which bypasses RLS by design. That is why the fix belongs at the route, not at the table — and why no migration is required.

---

## 2. Field-level privacy classification

Of `user_recommendation_runs`, as returned by the withdrawn endpoint:

| Field | Classification |
|---|---|
| `user_id` | **Direct identifier** — a real `auth.users` primary key |
| `forecast_profile_id` | **Household identifier** — FK to `forecast_profiles` |
| `scenario_id` | **Indirect identifier** — FK to `forecast_scenarios` |
| `id`, `run_at` | Indirect identifiers (a run id and an exact timestamp are both linkable) |
| `matched_count` | Behavioural (always `0` for this query) |
| `context_snapshot` | **Container for everything below** |

Inside `context_snapshot.signals[]` (`EvaluationContext`, one entry per forecast category plus resilience plus each scored Health Score pillar):

| Field | Classification |
|---|---|
| `monthly_surplus` | **Exact income-minus-expenses figure** |
| `emergency_fund_months` | **Exact months of runway** — a direct derivation of savings against expenses |
| `variance_amount` | **Exact currency amount** (net worth, retirement, goal, debt, investment growth, cross-border) |
| `estimated_future_impact` | **Exact currency amount** |
| `actual_till_date` | **Exact currency amount** — actual position to date |
| `forecast_till_date` | **Exact currency amount** |
| `revised_forecast_value` | **Exact currency amount** |
| `variance_percentage` | Derived exact ratio |
| `score_band` | **Health Score band** — a behavioural/assessment attribute |
| `pillar_code`, `forecast_category`, `forecast_status`, `variance_result`, `recommendation_signal` | Recommendation-condition vocabulary — not sensitive alone, but they label which financial dimension each exact figure belongs to |
| `country_code` | **Jurisdiction** |

**Free text:** none. **Recommendation conditions:** the signal vocabulary above. **Assets / liabilities / net worth:** present as exact `variance_amount` / `actual_till_date` values per category, not as separate named fields.

The combination — a stable direct identifier plus exact surplus, runway and per-category position, browsable one person at a time — is an identified financial profile. Standard §9 names `user_id` and raw `context_snapshot` payloads explicitly.

---

## 3. Interim disposition, as implemented

Against the ten binding requirements:

| # | Requirement | How it is met |
|---|---|---|
| 1 | Hide Gap Review from ordinary Admin navigation | The section is replaced by a static notice. There was no nav item; `adminNav.ts` is unchanged. |
| 2 | Retain traceability to the future capability | This document; the route's own header; ADM-06's manual entry; the Help registry's `unavailableReason`. |
| 3 | Prevent direct page access showing personal figures | The component no longer holds, requests or renders any gap data. No `GapRun` type, no `gaps` state, no `expandedGap`, no `context_snapshot`. |
| 4 | Prevent the API/service returning individual-level figures | The handler **issues no query at all** and returns a stable `503`. |
| 5 | Honest unavailable state | On-page notice naming the reason, the scope (including Super Admin) and the aggregate replacement. |
| 6 | Preserve authentication and authorization | `requireAdmin()` runs **first and unchanged**; 401 and 403 precedence is preserved and tested. |
| 7 | No pseudonyms retaining exact figures | Nothing is pseudonymised. The figures are not returned at all. |
| 8 | No client-side masking as the boundary | The boundary is the server. The client change is a courtesy, and would be redundant on its own. |
| 9 | No separate Recommendations analytics engine | None built. |
| 10 | No support/break-glass access | None built. |

### 3.1 Why "no query at all" rather than "query then filter"

A handler that fetches the rows and then strips fields still: materialises them in server memory, exposes them to any future logging or error-serialisation path, risks a partial object surviving a refactor, and makes the safe behaviour depend on code that runs *after* the sensitive read. Not issuing the query removes the whole class. The test suite asserts `adminClient` is never constructed, so this cannot silently regress into fetch-then-filter.

### 3.2 The contract an authorized Super Admin now receives

```
HTTP 503
{ "error": "Recommendation gap review is unavailable. …",
  "code": "FEATURE_WITHHELD_PENDING_PRIVACY_REVIEW" }
```

No `data` key, no figure-shaped content, and no mention of any withdrawn field name. Unauthorized callers do not reach this — they receive their existing 401/403, so the feature's state is not disclosed to anyone not entitled to it.

---

## 4. Role-by-role denial matrix

| Caller | Result | Individual data returned |
|---|---|---|
| Anonymous | `401` | No |
| Authenticated ordinary user | `403` | No |
| Author / Editor / Compliance Reviewer / Publisher | `403` | No |
| Resource Admin | `403` | No |
| Analyst | `403` | No |
| **Super Admin** | `503` `FEATURE_WITHHELD_PENDING_PRIVACY_REVIEW` | **No** |

The only behavioural change is the last row. Every denial above it is byte-for-byte the pre-existing `requireAdmin()` response.

---

## 5. Cache, log and export review

| Surface | Finding |
|---|---|
| Application logs | The handler logs nothing. `safeDbError` is no longer imported, so no Postgres error can be logged from this route either. |
| Audit metadata | The route wrote no audit event before, and writes none now. |
| Error monitoring | No sensitive value can reach an error path: none is ever loaded. |
| Browser storage | No `localStorage` / `sessionStorage` / `indexedDB` in the component — asserted by test so it stays that way. |
| Query strings | The endpoint took no parameters; nothing was ever placed in a URL. |
| Cache keys | No caching layer; the request itself is now removed from the client. |
| Downloadable files | No export path existed; asserted absent by test. |
| Dev/test caches | `.next` was cleared during this work. **No production record was deleted or altered.** |

---

## 6. Future privacy-safe design — allocated, not built

**Owner: the canonical Admin Analytics/Privacy phase.** Not FDH, not Recommendations-specific, not Analyst-specific. No new privacy engine is to be created for it.

### 6.1 What it should report

Operationally useful aggregates only:
- count of evaluations that matched nothing, over a period;
- gap-reason category (no condition covered the signal; condition thresholds all missed; required data absent; rule-coverage gap);
- affected recommendation family (category / pillar), so an author knows where to write;
- jurisdiction, where the cell is large enough to be safe;
- broad financial **bands**, only where a band is genuinely needed to act and the cell survives suppression;
- data-quality vs rule-coverage split;
- trend over time.

### 6.2 Required protections

- The **shared canonical suppression engine** — not a local reimplementation.
- Minimum cell size **5**; minimum distinct people **10** (Admin Architecture Standard §7.2, unless later superseded).
- Complementary suppression, so a suppressed cell cannot be solved by subtraction from a visible total (Standard §7).
- Protection against filter-combination reconstruction — narrowing filters must not isolate a person.
- **No exact individual figures. No direct identifiers. No stable person-level browsing** — no drill-down to a row, ever.
- Distinct `suppressed` / `empty` / `unavailable` / `error` states (Standard §8); a suppressed cell must never render as `0`.
- Safe export controls if any export is offered at all (Standard §11), with suppression at least as strict as the screen.
- Certified metric definitions (Standard §12) — numerator, denominator, dedup rule, refresh behaviour, known limitations.

### 6.3 Explicitly rejected substitutes

**Pseudonymisation is not a substitute for aggregation or suppression.** Replacing `user_id` with a stable surrogate while keeping exact surplus, runway and per-category variance still yields a browsable, linkable, re-identifiable financial profile — and a stable surrogate makes longitudinal tracking of one person *easier*, not harder. The Product Owner decision rules this out directly (requirement 7).

Client-side masking is likewise rejected (requirement 8): anything the server sends is available in the Network tab regardless of what the UI renders.

### 6.4 Migration expectation

None for the interim closure — implemented entirely in the route handler and the client. The aggregate replacement will need a privileged aggregate-only `SECURITY DEFINER` RPC built to Standard §6, with suppression evaluated **inside** the database function; that migration belongs to the phase that builds it, and no number is allocated here.

---

## 7. What was deliberately not done

- No change to `user_recommendation_runs`, its RLS, or any migration — the table's own row-level security was already correct.
- No change to the evaluation engine: runs are still recorded with their full snapshot, because the product feature that serves a person **their own** recommendations depends on it. The data was never the problem; the standing admin read of it was.
- No deletion of any production or DEV record.
- No support or break-glass path.
- No aggregate implementation, and no partial scaffolding of one.
