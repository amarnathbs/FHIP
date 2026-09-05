# A1.2 — Navigation Blueprint by Role

**Eight areas (`A1_06`, PO-2-approved: Home, Content, Recommendations, Data Governance, Operations, Analytics, Security & Support, Administration).** "Today" = what actually renders now (unchanged by A1). "Future" = what would render once A2+ builds the canonical shell — no code implements this yet.

## 1. Today (unchanged, current `buildAdminNavGroups()`)

| Caller | Rendered groups |
|---|---|
| No role | *(Admin entry point hidden entirely)* |
| Analyst only | Analytics *(hidden per Wave 3 Gate 3 — see note)* |
| Author / Editor / Compliance Reviewer / Publisher | Resources, Content, Workflow, Discovery |
| Resource Admin | Resources, Content, Workflow, Discovery *(Analytics hidden, same note)* |
| Super Admin | General (Benchmarks+Recommendations), Resources, Content, Workflow, Discovery *(Analytics hidden)* |
| Analyst + any staff role | Union of both rows above *(Analytics still hidden)* |

**Note on "Analytics hidden":** `ANALYTICS_ITEMS` is defined in `lib/admin/adminNav.ts` but `buildAdminNavGroups()` does not include it in its returned array for any caller (Wave 3's own Gate-3 closure) — the route (`/admin/resources/analytics`) and its capability gate (`canViewResourceAnalytics`) still work for a caller who navigates there directly; only the nav *link* is suppressed, consistent with PO-2's own binding rule (`A1_06` §3 rule 9): do not expose Analytics until it contains a genuinely functional authorized destination.

## 2. Future canonical shell (A2+, not built) — PO-2 8-area order and names

| Persona | Home | Content | Recommendations | Data Governance | Operations | Analytics | Security & Support | Administration |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| **1. Role-less authenticated user** | — | — | — | — | — | — | — | — |
| **2. Analyst** | Y (read-only queue view) | — | — | — | — | **Y** | — | — |
| **3. Author** | Y | Y | — | — | — | — | — | — |
| **4. Editor** | Y | Y | — | — | — | — | — | — |
| **5. Compliance Reviewer** | Y | Y | — | — | — | — | — | — |
| **6. Publisher** | Y | Y | — | — | — | — | — | — |
| **7. Resource Admin** | Y | Y | — | — | — | Y | — | Y (Resources-role assignment slice only) |
| **8. Super Admin** | Y | Y | Y | Y (Benchmarks today; FDH-governance portion once ADM-31+ ships) | Y *(once ADM-23 gets a UI / ADM-35 ships)* | Y | Y *(once ADM-26 gets a UI / later tasks ship)* | Y |

**Every area column that is expected to be non-empty for at least one caller is non-empty** — no area is dead weight in the canonical shell for every possible caller. Analyst's Data Governance/Operations/Security & Support cells stay `—` even in the future state: Analyst's only future expansion is `canViewFdhAnalytics` (CAP-26), which lands in Analytics, never in Data Governance/Operations/Security & Support directly (PO-2's own "no separate FDH/Analyst nav systems" rule, `A1_06` §3 rule 8, means Analyst's FDH visibility is additive *within* Analytics, not a new column of access into Data Governance itself). A role that would see literally nothing (row 1) correctly sees no Admin entry point at all, which is the intended, honest behaviour — not a flagged defect.

## 3. Persona walk-through (validation, restated compactly — full detail in `A1_21` §Validation)

For each of the 8 roles + role-less, per the brief's own requirement: landing destination, escalation path, manual access.

| Persona | Landing destination | Escalation path if they need more | Manual access |
|---|---|---|---|
| Role-less authenticated user | `/dashboard` (ordinary app), no Admin entry point | Request a role from a Super Admin (out-of-band; no self-service request flow exists — flagged in `A1_19`) | None — no Admin manual is reachable without a role |
| Analyst | Future Admin Home → Analytics | Request an additional operational role from Super Admin | `A1_01`/Wave 5 manuals for ADM-19/37/46 (once they exist); today, ADM-19's own "not operational" note |
| Author | Admin Home → Content (drafts they own) | Request Editor/Publisher from Resource Admin/Super Admin for broader workflow authority | ADM-08/11/12/13 manuals |
| Editor | Admin Home → Content (review queue + FAQ/Discovery) | Request Compliance Reviewer/Publisher for terminal authority | ADM-08/09/14/15/16/17 manuals |
| Compliance Reviewer | Admin Home → Content (compliance queue) | Request Publisher for terminal publish authority | ADM-09 manual |
| Publisher | Admin Home → Content (publish queue) | Request Resource Admin for role-management/discovery authority | ADM-09 manual |
| Resource Admin | Admin Home → Content + Analytics + Administration (Resources roles) | Request Super Admin for Data Governance/Recommendations/Operations/Security & Support | ADM-07 through 18, 21 manuals |
| Super Admin | Admin Home → everything | N/A — top of the model; no escalation exists above Super Admin within Admin itself | All manuals |

**No area renders empty for any of these 9 rows** — confirmed by the table in §2, updated to the PO-2 8-area structure.
