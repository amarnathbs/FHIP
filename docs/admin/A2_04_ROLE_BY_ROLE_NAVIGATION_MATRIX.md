# A2.2 — Role-by-Role Navigation Matrix

Reproduced from `buildAdminAreas()`'s actual behaviour, exercised by the persona-matrix tests in `tests/unit/adminA2CanonicalShell.test.ts` (9 cases, all hermetic — no DEV/network access). "Today" reflects what exists on this branch; it deliberately narrows `A1_07` §2's own illustrative "future A2-A5 end state" table (that table shows Resource Admin eventually gaining Analytics — not applicable to A2 alone, since Analytics stays hidden for every persona per dispatch §9/§23 and the confirmed absence of any merged Analyst-stream functionality on `origin/main`).

| Persona | Visible top-level areas | Admin entry point | Direct-route enforcement (independent of nav) |
|---|---|---|---|
| Anonymous user | none | Redirected to `/login` before any Admin content renders (`app/(app)/admin/layout.tsx`, and independently `requireResourceAdminAccess()` on `/admin/home`) | 401-equivalent redirect on every Admin route |
| Role-less authenticated user | none (`buildAdminAreas` returns `[]`) | Redirected to `/dashboard` from `/admin/home`; no Admin entry point anywhere in the outer AppShell either | Every Admin page's own gate independently redirects/403s this caller |
| Analyst only | Home | Admin Home (queue is empty — Analyst has no mutation-oriented queue item per `A1_09` §4) | `/admin/resources`, `/admin/benchmarks`, etc. all independently reject |
| Author only | Home, Content | Home → Content (own drafts) | — |
| Editor only | Home, Content | Home → Content (review queue) | — |
| Compliance Reviewer only | Home, Content | Home → Content (review queue, no own-drafts tile) | — |
| Publisher only | Home, Content | Home → Content | — |
| Resource Admin | Home, Content, Administration | Home → Content + Administration (Resources-role assignment slice only) | `/admin/recommendations`, `/admin/benchmarks` independently reject (still Super-Admin-only) |
| Super Admin | Home, Content, Recommendations, Data Governance, Administration | Home → everything visible to this role today | N/A (top of the model) |
| Analyst + Resource Admin (mixed) | Home, Content, Administration (union, no duplicates) | Same as Resource Admin, plus Analyst's own (still-empty) Home queue tiles | — |

Operations, Analytics and Security & Support never appear for any persona today — confirmed by an explicit test (`tests/unit/adminA2CanonicalShell.test.ts`, "no persona ever sees Operations, Analytics or Security & Support today") that runs even against a caller with every legacy capability flag set to `true`. This matches `A1_06` §3 rules 1/9: those three areas currently have zero genuinely usable destinations for any caller, so they are omitted entirely rather than shown empty or as placeholders.

## Mixed-role deduplication

Each area is evaluated once per `buildAdminAreas()` call from the caller's full `CurrentResourceRoles` snapshot — there is no per-role loop that could emit the same area twice. The "Analyst + Resource Admin" row above is a direct test case proving the union renders without duplicate top-level areas.

## Manual/help access per role

Every visible destination's task-help disclosure ("How to use this page") is capability-gated by nothing beyond the page itself being reachable — the same `AdminTaskHelp` component and `lib/admin/taskHelp.ts` registry (Wave 5, unchanged by A2) renders on every content/workflow/discovery/benchmarks/recommendations/users page already in production. No role sees a task-help entry for a task it cannot perform, because it cannot reach that page's route at all.
