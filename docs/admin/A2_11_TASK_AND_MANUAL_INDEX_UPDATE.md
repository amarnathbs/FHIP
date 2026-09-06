# A2 — Updated Admin Task and Manual Index

## 1. What changed, and what did not

A2 changes **navigation paths and page groupings only** — no task's steps, eligible roles, prerequisites, success evidence, reversal, or next-step changed. Per dispatch §16: "Update manuals only where navigation paths or page orientation genuinely changed." Concretely:

- `lib/admin/taskHelp.ts` (Wave 5's task-help registry, `A02_WAVE5_ADMIN_TASK_MANUALS.md`'s in-product counterpart) is **untouched** by this pass — every `ADM-xx` entry's content is identical to its pre-A2 wording.
- The one genuinely new navigation fact this pass adds is the **area a task now lives under** and its **breadcrumb path**, both captured in the new `lib/admin/navigationRegistry.ts` and `A2_03_NAVIGATION_REGISTRY_AND_ROUTE_MAP.md` — not a restatement of manual content, a mapping from task to its new place in the 8-area IA.

## 2. Task-to-area index (supersedes any older "General"/"Resources"/"Workflow"/"Discovery" grouping reference in prior docs)

| Task | New area | Route |
|---|---|---|
| ADM-01/02/03 | Data Governance | `/admin/benchmarks` |
| ADM-04/05 | Recommendations | `/admin/recommendations` |
| ADM-06 (withdrawn) | — (no nav entry; manual note only) | — |
| ADM-07 | Content | `/admin/resources` |
| ADM-08 | Content | `/admin/resources/content`, `/admin/resources/content/new` |
| ADM-09 | Content (rendered inside the content editor, no separate nav row) | `/admin/resources/content/[id]/edit` |
| ADM-10 (not operational) | — (no nav entry; manual note only) | `/admin/resources/content/scheduled` (reachable, honestly labelled not operational) |
| ADM-11 | Content | `/admin/resources/videos` |
| ADM-12 | Content | `/admin/resources/glossary` |
| ADM-13 | Content | `/admin/resources/money-updates` |
| ADM-14 | Content | `/admin/resources/faqs` |
| ADM-15 | Content | `/admin/resources/ctas` |
| ADM-16 | Content | `/admin/resources/related` |
| ADM-17 | Content | `/admin/resources/context` |
| ADM-18 | Administration | `/admin/resources/users` |
| ADM-19 (not operational) | — (no nav entry; direct URL only) | `/admin/resources/analytics` |
| ADM-21 | Content | `/admin/resources/content/{drafts,review,scheduled,published,review-due,archived}` |

## 3. In-product help still points at the right manual entry

`AdminTaskHelp` (`components/admin/AdminTaskHelp.tsx`) is unchanged and continues to render from `lib/admin/taskHelp.ts` on every page that already had it wired in — this pass verified (by direct code inspection, not assumption) the exact `taskId` each page's client component passes: `ADM-07` (Resources dashboard), `ADM-08`/`ADM-21` (content list, chosen dynamically by whether the list is a filtered queue), `ADM-09` (content editor workflow panel), `ADM-11` (videos), `ADM-12` (glossary), `ADM-13` (money updates), `ADM-14` (FAQs), `ADM-15` (CTAs), `ADM-16` (related content), `ADM-17` (context mapping), `ADM-18` (users & roles), and the tab-dependent `ADM-01`/`02`/`03` on Benchmarks. None of these wiring points needed to change, because none of their routes moved.

## 4. New: Admin Home has no single task manual

`/admin/home` is new in A2 and is oriented by its own on-page copy (queue cards naming what/by-when/consequence/destination, plus a "Need help with a task?" pointer to each individual page's own Help disclosure) rather than a single `ADM-xx` manual entry — consistent with dispatch §16's "do not duplicate the complete manual inside every page." This is recorded explicitly in the navigation registry (`taskManualId: null`, with an explanatory `taskManualNote`) rather than left as a silent gap.
