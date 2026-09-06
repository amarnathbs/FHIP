# A2.1 — Canonical Shell Specification

**Status:** Implemented, DEV-only, uncommitted work reconciled and extended against the full A2 dispatch. Not merged, not deployed.

## 1. One canonical shell

`components/admin/AdminShell.tsx`, mounted by `app/(app)/admin/layout.tsx`, is the single shared shell for every page under `app/(app)/admin/**`. There is exactly one Admin layout file in that route tree (`app/(app)/admin/layout.tsx`) — no competing or duplicate Admin layout exists.

The shell is **additive**, nested inside the pre-existing `app/(app)/layout.tsx` → `AppShell` chrome, which continues to render its own sidebar (including its own pre-existing "Admin" dropdown from `lib/admin/adminNav.ts`) completely unchanged. This was a deliberate reconciliation decision: `lib/admin/adminNav.ts`'s exports (`buildAdminNavGroups`, `shouldShowAdminMenu`, `AdminCapabilities`, the four legacy item lists, `parseAdminCapabilities`/`parseIsAdmin`) are byte-for-byte untouched and remain the certified contract for the outer AppShell dropdown (`tests/unit/adminAnalyticsPhaseA*.test.ts`). `lib/admin/adminAreas.ts` is a second, independent consumer of the same underlying item lists and the same capability booleans, feeding the new canonical shell instead of re-deriving authorization. This satisfies dispatch §5's "avoid multiple competing Admin layouts" without touching a certified regression surface.

A caller reaches the canonical shell either through the outer AppShell's existing links or by navigating directly to any `/admin/**` URL; once inside, the shell's own breadcrumbs and 8-area nav become the way to move around Admin.

## 2. What the shell provides (dispatch §5 checklist)

| Requirement | Implementation |
|---|---|
| Admin product identity | Breadcrumb root "Admin" linking to `/admin/home`; area labels in the nav |
| Role-aware navigation | `areas` prop, computed server-side per request from `getCurrentResourceRoles()` |
| Desktop persistent navigation | `<aside>` at `lg:` (1024px) and above, `aria-label="Admin navigation"` |
| Mobile navigation drawer | Disclosure below `lg`, triggered by a `Menu`/`X` icon button, `aria-expanded`/`aria-controls` |
| Page-title region | Left to each page's own `<h1>` (dispatch §7: do not mechanically duplicate) |
| Breadcrumbs | `resolveBreadcrumbs()` — longest-prefix-match route registry |
| Main content landmark | `<main id="admin-main-content" tabIndex={-1}>` |
| Task-help access | Reused verbatim per-page via the pre-existing `AdminTaskHelp` component (Wave 5) — not duplicated at the shell level |
| Account/role context | Provided by the outer AppShell (unchanged) |
| Sign-out / return path | Provided by the outer AppShell (unchanged) — the canonical shell does not duplicate it |
| Loading/failure states | Server component; Next.js route-level `loading.tsx`/error boundary conventions apply as they already do elsewhere in the app — no new pattern introduced |

## 3. Accessibility additions made during this reconciliation pass

The uncommitted shell already had aria-labelled nav regions and `aria-current="page"`. Three gaps against dispatch §20 were found and fixed:

1. **No main-content landmark.** The content pane was a plain `<div>`. Changed to `<main id="admin-main-content" tabIndex={-1}>` so a skip link and post-navigation focus have a real target.
2. **No skip link.** Added a visually-hidden-until-focused "Skip to main content" link as the first focusable element inside the shell, scoped to Admin only (the outer app has no shell of its own to skip, and dispatch §5 scopes the shell to Admin).
3. **No Escape handling or focus return for the mobile drawer.** Added: Escape closes the drawer and returns focus to the trigger button; selecting a destination inside the drawer closes it and moves focus to `#admin-main-content` (dispatch §11/§20 — "mobile navigation closes and transfers focus correctly after selection").

## 4. Authorization boundary (dispatch §6)

`AdminShell` and `buildAdminAreas()` perform **no capability check of their own** beyond the same predicates every route already independently enforces:

- `app/(app)/admin/layout.tsx` redirects a logged-out user to `/login` as defense-in-depth (the same pattern several individual Admin pages already use) — this is explicitly documented as *not* the security boundary; each page keeps its own gate.
- Navigation visibility is computed from `getCurrentResourceRoles()` → the existing `canViewResource*`/`canManageResources` predicates in `lib/resources/permissions.ts`, and `isSuperAdmin` from `admin_users` — the same fields every pre-existing Resources gate already reads. No second capability resolver was introduced, no broad `isAdmin` flag was substituted for a specific capability, and no client-side capability fetch exists (the whole computation is server-side, once per request).
- A temporary client loading state cannot flash unauthorized destinations, because `areas` is computed server-side before the shell ever renders — there is no client-side capability fetch/loading state to race.

## 5. Deliberately not done in A2 (scope boundary)

- No split of `requireAdmin()`/`isAdmin` into named capabilities for Benchmarks/Recommendations (an *optional* future item sketched in `A1_20`'s roadmap narrative, not in this dispatch's §4 Included list). Keeping the existing broad Super-Admin gate for Recommendations and Data Governance/Benchmarks is the more conservative choice and introduces zero authorization-risk surface — deferred to A3.3 exactly as `A1_20` itself proposes.
- No FDH Admin group, no `isFdhAdmin`, no FDH-specific role, no FDH governance screens (dispatch §22).
- No Analyst dashboard and no second Analyst nav system (dispatch §23) — Analytics remains hidden for every persona, including Resource Admin, because `origin/main` still equals the A1 merge SHA `a9d09f1` (verified via `git fetch` — no Analyst-stream merge has landed since A1).
