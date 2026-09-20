# A2.4 — Compatibility Route Register

## 1. No route moves

Per `docs/admin/A1_08_MIGRATION_MAP.md` §10 (confirmed unchanged, re-verified during this pass): "No route in this map requires a compatibility redirect at this stage, because A1 moves no code — every 'move'/'relabel' disposition ... is a future nav-parent change, not a URL change." A2 implements exactly that: every one of the 17 registered destinations (see `A2_03_NAVIGATION_REGISTRY_AND_ROUTE_MAP.md`) keeps its pre-existing URL. `tests/unit/adminA2CanonicalShell.test.ts`'s "Content area sub-groups reuse the exact pre-existing item lists" test asserts the hrefs are byte-identical to the pre-existing `lib/admin/adminNav.ts` lists.

## 2. Route classification (dispatch §17)

| Class | Routes |
|---|---|
| Canonical destination (in the new 8-area nav) | All 17 rows in `A2_03`'s route map |
| Supported deep link | Every dynamic child (`[id]/edit`, `[id]/preview`, `new`) under those 17 — all pre-existing, all still reachable, all still gated by their own existing page-level check |
| Compatibility route (URL preserved, nav parent relabelled) | Every route the old "General"/"Resources"/"Content"/"Workflow"/"Discovery" flat groups used to point at — same URL, now grouped under the new Content/Recommendations/Data Governance/Administration areas |
| Unavailable route (reachable by direct URL only, no nav link) | `/admin/resources/analytics` (ADM-19) — capability gate (`canViewResourceAnalytics`) and route unchanged; nav link stays suppressed per `A1_06` §3 rule 9 |
| Withdrawn route (fail-closed, permanent stub) | `api/admin/recommendations/gaps` (ADM-06) — unchanged 503 stub, per the PO-9 carve-out already exercised in `A1_08` §2; A2 introduces no new withdrawn route and does not touch this one |
| Future retirement candidate | None identified by A2 — `A1_08` §10 lists none, and A2 introduces no new candidate |

## 3. Breadcrumb/route resolution proof

`resolveBreadcrumbs()` (`lib/admin/adminAreas.ts`) is a longest-prefix-match registry covering every existing page path, tested against 26 real routes including dynamic children (`.../content/abc-123/edit`, `.../videos/abc-123/edit`, `.../ctas/new`) in `tests/unit/adminA2CanonicalShell.test.ts`. Three properties are directly tested:

- **No redirect loops possible** — this function only resolves a label, it never issues a redirect itself; the only redirects in the new code (`app/(app)/admin/layout.tsx`'s `if (!user) redirect('/login')`, and `requireResourceAdminAccess()`'s pre-existing `/login`/`/dashboard` redirects) are one-way, terminal, and unconditional on any nav state.
- **No fabricated titles** — an unmapped/future path falls back to a single generic "Admin" crumb; a dynamic detail route falls back to its parent list's own crumb rather than guessing a record title.
- **Longest-prefix-wins** — a more specific route (`/admin/resources/content/drafts`) is never shadowed by a shorter sibling prefix (`/admin/resources/content`, `/admin/resources`).

## 4. Query-string preservation

Neither `AdminShell` nor `resolveBreadcrumbs()` reads or strips query parameters — `usePathname()` (Next.js) never includes the query string, so active-route matching and breadcrumb resolution are query-string-agnostic by construction; a caller's own query parameters (e.g. a queue's filter state) survive navigation unchanged because the shell never touches `window.location.search` or rewrites the URL.

## 5. Direct-route authorization ahead of any redirect

Every redirect in the new code (`/login`, `/dashboard`) fires only after the caller's real role snapshot (`getCurrentResourceRoles()`) is resolved server-side — never based on a menu label, client state, or URL shape. No redirect in this change discloses whether a restricted route exists (both redirects land on generic, always-reachable destinations, not a "this page exists but you can't see it" response).
