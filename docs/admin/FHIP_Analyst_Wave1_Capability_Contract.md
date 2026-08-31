# FHIP Analyst Analytics Intelligence Centre — Wave 1 Capability Contract

**Wave:** 1 (capability, navigation and access boundary)
**Status:** implemented, certified locally, awaiting Product Owner review and separate push/merge authorisation
**Branch:** `feature/analyst-analytics-wave1-access`, from `origin/main` `1b40b0be0bbb6b7d67b611e08ca255e68562abf1`
**Governing standard:** [`FHIP_ADMIN_ARCHITECTURE_STANDARD.md`](./FHIP_ADMIN_ARCHITECTURE_STANDARD.md) v1.0

> **THERE ARE NO ANALYTICS IN WAVE 1.** No metric, aggregate, RPC, count,
> percentage, chart, export or telemetry exists. The Analytics Intelligence
> Centre is **not operational**. Wave 1 builds only the capability model, the
> navigation that reflects it, a protected empty route, and the API denial
> behaviour that makes the boundary real. Metrics A3–A8 belong to later,
> separately authorised waves.

---

## 1. The five capabilities

Defined in `lib/resources/permissions.ts`. Each is a separately named,
separately documented, separately tested policy function taking the shared
`CurrentResourceRoles` snapshot returned by `getCurrentResourceRoles()`
(Standard §2).

| Capability predicate | Governs | Granted to |
|---|---|---|
| `canViewResourceDashboard` | Resources → Dashboard nav group | Content-workflow staff (`isResourceStaff`) |
| `canViewResourceContent` | Content nav group (All/New Content, Videos, Glossary, FAQs, Money Updates) | Content-workflow staff |
| `canViewResourceWorkflow` | Workflow nav group (six queues) | Content-workflow staff |
| `canViewResourceDiscovery` | Discovery nav group (Related Content, CTAs, Context Mapping) | Content-workflow staff |
| `canViewResourceAnalytics` | Analytics nav group **and** the `/admin/resources/analytics` route | Analyst, Resource Admin, Super Admin |

"Content-workflow staff" is the pre-existing `CONTENT_WORKFLOW_ROLES` set:
`resource_admin`, `author`, `editor`, `compliance_reviewer`, `publisher` —
plus Super Admin. It deliberately excludes `analyst`.

**Why four of the five share one underlying check today.** That *is* today's
real, shared requirement for those four destinations. They remain four
separate policy functions because a future change to one destination's
requirement must be a one-line edit to that function's own body, with zero
risk of silently changing the other three. Four identical bodies are not the
same thing as one shared boolean (Standard §2's closing paragraph).

### 1.1 Role → capability truth table

| Caller | Dashboard | Content | Workflow | Discovery | Analytics |
|---|:--:|:--:|:--:|:--:|:--:|
| Logged out | No | No | No | No | No |
| Authenticated, no role | No | No | No | No | No |
| Analyst only | No | No | No | No | **Yes** |
| Author only | Yes | Yes | Yes | Yes | No |
| Editor only | Yes | Yes | Yes | Yes | No |
| Compliance Reviewer only | Yes | Yes | Yes | Yes | No |
| Publisher only | Yes | Yes | Yes | Yes | No |
| Resource Admin | Yes | Yes | Yes | Yes | **Yes** |
| Super Admin | Yes | Yes | Yes | Yes | **Yes** |
| Analyst + any of the above | Union of both roles | Union | Union | Union | **Yes** |
| Revoked / inactive role only | No | No | No | No | No |
| Unknown / malformed role value only | No | No | No | No | No |

**Additive union (Standard §3).** Every predicate tests role *membership*, so
holding `analyst` alongside another role yields the union of both roles'
capabilities. Analyst never displaces, narrows or shadows another role's
access, and never grants an editorial, workflow, compliance, publishing or
role-management capability of its own.

**Fail closed (Standard §13).** `getCurrentResourceRoles()` returns
`{ userId: null, isSuperAdmin: false, roles: [] }` for an unresolved or
logged-out caller, which every predicate evaluates to `false`.

---

## 2. `GET /api/admin/me`

Calls the shared `getCurrentResourceRoles()` **exactly once** per request and
derives all five capabilities as pure evaluations over that one role snapshot.
The route holds no Supabase client, no `admin_users`/`resource_user_roles`
query and no `.limit(1)` existence-only role logic of its own.

```ts
{
  isAdmin: boolean,            // unchanged legacy field: admin_users membership
  hasResourcesAccess: boolean, // unchanged legacy field: Super Admin or any role
  capabilities: {
    resourcesDashboard: boolean,
    resourceContentAdmin: boolean,
    resourceWorkflowAdmin: boolean,
    resourceDiscoveryAdmin: boolean,
    resourceAnalytics: boolean
  }
}
```

Both legacy fields are preserved verbatim for existing consumers. **Neither is
used to derive any capability, and neither may be repurposed as one.** A
logged-out caller receives `200` with every flag `false` and a complete,
stable, all-false `capabilities` object — never a partial body, never a `403`
(this endpoint is a UX hint, not a gate).

---

## 3. Navigation

`lib/admin/adminNav.ts` holds the nav decision as pure functions;
`components/ui/AppShell.tsx` renders them. Each group reads its **own**
capability field. There is no broad staff variable, no `isResourceStaffAccess`,
no `hasAdminAccess`, and `hasResourcesAccess` is not consulted by any nav
decision.

| Caller | Visible Admin groups |
|---|---|
| No role | *(Admin menu hidden entirely)* |
| Analyst only | Analytics |
| Author / Editor / Compliance Reviewer / Publisher | Resources, Content, Workflow, Discovery |
| Resource Admin | Analytics, Resources, Content, Workflow, Discovery |
| Super Admin | General, Analytics, Resources, Content, Workflow, Discovery |
| Analyst + any staff role | Analytics + that role's groups |

The outer "Admin" entry point is shown exactly when at least one group would
render, so it can never present an empty dropdown and can never itself act as
a capability check for a particular destination.

**Loading and failure.** Capabilities start at the frozen all-false
`NO_ADMIN_CAPABILITIES` and only ever become true from a successfully parsed
response. A non-OK status, a network failure, a missing `capabilities` key, or
a truthy-but-not-boolean field all resolve to `false`. No unauthorised group is
exposed during loading, and an API failure never becomes a grant.

**Navigation is not authorisation (Standard §4).** Everything above is UX only.

---

## 4. The protected route shell

`app/(app)/admin/resources/analytics/page.tsx`, at `/admin/resources/analytics`.

Re-derives `canViewResourceAnalytics` on the server, independently of
navigation:

| Caller | Result |
|---|---|
| Logged out | redirect → `/login` |
| Authenticated, no Resources role | redirect → `/dashboard` |
| Author / Editor / Compliance Reviewer / Publisher only | redirect → `/admin/resources` |
| Analyst, Resource Admin, Super Admin, or any multi-role combination including one of those | permitted |

The redirect convention matches `/admin/resources/users`, which already applies
its own stricter-than-the-shell gate this way.

**Contents.** A page title, a one-line description that it is a read-only Admin
analytics area, and a neutral controlled state saying analytics surfaces are
being introduced in subsequent authorised waves. It contains no figure of any
kind (a test asserts the rendered text contains no digit at all), no export
control, no telemetry, no link to any editorial, workflow, publishing,
compliance or role-management page, and it makes no analytics API or database
call. Its only database reads are the two role-resolution reads the access gate
itself performs.

---

## 5. Eight corrected API routes

The `GET` handlers of these eight files replaced the coarse
`!current.isSuperAdmin && current.roles.length === 0` check — which any single
Resources role cleared, Analyst included — with `!isResourceStaff(current)`:

`content`, `videos`, `glossary`, `faqs`, `money-updates`, `tags`, `authors`,
`categories` (all under `app/api/admin/resources/`).

Before Wave 1 an Analyst passed the coarse check, the route then ran its list
query on the caller's own RLS-scoped client, and RLS returned a partial or
entirely empty result — a `200` indistinguishable from "this queue is genuinely
empty." That is the misleading-emptiness failure Standard §4 prohibits. This
was verified as a live defect, not a hypothetical: reverting one route's gate
in test makes the Analyst-only case return `200` again.

| Caller | All eight routes |
|---|---|
| Unauthenticated | `401` |
| Authenticated, no Resources role | `403` |
| Analyst only | `403` (was a misleading `200`) |
| Author / Editor / Compliance Reviewer / Publisher / Resource Admin / Super Admin | `200` with the real payload |
| Analyst + Editor (or any staff role) | `200` with the real payload |

Only the predicate changed. The error message, status code, query logic and
response payloads are byte-identical, and no `POST`, `PATCH`, transition or
mutation handler was touched.

**Explicitly out of scope, verified still correct and unmodified:**
`dashboard/route.ts` (keeps its coarse first-pass check because it immediately
branches on `isResourceStaff()` and returns a safe `analystPlaceholder` rather
than a misleading partial dataset), the three Discovery routes (`related`,
`ctas`, `context` — already gate on `isResourceStaff`), every item-level
`GET`/`PATCH`, and every workflow-transition endpoint (enforced by the
`transition_resource_post_status` RPC itself).

---

## 6. Known limitations

1. **No analytics exist.** The Intelligence Centre is a shell. It is not
   operational and must not be described as such.
2. **No live-DEV verification.** Wave 1 was certified entirely against
   hermetic local tests; the Product Owner's brief prohibited DEV, staging and
   production access for this wave. The Phase A Plan's T1.2 acceptance
   criterion ("proven live in a DEV-equivalent test environment") is therefore
   **deferred**, not met, and should be scheduled into a later wave's live-DEV
   pass.
3. **No DOM-level navigation test.** This repository has no DOM test
   environment (vitest runs `environment: 'node'`; neither jsdom nor
   `@testing-library` is a dependency). The nav decision is therefore extracted
   into pure functions and asserted group-by-group; the *rendering* of those
   groups is not asserted. Adding a DOM test environment was out of Wave 1's
   authorised scope.
4. **Static export is not exercisable in a credential-free worktree.** The
   production build compiles and type-checks cleanly, but its static-export
   step needs Supabase environment variables. This reproduces identically on
   untouched `origin/main` — it is an environment condition, not a Wave 1
   regression.
5. **Role revocation propagates on the next request.** `/api/admin/me` is
   fetched once per AppShell mount, so a revocation is reflected on the next
   page load rather than instantly. Route- and API-layer enforcement re-derive
   roles on every request regardless, so this affects only nav visibility,
   which is not an authorisation boundary.
6. **`hasResourcesAccess` is retained but obsolete.** It is preserved only for
   backward compatibility and is consulted by nothing in the new design. It
   should be removed once no consumer depends on it — deliberately not done in
   Wave 1, which was not authorised to change legacy consumers.

---

## 7. Rollback

Wave 1 is application-layer only — no migration, schema, RLS, grant or RPC
change — so it reverts cleanly by git alone.

- **Whole wave:** revert the Wave 1 commits on
  `feature/analyst-analytics-wave1-access`. Nothing else is required; no
  database state was created or altered.
- **Route only:** change `canViewResourceAnalytics` in
  `app/(app)/admin/resources/analytics/page.tsx` to an always-deny, leaving
  navigation intact.
- **Navigation only:** remove the `resourceAnalytics` entry from
  `buildAdminNavGroups` in `lib/admin/adminNav.ts`, leaving the route intact.
- **Eight-route gate only:** restore
  `!current.isSuperAdmin && current.roles.length === 0` in the eight `GET`
  handlers. Note this reinstates the misleading-emptiness defect and should
  only be done as an emergency measure.

---

## 8. Future-review owner

Product Owner, at the Wave 2 authorisation boundary. The capability set must
be revisited at that point, because Wave 2's aggregate RPCs introduce the first
capability that gates real data rather than an empty shell.
