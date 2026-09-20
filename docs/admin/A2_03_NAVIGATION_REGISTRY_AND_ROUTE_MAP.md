# A2.2 — Navigation Registry and Route Map

## 1. Registry location

`lib/admin/navigationRegistry.ts` exports `NAV_DESTINATIONS: NavDestination[]` and `getVisibleDestinations()`. Per destination it carries every field dispatch §8 requires:

| §8 field | Registry field |
|---|---|
| Stable navigation ID | `id` |
| Top-level area | `area` (one of the 8 canonical areas) |
| Label | `label` |
| Description | `description` |
| Route | `route` |
| Required capability/predicate | `capability` (names the exact `AdminCapabilities` field, `isAdmin`, or `canManageResources` — documentation of which existing check applies, never a re-implementation) |
| Applicable roles (docs only) | `applicableRolesForDocs` |
| Visibility state | `visibilityState` (`'available'` for every row — see §2) |
| Availability state | `availabilityState` (`'operational'` for every row — see §2) |
| Task-manual reference | `taskManualId` (+ `taskManualNote` when null) |
| Ordering | `order` (1-based within its area) |
| Active-route matching | `matchMode` (`'exact'` \| `'prefix'`) |
| Whether children exist | `hasChildren` |
| Owner/future stage where unavailable | N/A — see §2 |

This is layered **on top of** `buildAdminAreas()` (`lib/admin/adminAreas.ts`), which remains the sole authorization decision. `getVisibleDestinations()` cross-references the static metadata against `buildAdminAreas()`'s real output for one caller — it can show nothing `buildAdminAreas()` would hide, and hide nothing it shows. No new capability predicate was introduced by this file.

## 2. Why every row is `visibilityState: 'available'` / `availabilityState: 'operational'`

Dispatch §9 defines three states (Available / Unavailable / Hidden) and is explicit that "Unavailable" is shown "only when the operator genuinely needs awareness of the future or unavailable function," and that A1_06's own binding rules (§3, rules 1–5) go further for this codebase specifically: a future/reserved task gets **no nav entry at all**, not a disabled or "coming soon" entry, until it is genuinely usable. Consistent with that, `NAV_DESTINATIONS` only lists destinations that are live, operational pages today. Withdrawn/future tasks (Recommendations Gap review = ADM-06, Scheduled publication = ADM-10, Resources analytics = ADM-19, and every FDH-13 Data-Governance/Operations/Analytics/Security & Support future task) are:

- absent from this registry (no live nav row would ever point at them);
- still traceable in `docs/admin/A1_16_FDH13_TRACEABILITY_MATRIX.md` and its companion CSV, and in `lib/admin/taskHelp.ts`'s `not_operational` entries — reachable by direct, capability-gated URL, per §17's compatibility rules, with an honest on-page explanation instead of a nav link.

A registry entry that models "Hidden" (no capability) is likewise unnecessary as a *row*: `getVisibleDestinations()` naturally omits a destination the caller lacks the capability for, because it cross-references `buildAdminAreas()`'s real output rather than rendering every row unconditionally.

## 3. Full route map (17 destinations, all pre-existing routes — no URL changes)

| Area | Order | Label | Route | Capability | Manual |
|---|--:|---|---|---|---|
| Home | 1 | Admin Home | `/admin/home` | any admin capability (`shouldShowAdminMenu`) | — (own on-page guidance) |
| Content | 1 | Dashboard | `/admin/resources` | `resourcesDashboard` | ADM-07 |
| Content | 2 | All Content | `/admin/resources/content` | `resourcesDashboard` | ADM-08 |
| Content | 3 | New Content | `/admin/resources/content/new` | `resourcesDashboard` | ADM-08 |
| Content | 4 | Videos | `/admin/resources/videos` | `resourceContentAdmin` | ADM-11 |
| Content | 5 | Glossary | `/admin/resources/glossary` | `resourceContentAdmin` | ADM-12 |
| Content | 6 | FAQs | `/admin/resources/faqs` | `resourceContentAdmin` | ADM-14 |
| Content | 7 | Money Updates | `/admin/resources/money-updates` | `resourceContentAdmin` | ADM-13 |
| Content | 8 | Drafts | `/admin/resources/content/drafts` | `resourceWorkflowAdmin` | ADM-21 |
| Content | 9 | Review Queue | `/admin/resources/content/review` | `resourceWorkflowAdmin` | ADM-21 |
| Content | 10 | Scheduled | `/admin/resources/content/scheduled` | `resourceWorkflowAdmin` | ADM-21 |
| Content | 11 | Published | `/admin/resources/content/published` | `resourceWorkflowAdmin` | ADM-21 |
| Content | 12 | Review Due | `/admin/resources/content/review-due` | `resourceWorkflowAdmin` | ADM-21 |
| Content | 13 | Archived | `/admin/resources/content/archived` | `resourceWorkflowAdmin` | ADM-21 |
| Content | 14 | Related Content | `/admin/resources/related` | `resourceDiscoveryAdmin` | ADM-16 |
| Content | 15 | CTAs | `/admin/resources/ctas` | `resourceDiscoveryAdmin` | ADM-15 |
| Content | 16 | Context Mapping | `/admin/resources/context` | `resourceDiscoveryAdmin` | ADM-17 |
| Recommendations | 1 | Recommendations | `/admin/recommendations` | `isAdmin` | ADM-04 (+ADM-05) |
| Data Governance | 1 | Benchmarks | `/admin/benchmarks` | `isAdmin` | ADM-01 (+ADM-02/03) |
| Administration | 1 | Users & Roles | `/admin/resources/users` | `canManageResources` | ADM-18 |

Task-manual links were verified against the *actual* `<AdminTaskHelp taskId="...">` usage in each route's own client component (not inferred) — e.g. `components/resources/admin/ResourceContentListClient.tsx:172` renders `ADM-21` for every filtered queue and `ADM-08` for the unfiltered "All Content" list; `components/admin/AdminBenchmarksClient.tsx:314` renders a tab-dependent id (`ADM-01`/`02`/`03`).

## 4. Registry integrity tests

`tests/unit/adminA2NavigationRegistry.test.ts` asserts: unique ids; unique routes; every area is one of the 8 canonical areas with contiguous, non-tied ordering; every route resolves to a real `page.tsx`; every non-null `taskManualId` exists in `lib/admin/taskHelp.ts`; every null `taskManualId` carries an explanatory note; the three withdrawn task ids are never referenced and the withdrawn Analytics route is never listed; every named capability is a real `AdminCapabilities` key or one of the two documented predicates; `getVisibleDestinations()` never disagrees with `buildAdminAreas()`'s real output across 4 representative personas including role-less; no visible top-level area or sub-group ever renders empty; every destination has manual coverage or an explicit note.
