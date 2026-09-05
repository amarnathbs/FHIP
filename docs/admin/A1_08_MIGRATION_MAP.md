# A1.2 — Current-to-Future Migration Map

Every existing Admin page (36) and API route file (74, 106 handlers) gets a disposition: **retain** / **relabel** / **move** / **consolidate** / **split** / **hide-until-ready** / **withdraw** / **defer** / **compatibility-redirect** / **retirement-candidate**. No route is silently dropped from this map. Grouped at route-file granularity (matching `A02_WAVE4_FLAT_AUTHORIZATION_REGISTER.md`'s own sections, so this map can be cross-checked row-for-row against that register). Target-area names below use the **PO-2-approved 8-area structure** (`A1_06`): Home, Content, Recommendations, Data Governance, Operations, Analytics, Security & Support, Administration.

**PO-9 ruling (route retirement) applied throughout this document:** no route or compatibility field may be retired merely because the redesigned UI stops linking to it. The required process — identify all callers and deep links; introduce the replacement; preserve authorization; use a compatibility redirect or stable withdrawn response where appropriate; monitor usage for at least one release cycle; document rollback; obtain explicit retirement authorization — governs every "retirement-candidate" disposition below. The one carve-out PO-9 grants: **privacy-unsafe routes may be withdrawn immediately using a fail-closed response**, exactly as already done for `recommendations/gaps` (§2) — that precedent is not reopened, and no other route in this map claims that carve-out.

## 1. Benchmarks (10 API files, 1 page)

| Route(s) | Disposition | Target |
|---|---|---|
| `admin/benchmarks/page.tsx` | **move** | Under the new "Data Governance" top-level area (was inside the unlabelled "General" group; PO-2 places Benchmarks/reference data inside Data Governance, not a standalone "Reference Data & Benchmarks" area) — same page, new nav parent |
| `api/admin/benchmarks/**` (10 files) | **retain** | No path change; capability gate is a future A2/A3 candidate (split `requireAdmin` into a named `canManageBenchmarks`, see `A1_02` §2 finding) but the route itself is unchanged |

## 2. Recommendations (4 API files, 1 page)

| Route(s) | Disposition | Target |
|---|---|---|
| `admin/recommendations/page.tsx` | **move** | Under the new "Recommendations" top-level area (was "General") |
| `api/admin/recommendations`, `recommendations/[id]`, `recommendations/upload` | **retain** | No path change |
| `api/admin/recommendations/gaps` | **withdraw** (already withdrawn) | Route stays as a permanent 503-returning stub — this is exactly PO-9's "privacy-unsafe routes may be withdrawn immediately using a fail-closed response" carve-out, applied in advance of PO-9's own ruling and now explicitly confirmed compliant with it, not merely a Wave 5 precedent A1 hoped would still hold. **Retirement-candidate for the route itself once the canonical suppression-engine replacement (`A1_15`) ships and ADM-06 is redesigned as an aggregate feature** — retiring the stub route at that point still requires PO-9's full ordinary process (callers/deep-links identified, replacement introduced, monitored one release cycle, explicit retirement authorization) since by then it is no longer the privacy-unsafe case the immediate-withdrawal carve-out covers; until then the stub must remain (removing it outright would be an undocumented route deletion PO-9 prohibits, and the stub itself is the compatibility story) |

## 3. AI Admin (19 API files, 0 pages) — Module 11 boundary

| Route(s) | Disposition | Target |
|---|---|---|
| `api/admin/ai/**` (all 19 files) | **retain**, **defer** UI | Path unchanged; grouped under the new "Administration" (config: controls/models/prompts/providers/entitlements/cost-limits/evaluations/insight-packs/standard-questions) and "Operations" (kill-switch) and "Security & Support" (safety-events/config-audit) areas **once Module 11 authorises a UI** — A1 does not build one; see `A1_20` roadmap for how a future wave would slice this 19-route surface across 3 nav areas without moving a single route path |

## 4. Resources — Users & Roles (2 API files, 1 page)

| Route(s) | Disposition | Target |
|---|---|---|
| `admin/resources/users/page.tsx` | **move** | Under "Administration" (role assignment), generalised later into ADM-44's canonical role-management surface without breaking this specific page's URL (a canonical role page would be additive, e.g. `/admin/roles`, not a replacement — this page keeps working for Resources roles specifically) |
| `api/admin/resources/users`, `users/roles` | **retain** | No path change |

## 5. Resources — Discovery (7 API files, 2 pages)

| Route(s) | Disposition | Target |
|---|---|---|
| `admin/resources/related/page.tsx`, `admin/resources/context/page.tsx` | **relabel** | Move under "Content" area's Discovery sub-group (rename from "Discovery" top-level group to a sub-group of Content, consistent with `A1_06`) |
| CTA pages (`admin/resources/ctas/**`, 3 pages) | **relabel** | Same — Content → Discovery sub-group |
| `api/admin/resources/{related,ctas,context}/**` (7 files) | **retain** | No path change |

## 6. Resources — Content-type CRUD (23 API files, ~28 pages)

| Route(s) | Disposition | Target |
|---|---|---|
| All `admin/resources/{content,videos,glossary,money-updates,faqs}/**` pages | **relabel** | Consolidate under "Content" top-level area (today split across "Content"/"Workflow" nav groups; A1.2 folds Workflow's 6 queues into Content as a sub-group, not a separate top-level area — see `A1_06` §2.2) |
| Content queue pages (drafts/review/scheduled/published/review-due/archived) | **relabel** | Same — become Content's "Queues" sub-group |
| `admin/resources/content/scheduled/page.tsx` specifically | **hide-until-ready** | Already correctly non-functional-but-honest (ADM-10); stays hidden from nav until A3.1 ships a real scheduler, exactly as today |
| All corresponding `api/admin/resources/**` routes (23 files) | **retain** | No path change |

## 7. Resources — shared lookup + self-resolution (5 API files, 0 pages)

| Route(s) | Disposition | Target |
|---|---|---|
| `api/admin/resources/{categories,authors,tags,sources}` | **retain** | Internal picker endpoints, no nav surface needed |
| `api/admin/me` | **retain** | Becomes the model for a **future generalised capability-resolution endpoint** once non-Resources capabilities (CAP-19+) exist — the response shape would grow additively (new keys), never break existing consumers |

## 8. Resources dashboard, analytics shell

| Route(s) | Disposition | Target |
|---|---|---|
| `admin/resources/page.tsx` | **relabel** | Becomes Content's own landing/dashboard sub-page. **PO-3 resolves the "does Home absorb this?" question A1 originally flagged: no.** PO-3 approves Admin Home as a role-aware operational work queue, not a metrics dashboard — it is explicitly not a replacement for or duplicate of a domain's own dashboard-style page. `admin/resources/page.tsx` keeps its existing dashboard content, relabelled under Content; Home aggregates queues (its own, distinct value, per `A1_09`) and never absorbs this page's content |
| `admin/resources/analytics/page.tsx` | **hide-until-ready** (already hidden) | Stays exactly as-is — protected shell, hidden from nav, honest notice — until the canonical suppression engine (`A1_15`) makes it a real Analytics-area destination (ADM-46); consistent with PO-2's "do not expose Analytics until genuinely functional" rule |

## 9. Data Governance (FDH portion), Analytics (canonical), Security & Support, Operations, Administration (future-only additions)

No existing route occupies these paths today. Every task ADM-30 through ADM-46 (except the already-existing AI Admin and role-assignment tasks covered above) is a **net-new route**, not a migration of an existing one. Listed here only so the map is complete — nothing to disposition because nothing exists yet:

| Future task | Proposed path (illustrative, not binding) |
|---|---|
| ADM-30–36, 40 | `/admin/data-governance/**` (shared with Benchmarks' existing `/admin/benchmarks`, per PO-2 — illustrative only, not a proposal to move the existing Benchmarks route path) |
| ADM-37, 46 | `/admin/analytics/**` |
| ADM-38, 39, 42, 43 | `/admin/security/**` |
| ADM-41, 44, 45 | `/admin/administration/**` |

## 10. Compatibility-redirect / route-retirement policy (PO-9-governed)

**No route in this map requires a compatibility redirect at this stage**, because A1 moves no code — every "move"/"relabel" disposition above is a **future nav-parent change**, not a URL change. When A2 actually implements the canonical shell, any URL that does change (none is currently planned) must follow PO-9's full binding process before retirement of the old URL is even considered:

1. Identify all callers and deep links (external bookmarks, internal links, any integration).
2. Introduce the replacement route/page first.
3. Preserve authorization — the replacement must enforce at least the same capability check as the original, never a weaker one.
4. Use a compatibility redirect (old URL → new URL, 30x) or a stable withdrawn response (a deliberate, documented terminal state — e.g. `recommendations/gaps`'s 503 stub) where appropriate.
5. Monitor usage of the old route for **at least one release cycle** before removing it.
6. Document a rollback path (how to restore the old route if retirement causes a regression).
7. Obtain **explicit retirement authorization** from the Product Owner before the old route is actually deleted.

**The one exception PO-9 grants:** a privacy-unsafe route may be withdrawn immediately with a fail-closed response, skipping the monitor/authorization steps above — `recommendations/gaps` already used this exception (§2) and is the only route in this map that does. Every other "move"/"relabel"/"retirement-candidate" disposition in this document is subject to the full 7-step process, not the exception, whenever A2/A3 actually changes a URL.

## 11. Reconciliation

36 pages + 74 API route files = 110 route artifacts. Every one appears in exactly one section (1–8) above with a disposition, or is explicitly named as not-yet-existing (§9). **Zero routes are retired outright** — the only near-retirement item is `recommendations/gaps`, which stays as a permanent honest-stub rather than being deleted (§2), consistent with PO-9's privacy-unsafe-route carve-out. **Zero routes are silently dropped from this map**, and no future retirement of any route in this map may skip PO-9's 7-step process (§10) without meeting that same carve-out.
