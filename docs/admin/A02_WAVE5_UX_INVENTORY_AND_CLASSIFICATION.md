# Admin A0.2 Wave 5 — Current UX Inventory, Classification and Consistency Registers

**Branch:** `feature/admin-a02-wave5`
**Worktree:** `D:/FHIP/.claude/worktrees/agent-a0422d78c71c7a2d1` (isolated; no other worktree was written to)
**Base:** `origin/main` @ `0e2103904b989e16021ba5f8e74b5dfbb0e49d0a`
**Date:** 2026-09-02 / 2026-09-03

This document carries Wave 5 deliverables 4–12 and 13–14. The verdict, execution evidence and residual registers are in `A02_WAVE5_CERTIFICATION_REPORT.md`. The manuals and the task index are in `A02_WAVE5_ADMIN_TASK_MANUALS.md`.

---

## 1. Current Admin surface counts (§4 — recalculated, not carried forward)

Wave 5's §4 explicitly forbids assuming Wave 3's 36-page / 73-route / 105-handler figures still hold. All four were recounted from the tree at the base SHA.

```
find "app/(app)/admin" -name "page.tsx" | wc -l                     -> 36
find app/api/admin -name "route.ts" | wc -l                          -> 74
grep -c "^export async function (GET|POST|PUT|PATCH|DELETE)" over
  app/api/admin/**/route.ts                                          -> 67 across 44 files
```

| Measure | Wave 4's figure | Wave 5's figure | Reconciliation |
|---|---:|---:|---|
| Admin pages | 34 (Wave 3) | **36** | +2 since Wave 3. Wave 4 did not recount pages. |
| Admin API route files | 73 | **74** | +1: `ai/standard-questions` (Module 11.4, merged before this Wave). |
| Admin API method handlers | 105 | **105** | Unchanged. Wave 5's own `^export async function` grep returns 67 across 44 files because 30 route files export their handlers through the `adminRoute(...)` wrapper (`export const GET = adminRoute(...)`), which that anchored pattern does not match. Wave 4's own reconciled figure — which counts both forms — remains authoritative at **105**, and Wave 5 did not add, remove or re-gate a single handler, so it is unchanged. This discrepancy is recorded rather than papered over: a naive re-grep of this codebase will not reproduce 105, and a future Wave needs to know why. |
| Visible Admin nav items | 19 | **19** | Unchanged. |
| Visible task count | 20 (Wave 3 index) | **21** | ADM-21 (work a content queue) newly identified as a task in its own right; see the manuals. |

**Migration state.** `origin/main` carries migrations through `0126`. Wave 5 required no migration and created none — every change is application, presentation or documentation. The one change that touches data flow (`is_featured` now being written by the content editors) uses a column that already exists and that is already inside migration `0049`'s column-scoped `authenticated` UPDATE grant on `resource_posts`; no grant, policy, function or schema change was needed. Per §25, no migration number was allocated, speculatively or otherwise.

---

## 2. Page-by-page UX inventory (§6)

All 36 visible pages. "Wave 5 disposition" states what this Wave actually did to the page.

### 2.1 Benchmarks and Recommendations (Super Admin only)

| # | Page | Primary task | Purpose stated? | Loading | Empty | Unavailable | Error | Success | Wave 5 disposition |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `/admin/benchmarks` | ADM-01/02/03 | Was: yes, but cited "spec sections 20 and 26" to operators, and no per-tab purpose | Was: bare "Loading…", unannounced | Was: "No rows yet." on every tab, wrong `colSpan` on 4 of 6 | Was: none | Was: raw server string; 403 indistinguishable from 500 | Was: **none** for 5 of 6 actions; Validate result was a `window.alert` | **Rebuilt feedback layer.** Purpose rewritten without internal references; per-tab purpose added; confirmation on all five lifecycle actions; native `alert`/`confirm` replaced with the app's own dialog; classified failures; success announcements; `th scope`, caption, correct `colSpan`, row counts, humanised statuses and column headings; Help. |
| 2 | `/admin/recommendations` | ADM-04/05/06 | Was: no page-level purpose | Was: "Loading..." (inconsistent ellipsis), unannounced | Was: **none** — a filtered-to-zero library rendered a blank panel | Was: none | Was: bare red line, no `role`, raw server strings, raw JSON as a success message | Was: `'Saved.'` was set and then wiped by `resetForm()` in the same tick, so it **never appeared** | Purpose added; confirmation on Deactivate/Activate; the success confirmation fixed so it actually renders; empty state added; upload success message made human; per-row accessible names; `role="alert"` on errors; privacy caution on Gap review; Help. |

### 2.2 Resources shell, dashboard, queues and users

| # | Page | Primary task | Wave 5 disposition |
|---|---|---|---|
| 3 | `/admin/resources` | ADM-07 | Result-state classification; the Analyst case turned into an explicit `unavailable` state instead of an unlabelled white card; the New Content button now shown only to callers who can create; unguarded `res.json()` fixed; Help. |
| 4 | `/admin/resources/content` | ADM-08 list | Result-state classification; announced result count; visible active-filter summary; honest empty-state wording; disclosed category-filter unavailability; Help. |
| 5–10 | `/admin/resources/content/{drafts,review,scheduled,published,review-due,archived}` | ADM-21 | Same shared component as #4 — every change above applies to all six. Each already had an accurate title and purpose sentence. |
| 11 | `/admin/resources/content/new` | ADM-08 create | Unchanged apart from the shared confirm-dialog focus fixes. Permission-denied copy already names who may create. |
| 12 | `/admin/resources/content/[id]` | ADM-08 view | Unchanged; reachable from the list, links to Edit and Preview. |
| 13 | `/admin/resources/content/[id]/edit` | ADM-08 | Save label unified to **Save Changes**; the Featured checkbox now actually saves; header cluster wraps; Help; workflow-panel changes (see #14). |
| 14 | *(the Workflow panel, rendered inside 13/24/28/33)* | ADM-09 | Confirmation on Publish Now and both approvals; the two Send Back to Draft actions given distinguishable labels; success announcement; the unsaved-changes blocker announced; Cancel disabled while busy; reason box given contextual guidance. |
| 15 | `/admin/resources/content/[id]/preview` | ADM-08 | Unchanged. |
| 16 | `/admin/resources/users` | ADM-18 | Success announcements; safe error reporting (raw Postgres strings removed at source); mobile card layout; announced result count; `caption`, `th scope="row"`; per-row accessible name on Assign; 44px remove target; Help. |
| 17 | `/admin/resources/analytics` | ADM-19 | **Deliberately unchanged.** Already the most honest unavailable state in Admin. |

### 2.3 Specialist content types

| # | Page | Primary task | Wave 5 disposition |
|---|---|---|---|
| 18 | `/admin/resources/videos` | ADM-11 list | Result-state classification; announced count; router navigation instead of full page reload; 44px targets; Help. |
| 19 | `/admin/resources/videos/new` | ADM-11 create | Unchanged — already the best-labelled single-field form in Admin. |
| 20 | `/admin/resources/videos/[id]/edit` | ADM-11 | Save label unified; Featured now saves; header wraps; Help. |
| 21 | `/admin/resources/videos/[id]/preview` | ADM-11 | Unchanged. |
| 22 | `/admin/resources/glossary` | ADM-12 list | As #18. |
| 23 | `/admin/resources/glossary/new` | ADM-12 create | Unchanged. |
| 24 | `/admin/resources/glossary/[id]/edit` | ADM-12 | As #20. |
| 25 | `/admin/resources/glossary/[id]/preview` | ADM-12 | Unchanged. |
| 26 | `/admin/resources/money-updates` | ADM-13 list | As #18, plus a **Template** badge so the list's own type filter is meaningful at row level (required a two-line query/type change to return the column that was already being filtered on). |
| 27 | `/admin/resources/money-updates/new` | ADM-13 create | Unchanged. |
| 28 | `/admin/resources/money-updates/[id]/edit` | ADM-13 | As #20. |
| 29 | `/admin/resources/money-updates/[id]/preview` | ADM-13 | Unchanged. |
| 30 | `/admin/resources/faqs` | ADM-14 list | As #18. Already had the best empty state and the only real pagination in Admin. |
| 31 | `/admin/resources/faqs/new` | ADM-14 create | Shares #32's editor. |
| 32 | `/admin/resources/faqs/[id]/edit` | ADM-14 | Unlink confirmed and its outcome checked; the "Saved" indicator now clears when you edit again; delete confirmation names the FAQ and states irreversibility; content types humanised; 409 with no body no longer renders an empty red box; Help. |

### 2.4 Discovery

| # | Page | Primary task | Wave 5 disposition |
|---|---|---|---|
| 33 | `/admin/resources/related` | ADM-16 | Remove confirmed and its outcome checked (it previously ignored the response entirely); add confirmed; picker given searching/empty/failed states; internal spec reference removed from the purpose sentence; Help. The Wave 2 reorder lifecycle was found correct and left byte-identical. |
| 34 | `/admin/resources/context` | ADM-17 | The largest single repair in this Wave — all four mutations previously ignored their responses. Now: confirmation on remove/activate/deactivate; outcome checked and reported on all four; reorder reconciled against the server on both success and failure; explicit Active/Inactive badge; accessible names on every row action; 44px targets; focus-visible styling; picker states; Help. |
| 35 | `/admin/resources/ctas` | ADM-15 list | Deactivate/Activate confirmed; success announcements; filter-aware empty state; mobile card layout; per-row accessible names; announced count; Help. |
| 36 | `/admin/resources/ctas/new` and `/ctas/[id]/edit` | ADM-15 form | Field errors wired to their inputs (`aria-invalid`, `aria-describedby`); required fields marked as required; error summary with a count; focus moved to the summary on failure; Cancel confirms when there is unsaved work and is disabled while saving; safe error reporting. |

---

## 3. UX classification register (§7)

Every finding, its evidence, severity and disposition. **Fixed** means fixed in this Wave. **Deferred** means recorded for a later phase with a reason.

| # | Classification | Surface | Evidence | Severity | Disposition |
|---|---|---|---|---|---|
| UX-01 | `SUCCESS_STATE_UNCONFIRMED` | Recommendations save/create | `setSaveStatus('Saved.')` immediately followed by `resetForm()`, which sets `saveStatus` to `null` — the message could never render | High | **Fixed** |
| UX-02 | `SUCCESS_STATE_UNCONFIRMED` | Users & Roles assign/remove | Both handlers ended in a silent refetch; no toast, no inline message, no live region | High | **Fixed** |
| UX-03 | `SUCCESS_STATE_UNCONFIRMED` | Benchmarks activate/retire/approve/suspend/reinstate | All five ended in `await load(tab)` with no message | High | **Fixed** |
| UX-04 | `SUCCESS_STATE_UNCONFIRMED` | Workflow transitions (all 4 content types) | No message on any transition, including Publish | High | **Fixed** |
| UX-05 | `SUCCESS_STATE_UNCONFIRMED` | CTA activate/deactivate, Related add/remove, Context all four | Silent refetch | Medium | **Fixed** |
| UX-06 | `MISLEADING_SUCCESS` | All 4 content editors — Featured checkbox | `is_featured` absent from `EditorSavePatch` and from the update statement; toggling it marked the form dirty and reported **Saved**, and the value was discarded. The column is live: the public Resources landing page filters "Start here" cards on it | High | **Fixed** |
| UX-07 | `MISLEADING_SUCCESS` | Context Mapping remove / activate / deactivate / reorder | `await fetch(...)` with the response never inspected; a 403 or 500 was completely silent | High | **Fixed** |
| UX-08 | `MISLEADING_SUCCESS` | Related Content remove | `if (res.ok) await load(...)` with no `else`; a failed delete produced no message at all | High | **Fixed** |
| UX-09 | `MISLEADING_SUCCESS` | FAQ unlink | Response never inspected; the row was removed from the screen regardless | Medium | **Fixed** |
| UX-10 | `MISLEADING_SUCCESS` | FAQ editor "Saved" indicator | `saved` was never reset, so it stayed on screen while further unsaved edits were made | Medium | **Fixed** |
| UX-11 | `DESTRUCTIVE_CONFIRMATION_MISSING` | **Publish Now** | One click made content publicly visible immediately, on the same panel where the fully reversible Send Back to Draft required a reason step — the risk gradient was inverted | High | **Fixed** |
| UX-12 | `DESTRUCTIVE_CONFIRMATION_MISSING` | Benchmarks Activate, Approve, Reinstate | Unconfirmed, while the reversible Retire and Suspend were confirmed | High | **Fixed** |
| UX-13 | `DESTRUCTIVE_CONFIRMATION_MISSING` | Recommendation Deactivate/Activate | Unconfirmed, no busy guard; rapid clicks raced concurrent writes | High | **Fixed** |
| UX-14 | `DESTRUCTIVE_CONFIRMATION_MISSING` | Related remove, Context remove/deactivate, CTA deactivate, FAQ unlink | Unconfirmed | Medium | **Fixed** |
| UX-15 | `ERROR_STATE_UNSAFE` | Users & Roles | `lib/resources/admin/userRoles.ts` returned Postgres `error.message` verbatim on six paths, forwarded as a 422 and rendered in a `role="alert"` — could show real table and constraint names | High | **Fixed at source** |
| UX-16 | `ERROR_STATE_UNSAFE` | Content workflow | `lib/resources/workflow.ts` forwarded the raw message for *every* database error, not only the RPC's own authored rule messages, and classified all of them as 403 | High | **Fixed at source**, preserving the authored-message pass-through by SQLSTATE |
| UX-17 | `ERROR_STATE_UNSAFE` | `/admin/resources` error boundary | Rendered `error.message`; never showed `error.digest`, the one value an operator could usefully report | Medium | **Fixed** |
| UX-18 | `ERROR_STATE_UNSAFE` | Dashboard and content list | Unguarded `await res.json()` surfaced raw `SyntaxError`/`Failed to fetch` text | Medium | **Fixed** |
| UX-19 | `ERROR_STATE_UNSAFE` | Benchmarks, Recommendations, Related, Context, CTA form/list, FAQ list/editor, SourcePicker | Server `json.error` forwarded verbatim to the screen on at least one path each | Medium | **Fixed** for every Admin screen this Wave touched, via a shared safety filter that refuses to display engine-shaped strings |
| UX-20 | `ERROR_STATE_UNSAFE` | FAQ delete 409 | `setError(json.error)` with no fallback — an omitted body rendered an empty red box | Low | **Fixed** |
| UX-21 | `UNAVAILABLE_STATE_MISSING` | Every Admin list screen | A 403 rendered in the red "we couldn't load … Try again" panel with a Retry button that could never succeed | High | **Fixed** — non-retryable outcomes render a neutral state with no Retry |
| UX-22 | `UNAVAILABLE_STATE_MISSING` | Resources dashboard, Analyst case | An unlabelled white card, visually identical to a content card | Medium | **Fixed** |
| UX-23 | `EMPTY_STATE_MISLEADING` | CTA list | A search returning nothing said "No CTAs have been created yet. / Create your first CTA." | Medium | **Fixed** |
| UX-24 | `EMPTY_STATE_MISLEADING` | Recommendations library | No empty state at all — a filtered-to-zero library rendered a blank panel | Medium | **Fixed** |
| UX-25 | `EMPTY_STATE_MISLEADING` | Content list | "No Resources content yet." was shown for a permission-scoped zero result too | Low | **Fixed** — wording now allows for both |
| UX-26 | `EMPTY_STATE_MISLEADING` | All four resource pickers | No zero-results state; a failed search silently left stale results on screen | Medium | **Fixed** for the Related and Context pickers |
| UX-27 | `STATUS_ANNOUNCEMENT_MISSING` | Every list screen | No `aria-live` anywhere — filtering, paging and result counts were silent | High | **Fixed** |
| UX-28 | `STATUS_ANNOUNCEMENT_MISSING` | Benchmarks | The entire screen had zero `aria-live`, `role="status"` or `role="alert"` | High | **Fixed** |
| UX-29 | `FOCUS_DEFECT` | Shared confirm dialog | `aria-modal="true"` declared but Tab escaped to the page behind; focus never restored to the trigger; element ids hardcoded, and two dialogs are mounted at once in every content editor | High | **Fixed** — focus trap, focus restore, per-instance ids, and Cancel focused by default rather than the destructive action |
| UX-30 | `FOCUS_DEFECT` | Pagination | Pressing Next onto the last page disabled the focused button, dropping focus to `<body>` | Medium | **Fixed** |
| UX-31 | `FOCUS_DEFECT` | Add Block menu | `aria-expanded`/`aria-controls` declared, but Escape did nothing | Medium | **Fixed** |
| UX-32 | `ACCESSIBLE_NAME_DEFECT` | Recommendations, Context Mapping, CTA list, FAQ unlink | Row actions named only "Edit" / "Deactivate" / "Remove" / "Unlink", identical on every row | High | **Fixed** |
| UX-33 | `ACCESSIBLE_NAME_DEFECT` | Users & Roles Assign | Named "Assign" on every row | Medium | **Fixed** |
| UX-34 | `ACCESSIBLE_NAME_DEFECT` | Metadata sidebar chevron | A decorative "›" announced before every section heading | Low | **Fixed** |
| UX-35 | `INCONSISTENT_HEADER` | Dashboard, Users & Roles, 5 list screens, route error boundary | One hardcoded error headline — "We couldn't load Resources content. Try again." — used on screens that are not content lists, including the Users and Analytics routes | Medium | **Fixed** |
| UX-36 | `VALIDATION_INCONSISTENT` | CTA form | Field errors rendered but never associated with their inputs; no required marking; no summary; focus left at the bottom of the form while the error appeared at the top | High | **Fixed** |
| UX-37 | `RESPONSIVE_DEFECT` | Users & Roles, CTA list | No layout below `sm`; a 320px viewport had to scroll a row containing a select and a button | Medium | **Fixed** — card layouts added |
| UX-38 | `RESPONSIVE_DEFECT` | All 4 editor headers | The status/Preview/Save cluster could not wrap; at ~360px the error state overflowed | Medium | **Fixed** |
| UX-39 | `TABLE_OVERFLOW_DEFECT` | Benchmarks | No `th scope`, no accessible table name, and the empty row's `colSpan` was one too many on the four tabs with no Actions column | Medium | **Fixed** |
| UX-40 | `UNCLEAR_PURPOSE` | Benchmarks tabs, Recommendations page | Six semantically different Benchmarks tables shared one page-level sentence; Recommendations had no page-level purpose at all | Medium | **Fixed** |
| UX-41 | `MANUAL_MISSING` | 15 of 20 tasks | Wave 3 wrote full manuals for ADM-01/02/03 and ADM-19/20 only, explicitly deferring the rest to this Wave | High | **Fixed** — all 21 tasks now carry the full 24-field structure |
| UX-42 | `MANUAL_INACCURATE` | Revision History panel | Its empty state named a "Save Draft" button that three of the four editors rendering it did not have; its footer told operators to read an internal engineering report | Medium | **Fixed** |
| UX-43 | `MANUAL_INACCURATE` | Benchmarks, Related Content purpose sentences | Cited "spec sections 20 and 26" and "spec §29-30" to operators | Low | **Fixed** |
| UX-44 | `NEXT_STEP_MISSING` | Every page | No page told the operator what to do next | Medium | **Fixed** — every Help entry ends with a recommended next step |
| UX-45 | `FUTURE_CAPABILITY_HONESTLY_UNAVAILABLE` | Scheduling (ADM-10) | No Schedule control anywhere; no worker; the Scheduled queue and status exist but nothing acts on them | — | **Preserved and documented**; deferred to A3.1 |
| UX-46 | `FUTURE_CAPABILITY_HONESTLY_UNAVAILABLE` | Analytics (ADM-19) | Route renders no figure of any kind and makes no data request | — | **Preserved unchanged**; the best existing example of an honest unavailable state |
| UX-47 | `FUTURE_CAPABILITY_HONESTLY_UNAVAILABLE` | AI Admin (20 routes, 0 pages) | No page exists under any `ai` admin route | — | **Deferred to Module 11** (§21) |
| UX-48 | `UNCLEAR_PRIMARY_ACTION` | Resources dashboard | "+ New Content" was shown to every Resources role, including those the create API rejects | Medium | **Fixed** |
| UX-49 | `TABLE_OVERFLOW_DEFECT` | Money Updates list | The list mixes Updates and Templates and filters between them, but no row said which it was | Low | **Fixed** |
| UX-50 | `KEYBOARD_ACCESS_DEFECT` | Context Mapping, chapter and alias editors | Touch targets around 24px, below the 44px used by sibling screens; no focus-visible styling on Context Mapping | Medium | **Fixed for Context Mapping**; chapter and alias editors **deferred** (see the certification report's deferred register) |
| UX-51 | `ERROR_STATE_UNSAFE` | Recommendations CSV upload | Reported success as `Success: ${JSON.stringify(json.data)}` — a raw data structure as the operator's confirmation | Medium | **Fixed** |
| UX-52 | `EMPTY_STATE_MISLEADING` | Content list category filter | A failed categories fetch was swallowed, and the filter is rendered only when non-empty — so the whole control silently vanished with no explanation | Low | **Fixed** |
| UX-53 | `RESPONSIVE_DEFECT` | 7 Admin tables (content queues, videos, glossary, money updates, FAQs, CTAs, users) and Benchmarks | **Found only by running the browser suite, not by reading code.** Tailwind's `sr-only` is `position:absolute`; the visually-hidden "Actions" heading and the table `<caption>` inside each horizontally-scrolling table resolved their containing block against the **document**, laying out ~220px beyond the viewport. `clip` does not remove an element from the scrollable overflow region, so this produced a genuine **page-level** horizontal scrollbar — while the table itself was scrolling correctly inside its own container, which is why no amount of code reading found it. Reproduced at 8 page/width combinations | High | **Fixed** — each scroll container is now a positioning context |
| UX-54 | `RESPONSIVE_DEFECT` | Mobile card lists (content, money updates, and by inspection videos, glossary, FAQs) | Operator-entered titles routinely contain long unbroken tokens (import identifiers, slugs, test markers). With no explicit break these cannot wrap, so a single title forced the whole page into horizontal scroll at 320px — the one width where the card layout, not the scrollable table, is what renders | Medium | **Fixed** — `break-words` on every card title, applied to all five lists rather than only the two DEV data happened to expose |
| UX-55 | `SUCCESS_STATE_UNCONFIRMED` / data loss | All 4 content editors | `doSave` began `if (savingRef.current) return;` — a save requested while another was in flight was **silently discarded**, with no retry and no signal; the debounced autosave and a manual save race routinely. On success it then unconditionally cleared the dirty state and showed **Saved**, even if the operator had gone on typing during the request. Together: the editor could sit reading "Saved" while holding genuinely unsaved work, and lose it at the navigation guard | High | **Fixed** — concurrent saves are queued and drained; the clean state is claimed only when a monotonic edit counter proves nothing changed mid-flight |

**`UI_WITHOUT_BACKEND`: none found.** Every control located during this inventory reaches a route that exists and returns a real result.

**Three of the 55 findings (UX-53, UX-54, UX-55) were found by running the application, not by reading it.** UX-53 in particular is invisible to code review — every table's scroll container was correctly written, and the overflow came from a visually-hidden element escaping it. This is the concrete argument for §14's insistence that a manual cannot pass on source inspection alone, and it applies to the UX inventory too.

---

## 4. Page-structure consistency matrix (§8.1)

| Element | Before Wave 5 | After Wave 5 |
|---|---|---|
| Accurate page title | 36/36 | 36/36 |
| Purpose statement | 30/36 (Recommendations and the Benchmarks tabs were the gaps) | 36/36 |
| Current status/context | Partial | Row counts and active-filter summaries on every list |
| Primary action clear | 34/36 (dashboard's New Content shown to roles that cannot use it) | 36/36 |
| Status feedback after a change | 3 of 14 mutating surfaces | 14 of 14 |
| Recovery guidance | Generic on most screens | Specific per result state |
| Help / manual link | **0/36** | 36/36 — 21 task pages carry the disclosure directly; the preview and view-only pages inherit their parent task's entry |
| Logical next step | 0/36 stated | Stated in every Help entry |

The future global Admin shell and the primary navigation were **not** touched (§8.1's own boundary).

---

## 5. Loading / empty / unavailable / error state matrix (§9)

| Screen | `loading` | `empty` | `unavailable` | `forbidden` | `not_found` | `validation_error` | `conflict` | `saving` | `success` | `error` |
|---|---|---|---|---|---|---|---|---|---|---|
| Benchmarks (6 tabs) | ✅ announced | ✅ per-tab wording | ✅ | ✅ no Retry | ✅ | ✅ | ✅ | ✅ per row | ✅ | ✅ with Retry |
| Recommendations | ✅ announced | ✅ added | ✅ | ✅ | ✅ | ✅ per row | ✅ | ✅ | ✅ fixed | ✅ |
| Resources dashboard | ✅ | N/A | ✅ Analyst case | ✅ | ✅ | N/A | N/A | N/A | N/A | ✅ |
| Content list ×7 | ✅ | ✅ filter-aware | ✅ | ✅ | ✅ | N/A | N/A | N/A | N/A | ✅ |
| Content / video / glossary / money-update editors | ✅ | N/A | ✅ | ✅ | ✅ | ✅ per field | ✅ dialog | ✅ | ✅ | ✅ |
| Workflow panel | N/A | ✅ "no actions available" | ✅ RED/AMBER notices | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ added | ✅ |
| FAQ list / editor | ✅ | ✅ filter-aware | ✅ | ✅ | ✅ | ✅ | ✅ dialog | ✅ | ✅ | ✅ |
| CTA list / form | ✅ | ✅ filter-aware | ✅ | ✅ | ✅ | ✅ with summary | ⚠️ none | ✅ | ✅ | ✅ |
| Related Content | ✅ | ✅ | ✅ | ✅ | ✅ | N/A | ✅ explicit | ✅ | ✅ | ✅ |
| Context Mapping | ✅ | ✅ | ✅ | ✅ | ✅ | N/A | ✅ reconciled | ✅ | ✅ | ✅ |
| Users & Roles | ✅ | ✅ search-aware | ✅ | ✅ | ✅ | ✅ | N/A | ✅ | ✅ | ✅ |
| Analytics | N/A | N/A | ✅ | ✅ (redirect) | N/A | N/A | N/A | N/A | N/A | N/A |

`suppressed` does not apply anywhere: no Admin surface currently displays privacy-suppressed aggregates, because no Admin analytics exist. The one place raw personal data appears is Recommendations Gap review, which shows it in full to a Super Admin rather than suppressing it — recorded as a Product Owner decision item, not silently reclassified.

⚠️ **CTA form has no conflict handling.** Two administrators editing the same CTA will have the later save win silently. Every content editor has an explicit conflict dialog; the CTA form does not. Recorded as a deferred finding rather than fixed, because adding optimistic concurrency to that form needs a server-side `expectedUpdatedAt` contract it does not have — a data-contract change, not a UX change.

---

## 6. Form consistency findings (§8.6)

| Requirement | State |
|---|---|
| Visible labels | Met on every content editor field (shared `FormField`), the FAQ editor, the CTA form and the video-add form. **Not met** on the Recommendations form, where roughly 20 inputs use `placeholder` as their only label. Filter and search controls there were given `aria-label`s this Wave; the main form's fields were **not** relabelled — that is a form redesign, and is recorded as deferred. |
| Required-field indication | Met on the CTA form (new this Wave) and on content editors visually. `aria-required` is **not** set by the shared `FormField` primitive — its asterisk is `aria-hidden`, so a screen-reader user gets no required signal. Deferred: changing the shared primitive affects every form in the app, beyond this Wave's scope. |
| Format guidance | Met where present, but dates are plain text inputs with placeholder-only format hints. Deferred. |
| Inline field errors | Met everywhere. |
| Summary when several fields fail | Met on the CTA form (new). **Not met** in the content editors — deferred; the `validation.ts` comment shows a summary was the original design intent. |
| Valid input preserved after failure | Met everywhere — verified by reading every failure path. |
| Clear Save/Cancel | Save met and now consistently labelled. **Cancel does not exist in any content editor** — the only way out is to navigate away and answer the unsaved-changes guard. Deferred. |
| Unsaved-change warning | Met in the content editors (three-vector guard) and now on the CTA form. |
| Safe handling of server-controlled fields | Met — status and approval columns are absent from the editor patch type by construction, not merely unsent. |
| No mass assignment | Met. |

---

## 7. Table and list consistency findings (§8.7)

| Table | `<table>` + `th scope` | Caption | Overflow container | Mobile fallback | Row-action accessible name | Pagination metadata | Announced count |
|---|---|---|---|---|---|---|---|
| Content list | ✅ | ⚠️ none | ✅ | ✅ | ✅ | ✅ | ✅ new |
| Videos | ✅ | ⚠️ none | ✅ | ✅ | ✅ | — | ✅ new |
| Glossary | ✅ | ⚠️ none | ✅ | ✅ | ✅ | — | ✅ new |
| Money Updates | ✅ | ⚠️ none | ✅ | ✅ | ✅ | — | ✅ new |
| FAQs | ✅ | ⚠️ none | ✅ | ✅ | ✅ | ✅ | ✅ new |
| CTAs | ✅ | ✅ new | ✅ | ✅ new | ✅ new | — | ✅ new |
| Users & Roles | ✅ + `th scope="row"` new | ✅ new | ✅ | ✅ new | ✅ new | — | ✅ new |
| Benchmarks ×6 | ✅ new | ✅ new | ✅ | — (scrolls in its own container, which §12 permits) | ✅ | — | ✅ new |

⚠️ The five older content tables still have no `<caption>`. Their column headers are meaningful and each is preceded by an `h1` and a purpose sentence, so they are usable; adding captions to all five is a small, safe follow-up recorded as deferred rather than fitted in unverified.

No table anywhere in Admin causes **page-level** horizontal overflow: every wide table sits inside its own `overflow-x-auto` container, which §12 explicitly permits.

---

## 8. Destructive-action and reversal matrix (§10)

| Action | Confirmed | Confirmation names object + effect | Reversible by | Reversal creates a new audited action |
|---|---|---|---|---|
| Publish content | ✅ new | ✅ | Archive | ✅ |
| Approve editorially / for compliance | ✅ new | ✅ | Send Back to Draft | ✅ |
| Send Back to Draft | ✅ (reason step) | ✅ | Re-submit | ✅ |
| Archive content | ✅ (reason step) | ✅ new wording | Move forward again | ✅ |
| Activate benchmark dataset | ✅ new | ✅ | Retire | ✅ |
| Retire benchmark dataset | ✅ | ✅ | Activate (re-validates) | ✅ |
| Approve benchmark source | ✅ new | ✅ (states it cannot be undone to draft) | — irreversible, stated | ✅ |
| Suspend benchmark source | ✅ | ✅ | Reinstate | ✅ |
| Reinstate benchmark source | ✅ new | ✅ | Suspend | ✅ |
| Deactivate recommendation | ✅ new | ✅ | Activate | ❌ not audited — disclosed residual |
| Bulk CSV import | ❌ (fires on file selection) | — | Re-upload corrected file | ✅ for conditions only |
| Deactivate CTA | ✅ new | ✅ | Activate | ❌ not audited — disclosed residual |
| Remove related content | ✅ new | ✅ | Add again | ❌ not audited — disclosed residual |
| Remove / deactivate context mapping | ✅ new | ✅ | Add again / Activate | ❌ not audited — disclosed residual |
| Unlink FAQ from content | ✅ new | ✅ | Link again | ❌ not audited — disclosed residual |
| **Delete FAQ** | ✅ | ✅ new — names the FAQ, its link count, and that it cannot be undone | **irreversible** | ❌ not audited — disclosed residual |
| Remove Resources role | ✅ | ✅ (with a distinct self-removal warning) | Assign again | ✅ audited |
| Delete a content block | ✅ when it has content | ✅ | none until saved | N/A (local) |

**The one remaining unconfirmed high-impact action is the CSV bulk import**, which begins the moment a file is chosen. It is left as-is deliberately: the operation is non-destructive by design (it updates matching codes, adds new ones, and leaves everything else untouched), it validates every row before writing anything, it reports precisely what changed, and the page says all of this above the control. Adding a confirmation step would be an improvement but is a workflow change rather than a safety fix. Recorded as deferred, not as done.

---

## 9. Status and terminology register (§18)

The approved register is maintained in `A02_WAVE5_ADMIN_TASK_MANUALS.md` so that operators and this Wave's successors read one list, not two. It covers 12 concepts and records two deferred renames (`General` nav group; `Add @GKTC Video`) that would require reopening a certified contract or a branding decision.

**Database values are never renamed for presentation.** Every mapping is display-only, and an unmapped value falls back to its raw text rather than being hidden, so a status added by a future migration shows up as visibly unmapped rather than silently mislabelled.
