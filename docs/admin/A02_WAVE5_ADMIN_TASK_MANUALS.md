# Admin A0.2 Wave 5 — Central Admin Task Index and Operator Manuals

**Status:** Current-state operator manuals for every visible Admin task, standardised into one 24-field structure (Wave 5 §15) and validated against the running application on DEV (Wave 5 §14).
**Supersedes:** `docs/admin/A02_WAVE3_TASK_MANUALS.md` — Wave 3 created the initial index and wrote full manuals for three Benchmarks tasks only, explicitly deferring the other fifteen to "A0.2 Wave 5 … the phase explicitly named for standardising every manual into one consistent format". That deferral is closed here. Wave 3's file is retained unchanged as the historical record of what Wave 3 itself produced.
**Last validated:** 2026-09-03 (Admin A0.2 Wave 5).

---

## How to read a manual entry

Every entry below carries the same 24 fields, in the same order, per Wave 5 §15. Fields that genuinely do not apply say so explicitly rather than being omitted — an absent field would be indistinguishable from an oversight.

Manuals use the words the interface uses. Where this Wave changed a label, the manual uses the **new** label, because the manual describes the application as it now is. Route paths, RPC names and database column names do not appear in the procedures; they appear only in the "Audit evidence" field where an operator genuinely needs to know that a record exists, and even there they are described, not named.

---

## Central Admin task index

| ID | Task | Visible page | Capability | Availability | Manual | Last validated |
|---|---|---|---|---|---|---|
| ADM-01 | Approve, suspend or reinstate a benchmark source | `/admin/benchmarks` → Sources | Super Admin (`isAdmin`) | Operational | ✅ below | Wave 5 |
| ADM-02 | Validate, activate or retire a benchmark dataset | `/admin/benchmarks` → Datasets | Super Admin (`isAdmin`) | Operational | ✅ below | Wave 5 |
| ADM-03 | Review benchmark reference data and the audit log | `/admin/benchmarks` → 4 read-only tabs | Super Admin (`isAdmin`) | Operational (read-only) | ✅ below | Wave 5 |
| ADM-04 | Create, edit, activate or deactivate a recommendation | `/admin/recommendations` | Super Admin (`isAdmin`) | Operational | ✅ below | Wave 5 |
| ADM-05 | Bulk update recommendations from a CSV file | `/admin/recommendations` | Super Admin (`isAdmin`) | Operational | ✅ below | Wave 5 |
| ADM-06 | Review recommendation coverage gaps | `/admin/recommendations` | Super Admin (`isAdmin`) | Operational (read-only) | ✅ below | Wave 5 |
| ADM-07 | Use the Resources dashboard | `/admin/resources` | `resourcesDashboard` | Operational (read-only) | ✅ below | Wave 5 |
| ADM-08 | Create or edit an article, guide or FHIP explainer | `/admin/resources/content/**` | `resourceContentAdmin` + `canCreateResource` | Operational | ✅ below | Wave 5 |
| ADM-09 | Move content through the publishing workflow | Any content editor's Workflow panel | `resourceWorkflowAdmin` | Operational | ✅ below | Wave 5 |
| ADM-10 | Schedule content for future publication | — | — | **Not operational — deferred to A3.1** | ✅ availability note | Wave 5 |
| ADM-11 | Add or edit a video | `/admin/resources/videos/**` | `resourceContentAdmin` | Operational | ✅ below | Wave 5 |
| ADM-12 | Create or edit a glossary definition | `/admin/resources/glossary/**` | `resourceContentAdmin` | Operational | ✅ below | Wave 5 |
| ADM-13 | Create or edit a money update | `/admin/resources/money-updates/**` | `resourceContentAdmin` | Operational | ✅ below | Wave 5 |
| ADM-14 | Create, edit or delete an FAQ | `/admin/resources/faqs/**` | `canManageFaqs` | Operational | ✅ below | Wave 5 |
| ADM-15 | Create, edit, activate or deactivate a CTA | `/admin/resources/ctas/**` | `resourceDiscoveryAdmin` / `canManageDiscovery` | Operational | ✅ below | Wave 5 |
| ADM-16 | Curate related content | `/admin/resources/related` | `canManageDiscovery` | Operational | ✅ below | Wave 5 |
| ADM-17 | Map a resource to an in-product context | `/admin/resources/context` | `canManageDiscovery` | Operational | ✅ below | Wave 5 |
| ADM-18 | Assign or remove a Resources role | `/admin/resources/users` | `canManageResources` | Operational | ✅ below | Wave 5 |
| ADM-19 | View Resources analytics | `/admin/resources/analytics` (direct URL only) | `resourceAnalytics` | **Not operational — no analytics exist** | ✅ availability note | Wave 5 |
| ADM-20 | Admin capability resolution | — (no UI; underlies every page) | none by design | Operational | ✅ below | Wave 5 |
| ADM-21 | Work a content queue | 6 queue pages under `/admin/resources/content/**` | `resourceWorkflowAdmin` | Operational (read-only) | ✅ below | Wave 5 |

**Changes to the index since Wave 3:** ADM-21 is new — Wave 3 folded the six workflow queue pages into ADM-08/ADM-09, but they are six separately-navigable destinations with their own purpose, their own filters and their own empty states, so they are a task in their own right and Wave 5's §4 requires every visible page to be inventoried. No task was removed.

**Not in this index, and why:** the AI Admin surface (20 API routes) has no Admin page at all — writing an operating procedure for a task an administrator cannot reach would itself misrepresent it as operational. It remains deferred to Module 11's own roadmap (Wave 5 §21). Wave 3 reached the same conclusion; this Wave re-confirmed it by fresh inspection (there is still no page under any `ai`-named admin route).

---

## In-product Help

Every task in this index whose page is visible now carries an in-product **"How to use this page"** disclosure, rendered from `lib/admin/taskHelp.ts` and keyed by the same `ADM-nn` identifier used here. That registry contains the same purpose, eligible roles, prerequisites, steps, success evidence, reversal and next step as the corresponding manual entry, so the product and this document cannot drift apart silently.

Deliberately **not** built (Wave 5 §17's own boundary): no separate documentation site, no Help route, no search, and no link from the product to any repository path. See the certification report's Help section for the bounded-deferral record of the richer in-product Help that would need the A1 Admin shell.

---

## ADM-01 — Approve, suspend or reinstate a benchmark source

1. **Task ID.** ADM-01
2. **Task name.** Approve, suspend or reinstate a benchmark source
3. **Purpose.** Move a benchmark source through its governance lifecycle so that datasets citing it can pass activation checks.
4. **Business outcome.** Only figures traceable to an approved published source are ever served to a household as a benchmark.
5. **Eligible capability.** `isAdmin` — FHIP Super Admin membership.
6. **Eligible roles.** Super Admin only. No Resources role grants this, and Analyst never does.
7. **Prerequisites.** The source row exists. Create it first with the add-source form on the same tab.
8. **Navigation path.** Admin menu → General → Benchmarks → **Sources** tab.
9. **Step-by-step.**
   1. Open the **Sources** tab.
   2. Find the source and read its **Status** column. Statuses read as words — Draft, Under review, Approved, Active, Suspended — not as database values.
   3. Draft or Under review → select **Approve**, and confirm. The confirmation names the source and states that every dataset citing it becomes eligible for activation, and that there is no control to return it to draft afterwards.
   4. Approved or Active → select **Suspend**, and confirm. The confirmation states that dependent datasets will fail validation until it is reinstated.
   5. Suspended → select **Reinstate**, and confirm.
10. **Required fields.** None. The action changes only the source's status; the approving administrator's identity is taken from their own signed-in session, never from anything typed on the page.
11. **Validation rules.** The status must be one of the recognised lifecycle values. An unrecognised value is rejected outright rather than being silently accepted.
12. **Status meanings.** *Draft* — recorded, not yet reviewed. *Under review* — being assessed. *Approved* — usable as a citation. *Active* — approved and in use. *Suspended* — temporarily withdrawn; dependent datasets will not validate. *Superseded* / *Archived* — retained for history only.
13. **Success confirmation.** A confirmation message appears above the table naming the source and what changed, and the table reloads from the server so the Status column shows the committed value. Wave 5 added this message; before it, the only evidence was that a button label changed.
14. **Common errors.** *"You do not have access to this"* — the account is not a Super Admin. *"Not found"* — the source was deleted by someone else since the page loaded. *"That could not be accepted"* — the requested status is not valid. *"Temporarily unavailable"* — a transient service problem; nothing was changed.
15. **Recovery.** Reload the page to see the current state, then repeat the action. Repeating it is safe: re-approving an already-approved source changes nothing and records nothing.
16. **Conflict / stale state.** If someone else changed the source first, the table reloads on the next action and shows their state. There is no destructive overwrite: each action sets one specific status and the server checks the source still exists.
17. **Audit evidence.** Every genuine transition (a status that actually changes) writes an entry visible on the **Update / audit log** tab, recording the previous and new status and the administrator who made the change. Editing non-status details, or re-submitting the status a source already has, writes nothing — neither is a lifecycle event.
18. **Reversal or supersession.** Suspend is reversed by Reinstate. There is no control that returns an approved source to draft; approval is intended to move forward, with suspend/reinstate as the safety valve.
19. **Privacy and jurisdiction cautions.** None. This data is citation metadata about published sources. It contains no personal or household information.
20. **Related tasks.** ADM-02 (a dataset citing this source), ADM-03 (the audit log).
21. **Recommended next step.** Validate or activate a dataset that cites this source.
22. **Current availability.** Operational.
23. **Last validation date.** 2026-09-03, Wave 5, against DEV.
24. **Owning Admin phase.** Wave 3 connected the controls; Wave 4 made the transition atomic and audited; Wave 5 added confirmation, success confirmation and safe error reporting.

---

## ADM-02 — Validate, activate or retire a benchmark dataset

1. **Task ID.** ADM-02
2. **Task name.** Validate, activate or retire a benchmark dataset
3. **Purpose.** Move a dataset from draft figures into the live benchmark data the product serves, after checking it against the same rules activation enforces.
4. **Business outcome.** Every household comparison is made against a dataset an administrator has deliberately released.
5. **Eligible capability.** `isAdmin`.
6. **Eligible roles.** Super Admin only.
7. **Prerequisites.** The dataset's linked source is Approved or Active (ADM-01). Market and regulatory-class datasets have at least one recorded observed value.
8. **Navigation path.** Admin menu → General → Benchmarks → **Datasets** tab.
9. **Step-by-step.**
   1. Open the **Datasets** tab.
   2. Select **Validate** on the row. Nothing is changed — this reports whether activation would succeed and lists every failing rule in a panel on the page.
   3. Fix anything it lists (usually on the Sources tab or in the underlying values), then validate again.
   4. Select **Activate**, and confirm. The confirmation states that the dataset starts being served to every FHIP user immediately.
   5. To take an active dataset out of service, select **Retire** and confirm.
10. **Required fields.** None beyond the existing row.
11. **Validation rules.** The source must be linked and neither draft, suspended nor archived; the source citation and period must be present; the dataset's own period, geography level and statistic coverage must be present; market and regulatory-class datasets need at least one recorded value.
12. **Status meanings.** *Draft* — not served. *Active* — being served. *Superseded / Retired* — no longer served, kept for history.
13. **Success confirmation.** A confirmation message names the dataset and says whether it is now being served or has been retired, and points at the audit log. The table reloads from the server, so the Status column and the available action can only ever show committed state.
14. **Common errors.** A rejected activation reports each failing rule and changes nothing — and, importantly, the rejection is itself recorded in the audit log, so an unsuccessful attempt is not invisible. *"Not found"*, *"You do not have access to this"* and *"Temporarily unavailable"* behave as in ADM-01.
15. **Recovery.** Correct the underlying source, dataset or values, then Validate again before re-attempting Activate.
16. **Conflict / stale state.** Activation re-runs the full validation server-side at the moment it commits, so a source suspended by someone else between your Validate and your Activate causes the activation to be refused rather than to proceed on stale information.
17. **Audit evidence.** Every activation attempt — accepted or rejected — and every retirement writes an entry on the **Update / audit log** tab, including the validation result. **Validate itself writes nothing**, because it changes nothing.
18. **Reversal or supersession.** Retire reverses Activate. There is no un-retire control; reactivating means selecting Activate again, which re-validates from scratch.
19. **Privacy and jurisdiction cautions.** None. Aggregate reference data only.
20. **Related tasks.** ADM-01, ADM-03.
21. **Recommended next step.** Check the Update / audit log tab to confirm the change was recorded.
22. **Current availability.** Operational.
23. **Last validation date.** 2026-09-03, Wave 5, against DEV.
24. **Owning Admin phase.** Pre-existing; Validate added Wave 3; confirmation, success confirmation and inline validation results added Wave 5.

---

## ADM-03 — Review benchmark reference data and the audit log

1. **Task ID.** ADM-03
2. **Task name.** Review benchmark reference data and the audit log
3. **Purpose.** Inspect the cohorts, observed values, planning target ranges and change history that the benchmark lifecycle acts on.
4. **Business outcome.** An administrator can see why a dataset did or did not pass, and who changed what.
5. **Eligible capability.** `isAdmin`.
6. **Eligible roles.** Super Admin only.
7. **Prerequisites.** None.
8. **Navigation path.** Admin menu → General → Benchmarks → **Cohorts** / **Observed values** / **Planning target ranges** / **Update / audit log**.
9. **Step-by-step.** Select the tab. The table loads automatically. Each tab now states its own purpose above the table, and reports how many rows are shown.
10. **Required fields.** Not applicable — nothing is entered.
11. **Validation rules.** Not applicable — nothing is submitted.
12. **Status meanings.** On the audit log, the Approval column reads as Approved, Rejected or Pending rather than as a database value.
13. **Success confirmation.** Not applicable — nothing is changed by viewing these tabs.
14. **Common errors.** *"You do not have access to this"* if the session no longer carries Super Admin. *"Temporarily unavailable"* for a transient problem, with a Retry control. A permission denial deliberately offers **no** Retry, because retrying it cannot help.
15. **Recovery.** Sign in again, or use Retry for a transient failure.
16. **Conflict / stale state.** Not applicable — read-only.
17. **Audit evidence.** None is written. The Update / audit log tab *is* the audit-reading surface.
18. **Reversal or supersession.** Not applicable.
19. **Privacy and jurisdiction cautions.** None. Aggregate reference data only — no personal or household records appear on any of these four tabs.
20. **Related tasks.** ADM-01, ADM-02.
21. **Recommended next step.** Return to the Datasets tab to act on what the log shows.
22. **Current availability.** Operational, read-only.
23. **Last validation date.** 2026-09-03, Wave 5, against DEV.
24. **Owning Admin phase.** Pre-existing; per-tab purpose, humanised column headings, row counts and correct empty-row rendering added Wave 5.

---

## ADM-04 — Create, edit, activate or deactivate a recommendation

1. **Task ID.** ADM-04
2. **Task name.** Create, edit, activate or deactivate a recommendation
3. **Purpose.** Maintain the recommendation library that decides which guidance a person is shown against their own results.
4. **Business outcome.** People receive relevant, current guidance, and nothing is served that the business has not deliberately activated.
5. **Eligible capability.** `isAdmin`.
6. **Eligible roles.** Super Admin only.
7. **Prerequisites.** For a new recommendation, a stable recommendation code not already in use.
8. **Navigation path.** Admin menu → General → Recommendations.
9. **Step-by-step.**
   1. Use search and the category filter to find a recommendation, or scroll to the form to create a new one.
   2. Select **Edit** on a row to load it into the form. The Edit control names the recommendation it belongs to, so it is unambiguous which row you acted on.
   3. Set the trigger, the conditions and the wording. Conditions in the same group are combined with OR; different groups are combined with AND.
   4. Select **Save changes** or **Create recommendation**.
   5. Use **Deactivate** to stop a recommendation being served, and confirm. The confirmation names the recommendation and its title, and states that it will stop being served to everyone it currently matches. **Activate** reverses it.
10. **Required fields.** Recommendation code, trigger type and its matching fields, sub-category, scenario name, severity, action type, action title and action content.
11. **Validation rules.** A recommendation with zero conditions is refused unless you explicitly confirm it, because a recommendation with no conditions matches every user. The check is made both in the form and again authoritatively on the server. Trigger fields are mutually exclusive: a forecast-variance recommendation carries forecast fields only, a health-score recommendation carries pillar fields only.
12. **Status meanings.** *Active* — currently served. *Inactive* — retained but never served. *Premium* — served only to premium plans. *Unconditional — always fires* — deliberately matches everyone. *Warning: active, 0 conditions* — active, not marked unconditional, and carrying no conditions, so it currently matches every user by accident; correct it.
13. **Success confirmation.** A confirmation appears beneath the form saying the recommendation was saved or created and that the library below has been reloaded from the server. Before Wave 5, this message was cleared in the same instant it was set and therefore never appeared at all.
14. **Common errors.** Validation failures are listed row by row beneath the form, each naming the field and the problem, with an explicit statement that nothing was changed. A conflicting code reports a conflict rather than overwriting.
15. **Recovery.** Correct the listed fields and submit again. Nothing was written by a rejected save.
16. **Conflict / stale state.** Saves go through a single atomic operation, so a recommendation and its conditions are never left half-written; if it fails, nothing changed.
17. **Audit evidence.** Creates and edits are recorded by the atomic save operation. Activation and deactivation are a simple flag change and are **not** separately audited today — this is a disclosed residual carried forward from Wave 4, not a Wave 5 claim of completeness.
18. **Reversal or supersession.** Deactivate and Activate reverse each other. Edits overwrite the previous wording; recommendations have no version history, so record what you changed elsewhere if it matters.
19. **Privacy and jurisdiction cautions.** The recommendation library itself holds no personal data. The Gap review section on the same page does — see ADM-06.
20. **Related tasks.** ADM-05, ADM-06.
21. **Recommended next step.** Check Gap review for evaluations that still match nothing.
22. **Current availability.** Operational.
23. **Last validation date.** 2026-09-03, Wave 5, against DEV.
24. **Owning Admin phase.** Wave 1/1B; confirmation, working success confirmation, empty state and per-row accessible names added Wave 5.

---

## ADM-05 — Bulk update recommendations from a CSV file

1. **Task ID.** ADM-05
2. **Task name.** Bulk update recommendations from a CSV file
3. **Purpose.** Update many recommendations at once from the master, conditions, calculation-method or placeholder file formats.
4. **Business outcome.** Library-wide corrections can be made without a deployment.
5. **Eligible capability.** `isAdmin`.
6. **Eligible roles.** Super Admin only.
7. **Prerequisites.** A CSV file in the exact column format for the type selected.
8. **Navigation path.** Admin menu → General → Recommendations → *Bulk update via CSV upload*.
9. **Step-by-step.**
   1. Choose the file type that matches your CSV.
   2. Select the file. **The upload begins as soon as a file is chosen** — there is no separate submit step.
   3. Read the result. Matching codes are updated in place, new codes are added, and codes absent from the file are left untouched.
10. **Required fields.** The file type, and the file.
11. **Validation rules.** Every row is validated before anything is written. A conditions import that fails validation changes nothing at all.
12. **Status meanings.** Not applicable.
13. **Success confirmation.** For a conditions import, the message states exactly how many recommendations were affected and how many conditions were inserted or replaced, and that everything else was left unchanged. For the other three file types, Wave 5 replaced a raw data dump with a plain statement of how many rows were applied.
14. **Common errors.** A validation failure lists each bad row with its code, field and problem, and states plainly that no existing conditions were changed.
15. **Recovery.** Fix the listed rows and upload the corrected file again.
16. **Conflict / stale state.** The conditions import is applied as a single operation; a partial application is not possible.
17. **Audit evidence.** A conditions import is recorded in the Resources audit log. The other three file types are bulk reference-data upserts and are not separately audited — a disclosed residual carried forward from Wave 4.
18. **Reversal or supersession.** There is no undo. Re-upload a corrected file with the same codes to overwrite the values again.
19. **Privacy and jurisdiction cautions.** Do not place personal or household data in these files. They are recommendation content, not user data.
20. **Related tasks.** ADM-04.
21. **Recommended next step.** Spot-check an affected recommendation in the library.
22. **Current availability.** Operational.
23. **Last validation date.** 2026-09-03, Wave 5, against DEV.
24. **Owning Admin phase.** Wave 1; success-message wording corrected Wave 5.

---

## ADM-06 — Review recommendation coverage gaps

1. **Task ID.** ADM-06
2. **Task name.** Review recommendation coverage gaps
3. **Purpose.** See real evaluations where nothing in the library matched, so a missing recommendation can be identified.
4. **Business outcome.** People are not left with no guidance because of a gap nobody noticed.
5. **Eligible capability.** `isAdmin`.
6. **Eligible roles.** Super Admin only.
7. **Prerequisites.** None.
8. **Navigation path.** Admin menu → General → Recommendations → *Gap review*.
9. **Step-by-step.** Read the list. Select **Show context** on a row to expand the exact data that was evaluated. Select it again to collapse.
10. **Required fields.** Not applicable.
11. **Validation rules.** Not applicable.
12. **Status meanings.** Not applicable.
13. **Success confirmation.** Not applicable — nothing is changed.
14. **Common errors.** None specific to this section.
15. **Recovery.** Not applicable.
16. **Conflict / stale state.** Not applicable.
17. **Audit evidence.** None is written by reading.
18. **Reversal or supersession.** Not applicable.
19. **Privacy and jurisdiction cautions.** **This is the one place in Admin where expanding a control shows one real person's evaluated financial figures.** The page now says so before you expand a row. Open it only when you need it to decide whether a recommendation is missing; do not copy it anywhere else; do not screenshot it. Whether this payload should be visible in Admin at all is a live question recorded for Product Owner decision in the Wave 5 certification report — this Wave did not change what is displayed, only disclosed it.
20. **Related tasks.** ADM-04.
21. **Recommended next step.** Create or edit a recommendation to cover the gap.
22. **Current availability.** Operational, read-only.
23. **Last validation date.** 2026-09-03, Wave 5, against DEV.
24. **Owning Admin phase.** Wave 1; privacy caution and disclosure semantics added Wave 5.

---

## ADM-07 — Use the Resources dashboard

1. **Task ID.** ADM-07
2. **Task name.** Use the Resources dashboard
3. **Purpose.** See what needs attention across Resources content and reach the right queue.
4. **Business outcome.** Nothing sits unnoticed in a review queue.
5. **Eligible capability.** `resourcesDashboard`.
6. **Eligible roles.** Resource Admin, Author, Editor, Compliance Reviewer, Publisher, Super Admin. An Analyst-only account reaches the page and is told plainly that it has no content-management access.
7. **Prerequisites.** None.
8. **Navigation path.** Admin menu → Resources → Dashboard.
9. **Step-by-step.** Read the Content overview counts. Use *Needs attention* to open the editorial-review, compliance-review, review-due or scheduled queues. Use *Recent content* to reopen something you were working on. Use *Quick links* to reach any Resources area.
10. **Required fields.** Not applicable.
11. **Validation rules.** Not applicable.
12. **Status meanings.** The status badges use the same words as everywhere else in Admin — see ADM-08's field 12.
13. **Success confirmation.** Not applicable — the dashboard changes nothing.
14. **Common errors.** *"You do not have access to this"*, *"Temporarily unavailable"* and *"Could not reach the server"* are now distinguished from one another, and only the ones that could plausibly succeed on a second attempt offer a Retry.
15. **Recovery.** Retry, or sign in again if the session has ended.
16. **Conflict / stale state.** Not applicable.
17. **Audit evidence.** None is written.
18. **Reversal or supersession.** Not applicable.
19. **Privacy and jurisdiction cautions.** None. Content counts and titles only — no personal or household data.
20. **Related tasks.** ADM-08, ADM-21.
21. **Recommended next step.** Open the queue with the highest count.
22. **Current availability.** Operational, read-only.
23. **Last validation date.** 2026-09-03, Wave 5, against DEV.
24. **Owning Admin phase.** R1.2; result-state accuracy, an honest unavailable state for Analyst, and the create-capability gate on the New Content button added Wave 5.

---

## ADM-08 — Create or edit an article, guide or FHIP explainer

1. **Task ID.** ADM-08
2. **Task name.** Create or edit an article, guide or FHIP explainer
3. **Purpose.** Write and maintain the long-form educational content the public Resources site serves.
4. **Business outcome.** Households get accurate, reviewed financial education.
5. **Eligible capability.** `resourceContentAdmin` to view and edit; `canCreateResource` to create.
6. **Eligible roles.** Author, Editor, Resource Admin, Super Admin can create and edit. Compliance Reviewer and Publisher can view and act in the workflow but the create control is not offered to them.
7. **Prerequisites.** A primary category and an author record must exist before the content can be submitted for review.
8. **Navigation path.** Admin menu → Resources → New Content, or Resources → All Content → open an item → **Edit**.
9. **Step-by-step.**
   1. Choose the content type on the New Content screen, or open an existing item.
   2. Enter the title. The URL slug is generated from it; if you change it, use **Check availability** before publication.
   3. Write the summary and add content blocks with **+ Add Block**. Blocks are reordered with the Move up and Move down controls — there is no drag-and-drop anywhere, deliberately, so reordering works from the keyboard.
   4. Complete the sidebar: primary category, jurisdiction, author, compliance classification, review date.
   5. Enter a change summary if you want this save recorded as a named revision, then select **Save Changes**.
10. **Required fields.** Title, URL slug, summary, primary category, author, and at least one block with real content — all of them required before the content can be submitted for review, and each shown against its own field.
11. **Validation rules.** Field errors appear against the field and are announced. Dates are entered as YYYY-MM-DD. Titles and summaries have character limits shown beside the field.
12. **Status meanings.** *Idea* / *Draft* — being written. *Editorial Review* — with an editor. *Compliance Review* — with a compliance reviewer. *Approved* — cleared, not yet public. *Published* — publicly visible. *Review Due* — published and overdue for a periodic review. *Archived* — withdrawn. Compliance is shown as GREEN, AMBER or RED, and the full meaning (Green — Education, Amber — Review Required, Red — Restricted) is now attached to the badge rather than living only in a mouse-only tooltip.
13. **Success confirmation.** The save indicator reads **Saved**. A new entry appears in Revision History when a change summary was supplied.
14. **Common errors.** *"Please fix the highlighted fields."* — correct them; your typing is preserved. *"That slug is already in use by another Resource."* — choose a different slug. *"This Resource was updated by someone else. Reload before saving your changes."* — see field 16.
15. **Recovery.** Nothing is lost by a failed save: everything you typed remains on the page. Correct and save again.
16. **Conflict / stale state.** If someone else saved the same content since you opened it, a dialog explains this and offers **Reload Now** or **Not Yet**. Reloading discards your unsaved edits, so copy anything you need out of the page first. Choosing Not Yet leaves you able to read your work but every further save will be refused until you reload.
17. **Audit evidence.** Named revisions appear in the Revision History panel. Workflow moves are recorded separately — see ADM-09.
18. **Reversal or supersession.** Earlier revisions are listed but cannot be restored from the interface in this release. To undo a change, edit the content back and save again.
19. **Privacy and jurisdiction cautions.** Never place a real person's financial details, or any household's data, into published educational content. Set the jurisdiction correctly — content written for Australian rules must not be served as if it were general or Indian.
20. **Related tasks.** ADM-09, ADM-16, ADM-15.
21. **Recommended next step.** Submit the content for editorial review from the Workflow panel.
22. **Current availability.** Operational.
23. **Last validation date.** 2026-09-03, Wave 5, against DEV.
24. **Owning Admin phase.** R1.3; save-label consistency, the Featured field actually saving, and accessibility fixes added Wave 5.

---

## ADM-09 — Move content through the publishing workflow

1. **Task ID.** ADM-09
2. **Task name.** Move content through the publishing workflow
3. **Purpose.** Take content from draft to published through editorial and compliance review, or send it back and archive it.
4. **Business outcome.** Nothing reaches the public without the reviews the business requires.
5. **Eligible capability.** `resourceWorkflowAdmin`, with the specific transition gated by the acting role.
6. **Eligible roles.** Author (submit), Editor (editorial approval and send back), Compliance Reviewer (compliance approval and send back), Publisher and Resource Admin (publish, archive), Super Admin.
7. **Prerequisites.** All changes saved — workflow actions are unavailable while anything is unsaved, and the panel now says so in a way a screen reader will announce.
8. **Navigation path.** Any content editor → the Workflow panel in the right-hand column.
9. **Step-by-step.**
   1. Save your changes first.
   2. Select the action for the current stage: **Submit for Editorial Review**, **Approve Editorially**, **Send to Compliance Review**, **Approve Compliance Review**, or **Publish Now**.
   3. **Publish Now** and both approvals now ask you to confirm. The Publish confirmation states that the content becomes publicly visible immediately, that there is no scheduled publication in this release, and that taking it down again means archiving it.
   4. **Send Back to Draft (editorial)**, **Send Back to Draft (compliance)** and **Archive** open a reason box. Give a reason — the next person sees it in the history.
10. **Required fields.** A reason is optional but strongly advised for both send-back actions and Archive.
11. **Validation rules.** AMBER content cannot be published without compliance approval. RED content cannot be published at all, and the panel says so. Actions you are not entitled to perform are not offered — and are independently refused by the server if attempted anyway.
12. **Status meanings.** As ADM-08 field 12.
13. **Success confirmation.** A message names the new state in plain words — for example, "Published. It is now publicly visible on the FHIP Resources site." The status badge changes and a new row appears in the workflow history. Wave 5 added this message; before it, a transition produced no statement of what had happened.
14. **Common errors.** The panel reports the specific workflow rule that blocked the move — for example that AMBER content needs a recorded compliance approval. Wave 5 stopped unexpected database failures being reported as though they were workflow rules; those now read as a plain "this could not be completed and nothing was changed".
15. **Recovery.** Fix what the message names, then act again. A refused transition changes nothing.
16. **Conflict / stale state.** The server re-checks the current status when it commits, so a transition made from a stale view is refused rather than applied out of order.
17. **Audit evidence.** Every transition writes both a workflow-history row (visible in the panel) and an entry in the Resources audit log, in the same operation as the status change itself — they cannot come apart.
18. **Reversal or supersession.** Send Back to Draft reverses an approval. Archive is reversed by moving the content forward again. Publishing is reversed by archiving — but anyone who has already seen the content has seen it.
19. **Privacy and jurisdiction cautions.** Check the jurisdiction and compliance classification before publishing. Publishing AU-specific guidance as Global is a jurisdiction error, not a formatting one.
20. **Related tasks.** ADM-08, ADM-10 (unavailable), ADM-21.
21. **Recommended next step.** Check the content appears correctly using Preview.
22. **Current availability.** Operational.
23. **Last validation date.** 2026-09-03, Wave 5, against DEV.
24. **Owning Admin phase.** R1.3; scheduling validation aligned Wave 2; confirmation on publish and approvals, success confirmation, distinguishable send-back labels and safe error reporting added Wave 5.

---

## ADM-10 — Schedule content for future publication *(not operational)*

1. **Task ID.** ADM-10
2. **Task name.** Schedule content for future publication
3. **Purpose.** Publish content automatically at a chosen future date and time.
4. **Business outcome.** Intended, not delivered.
5–17. **Not applicable while unavailable.**
18. **Reversal or supersession.** Not applicable.
19. **Privacy and jurisdiction cautions.** Not applicable.
20. **Related tasks.** ADM-09.
21. **Recommended next step.** Use **Publish Now** at the moment you want the content to go live.
22. **Current availability.** **Not operational.** There is no Schedule action in the workflow panel of any content type, and nothing in the platform publishes content automatically. A "Scheduled" status and a scheduled-date column exist in the data model and the Scheduled queue page exists, but no automation acts on them — so a date recorded anywhere will not cause publication. The workflow panel states this on screen. Scheduled publication is deferred to **A3.1**; Wave 5 did not build a worker, a queue or a scheduling control, and must not be read as having made scheduling available.
23. **Last validation date.** 2026-09-03, Wave 5 — re-confirmed by direct inspection that no Schedule control exists in any of the four content-type editors, which share one workflow panel.
24. **Owning Admin phase.** Wave 2 aligned the validation rule; A3.1 owns the capability.

---

## ADM-11 — Add or edit a video

1. **Task ID.** ADM-11
2. **Task name.** Add or edit a video
3. **Purpose.** Maintain the video library, including its transcript and chapters.
4. **Business outcome.** Video education is discoverable, accessible and accurately described.
5. **Eligible capability.** `resourceContentAdmin`; `canCreateSpecialistContent` to add.
6. **Eligible roles.** Author, Editor, Resource Admin, Super Admin create and edit; other Resources roles view.
7. **Prerequisites.** The YouTube URL or bare video ID.
8. **Navigation path.** Admin menu → Content → Videos → **Add @GKTC Video**.
9. **Step-by-step.** Paste the URL or ID and submit. Complete title, summary and sidebar metadata. Paste the transcript by hand — nothing is scraped or generated. Add chapters with timestamps in mm:ss or h:mm:ss form. Select **Save Changes**.
10. **Required fields.** Title, and a valid YouTube reference at creation.
11. **Validation rules.** The YouTube reference must be a recognised URL or ID. Chapter timestamps must be well formed; a malformed one is reported against that chapter. Duration accepts digits only.
12. **Status meanings.** As ADM-08 field 12.
13. **Success confirmation.** The save indicator reads **Saved**.
14. **Common errors.** *"This YouTube URL doesn't appear valid."* — check the link. *"One or more chapters need attention."* — a chapter's timestamp is malformed; the offending chapter is marked further down the page.
15. **Recovery.** Correct and save again; your input is preserved.
16. **Conflict / stale state.** As ADM-08 field 16, with video-specific wording.
17. **Audit evidence.** Named revisions in Revision History; workflow moves as ADM-09.
18. **Reversal or supersession.** Re-edit. Videos are archived through the workflow, never deleted.
19. **Privacy and jurisdiction cautions.** Do not paste a transcript containing an identifiable person's financial details. Set jurisdiction correctly.
20. **Related tasks.** ADM-09.
21. **Recommended next step.** Submit for editorial review.
22. **Current availability.** Operational.
23. **Last validation date.** 2026-09-03, Wave 5, against DEV.
24. **Owning Admin phase.** R1.4; save-label consistency and accessibility fixes added Wave 5.

---

## ADM-12 — Create or edit a glossary definition

1. **Task ID.** ADM-12
2. **Task name.** Create or edit a glossary definition
3. **Purpose.** Maintain the plain-English glossary the rest of the product links into.
4. **Business outcome.** A person meeting an unfamiliar term anywhere in FHIP can get a clear, consistent explanation.
5. **Eligible capability.** `resourceContentAdmin`; `canCreateSpecialistContent` to create.
6. **Eligible roles.** Author, Editor, Resource Admin, Super Admin create and edit; other Resources roles view.
7. **Prerequisites.** None.
8. **Navigation path.** Admin menu → Content → Glossary → **Create Glossary Definition**.
9. **Step-by-step.** Enter the term. If similar terms already exist you are warned before going further — check you are not duplicating one. Write the short definition as one clear sentence, add any expanded content, add aliases so people searching for another name find it, then **Save Changes**.
10. **Required fields.** Term, URL slug, short definition, primary category, author.
11. **Validation rules.** Duplicate terms are refused by the server; the on-screen similar-term warning is advisory and appears as you type.
12. **Status meanings.** As ADM-08 field 12.
13. **Success confirmation.** The save indicator reads **Saved**.
14. **Common errors.** *"Please fix the highlighted fields."* — including a genuine duplicate term.
15. **Recovery.** Correct and save again.
16. **Conflict / stale state.** As ADM-08 field 16.
17. **Audit evidence.** Named revisions; workflow moves as ADM-09.
18. **Reversal or supersession.** Re-edit; archive through the workflow.
19. **Privacy and jurisdiction cautions.** Definitions are general education. Do not write jurisdiction-specific tax or regulatory claims into a Global definition.
20. **Related tasks.** ADM-09, ADM-17.
21. **Recommended next step.** Submit for editorial review.
22. **Current availability.** Operational.
23. **Last validation date.** 2026-09-03, Wave 5, against DEV.
24. **Owning Admin phase.** R1.4; save-label consistency and accessibility fixes added Wave 5.

---

## ADM-13 — Create or edit a money update

1. **Task ID.** ADM-13
2. **Task name.** Create or edit a money update
3. **Purpose.** Publish a short, dated explanation of a real-world financial development.
4. **Business outcome.** People understand what changed in the world and whether it affects them.
5. **Eligible capability.** `resourceContentAdmin`; `canCreateSpecialistContent` to create.
6. **Eligible roles.** Author, Editor, Resource Admin, Super Admin create and edit; other Resources roles view.
7. **Prerequisites.** The date the development actually occurred.
8. **Navigation path.** Admin menu → Content → Money Updates → **Create a Money Update**, optionally from a template.
9. **Step-by-step.** Enter title, summary and event date (YYYY-MM-DD). Complete the pre-populated structured sections. Cite the official sources the update relies on. Select **Save Changes**.
10. **Required fields.** Title, URL slug, summary, event date, primary category, author.
11. **Validation rules.** The event date is required and must be a valid date. A GREEN classification on a tax, regulatory, interest-rate or government-policy topic prompts an on-screen suggestion to consider AMBER — advisory, not blocking.
12. **Status meanings.** As ADM-08 field 12. The list additionally marks template rows **Template**, which Wave 5 added — before it, updates and templates were indistinguishable in the list despite a filter offering to separate them.
13. **Success confirmation.** The save indicator reads **Saved**.
14. **Common errors.** *"Please fix the highlighted fields."*
15. **Recovery.** Correct and save again.
16. **Conflict / stale state.** As ADM-08 field 16.
17. **Audit evidence.** Named revisions; workflow moves as ADM-09.
18. **Reversal or supersession.** Re-edit; archive through the workflow. Creating an update from a template never modifies the template.
19. **Privacy and jurisdiction cautions.** Money updates are the highest-risk content type for jurisdiction error, because tax and regulatory changes are country-specific. Set jurisdiction deliberately and cite the official source.
20. **Related tasks.** ADM-09.
21. **Recommended next step.** Submit for editorial review.
22. **Current availability.** Operational.
23. **Last validation date.** 2026-09-03, Wave 5, against DEV.
24. **Owning Admin phase.** R1.4; save-label consistency, the Template badge and accessibility fixes added Wave 5.

---

## ADM-14 — Create, edit or delete an FAQ

1. **Task ID.** ADM-14
2. **Task name.** Create, edit or delete an FAQ
3. **Purpose.** Maintain reusable questions and answers that can be attached to any Resources content.
4. **Business outcome.** Common questions are answered consistently wherever they arise.
5. **Eligible capability.** `canManageFaqs`.
6. **Eligible roles.** Editor, Resource Admin, Super Admin.
7. **Prerequisites.** None.
8. **Navigation path.** Admin menu → Content → FAQs → **New FAQ**, or **Edit** on a row.
9. **Step-by-step.** Write a question and a short answer that stands alone — the same FAQ can appear on several pages, so avoid "as explained above". Add any expanded answer. Set jurisdiction, category and compliance classification. Use *Link to content* to attach it to pages, and **Unlink** (with confirmation) to detach it. Select **Save**.
10. **Required fields.** Question, short answer, jurisdiction, compliance classification.
11. **Validation rules.** Field-level; character limits are shown beside each field.
12. **Status meanings.** *Active* — visible on public surfaces. *Inactive* — hidden from public surfaces but still editable.
13. **Success confirmation.** **Saved** appears beside the Save button. Wave 5 made it clear again as soon as you make a further change — previously it stayed on screen while you went on editing, wrongly implying your latest work was committed. Unlinking reports which page the FAQ was detached from.
14. **Common errors.** *"Please fix the highlighted fields."* A delete blocked because the FAQ is still linked reports a conflict and tells you what to do instead.
15. **Recovery.** Correct and save again.
16. **Conflict / stale state.** If someone else saved the FAQ since you opened it, a dialog explains this and offers **Reload Now** (which discards your unsaved edits) or **Not Yet**.
17. **Audit evidence.** FAQs are not versioned. There is no revision history for this content type — record significant wording changes elsewhere if they matter.
18. **Reversal or supersession.** **Deleting an FAQ cannot be undone.** Clearing the Active checkbox is fully reversible and hides it from public pages while keeping it editable — prefer it. The delete confirmation now names the FAQ, states how many pages it is linked to, and says plainly that deletion cannot be undone.
19. **Privacy and jurisdiction cautions.** Never answer an FAQ with an individual's real figures. Set jurisdiction correctly for tax and regulatory answers.
20. **Related tasks.** ADM-08.
21. **Recommended next step.** Check the FAQ appears where you linked it.
22. **Current availability.** Operational.
23. **Last validation date.** 2026-09-03, Wave 5, against DEV.
24. **Owning Admin phase.** R1.4; unlink confirmation and outcome checking, delete-copy improvement and the saved-indicator correction added Wave 5.

---

## ADM-15 — Create, edit, activate or deactivate a call to action

1. **Task ID.** ADM-15
2. **Task name.** Create, edit, activate or deactivate a call to action
3. **Purpose.** Maintain the controlled set of calls to action that bridge educational content to the rest of FHIP.
4. **Business outcome.** Readers are offered a next step, from an approved, non-advisory set.
5. **Eligible capability.** `canManageDiscovery` to change; `isResourceStaff` to view.
6. **Eligible roles.** Resource Admin and Super Admin manage; other Resources roles view.
7. **Prerequisites.** None.
8. **Navigation path.** Admin menu → Discovery → CTAs.
9. **Step-by-step.** Select **New CTA**, or **Edit** on a row. Give it an internal name, the public label readers see, and the destination — the form states the exact destination format expected for the type you choose. Select **Create CTA** or **Save Changes**. Use **Deactivate** (with confirmation) to remove a CTA from every public page using it; **Activate** restores it.
10. **Required fields.** Internal Name, Public Label and Destination, each now marked required on the form rather than only being rejected after submission.
11. **Validation rules.** The destination must match the chosen destination type: an internal resource path, a verified FHIP module route, a sign-up or log-in path, a full external https URL, or a YouTube URL.
12. **Status meanings.** *Active* — appears on public content. *Inactive* — retained but not shown anywhere.
13. **Success confirmation.** A message names the CTA and states whether it now appears on public pages or has been removed from them. Saving returns you to the list.
14. **Common errors.** A rejected save now says how many fields need correcting, marks each one against its own field, and moves focus to the explanation so it is not left below the fold.
15. **Recovery.** Correct the marked fields and save again; nothing was saved by a rejected attempt.
16. **Conflict / stale state.** No conflict dialog on this form. If two people edit the same CTA, the later save wins — coordinate before editing a CTA someone else is working on.
17. **Audit evidence.** CTA changes are not separately audited today. This is a disclosed residual, not a claim of coverage.
18. **Reversal or supersession.** Deactivate and Activate reverse each other. There is no delete. Cancelling an edit with unsaved changes now asks before discarding them.
19. **Privacy and jurisdiction cautions.** A CTA must never imply personal financial advice, and must not be personalised. Destinations must be FHIP routes or approved external links.
20. **Related tasks.** ADM-08 (attaching a CTA from the editor sidebar).
21. **Recommended next step.** Attach the CTA to content from the content editor sidebar.
22. **Current availability.** Operational.
23. **Last validation date.** 2026-09-03, Wave 5, against DEV.
24. **Owning Admin phase.** R1.5/R1.6; confirmation, success confirmation, filter-aware empty state, form accessibility and the mobile layout added Wave 5.

---

## ADM-16 — Curate related content

1. **Task ID.** ADM-16
2. **Task name.** Curate related content
3. **Purpose.** Choose exactly which other resources appear alongside a resource, overriding the automatic match.
4. **Business outcome.** Readers are guided along a deliberate learning path rather than an algorithmic one.
5. **Eligible capability.** `canManageDiscovery` to change; `isResourceStaff` to view.
6. **Eligible roles.** Resource Admin and Super Admin manage; other Resources roles view.
7. **Prerequisites.** The resource you want to curate exists.
8. **Navigation path.** Admin menu → Discovery → Related Content.
9. **Step-by-step.** Search for and choose the resource to manage. Search for another resource and select it to add the relationship, choosing the relationship type. Use the up and down controls to set the order readers see. Use **Remove** and confirm to delete a relationship.
10. **Required fields.** The source resource, the related resource, and the relationship type.
11. **Validation rules.** A resource cannot be related to itself, and the same pair cannot be added twice.
12. **Status meanings.** Each row shows the related item's own type and status, and marks it *(not currently public)* when readers would not see it.
13. **Success confirmation.** Adding, removing and reordering each report their outcome. Reordering shows *Order saved.* and the list is re-sorted into the order the **server committed**, not the order you clicked — so the screen can never show an order the database refused.
14. **Common errors.** A reorder that collides with someone else's change reports that the list has changed since it was loaded and reloads the real order. A Remove for an item someone else already removed is reported as already removed, not as a failure.
15. **Recovery.** Reload and repeat. Nothing is half-applied.
16. **Conflict / stale state.** Handled explicitly, as in field 14. This is the strongest conflict handling in Admin and Wave 5 left it untouched.
17. **Audit evidence.** Reordering is recorded. Adding and removing a link are not separately audited — a disclosed residual.
18. **Reversal or supersession.** Add the relationship again to restore it. Order can be changed at any time.
19. **Privacy and jurisdiction cautions.** Do not relate AU-specific content as the primary next step from India-specific content, or vice versa; check each row's jurisdiction.
20. **Related tasks.** ADM-08, ADM-17.
21. **Recommended next step.** Check the public page shows the resources in the order you set.
22. **Current availability.** Operational.
23. **Last validation date.** 2026-09-03, Wave 5, against DEV.
24. **Owning Admin phase.** Wave 2 (reorder integrity); remove confirmation and outcome checking, add confirmation and picker states added Wave 5.

---

## ADM-17 — Map a resource to an in-product context

1. **Task ID.** ADM-17
2. **Task name.** Map a resource to an in-product context
3. **Purpose.** Decide which resource the "What does this mean?" link opens from a specific place in the product.
4. **Business outcome.** A person meeting an unfamiliar concept in their own numbers gets the right explanation.
5. **Eligible capability.** `canManageDiscovery`.
6. **Eligible roles.** Resource Admin and Super Admin manage; other Resources roles view.
7. **Prerequisites.** The resource you want to link to is published, or the link will not render for readers.
8. **Navigation path.** Admin menu → Discovery → Context Mapping.
9. **Step-by-step.** Choose the context key. Search for a resource and select it to add the mapping. Use the up and down controls to order mappings — the lowest-ordered **active** mapping is the one readers get. Use **Deactivate** (with confirmation) to stop a mapping being used without deleting it, and **Remove** (with confirmation) to delete it.
10. **Required fields.** The context key and the resource.
11. **Validation rules.** Only registered context keys can be chosen — there is no free-text key entry, so a mapping can never point at a context the product does not have.
12. **Status meanings.** Each row now shows **Active** or **Inactive** explicitly. Before Wave 5 the only signal was the inverse of a button label, which required the operator to reason backwards from "Deactivate" to "this must be active".
13. **Success confirmation.** Adding, activating, deactivating, removing and reordering each report their outcome, and the list is reloaded from the server afterwards in every case, including on success.
14. **Common errors.** A permission denial, a not-found and a transient failure now read differently from one another. Before Wave 5 all three were completely silent: the row simply reappeared after the reload with no explanation.
15. **Recovery.** Read the message and repeat the action. On a reorder failure the list is reloaded so what you see is the order actually stored.
16. **Conflict / stale state.** Reordering rewrites the whole list's order; if any part of that is refused, the failure is reported and the stored order is shown rather than the order you clicked.
17. **Audit evidence.** Context mapping changes are not separately audited — a disclosed residual.
18. **Reversal or supersession.** Activate reverses Deactivate. A removed mapping must be added again.
19. **Privacy and jurisdiction cautions.** A context is seen by users in both AU and India; map it to Global content, or accept that some readers get jurisdiction-specific material.
20. **Related tasks.** ADM-12, ADM-08.
21. **Recommended next step.** Open the product page for that context and check the link resolves.
22. **Current availability.** Operational.
23. **Last validation date.** 2026-09-03, Wave 5, against DEV.
24. **Owning Admin phase.** R1.6; confirmation, outcome checking on all four mutations, reorder reconciliation, the Active/Inactive badge, accessible names and touch-target sizing added Wave 5.

---

## ADM-18 — Assign or remove a Resources role

1. **Task ID.** ADM-18
2. **Task name.** Assign or remove a Resources role
3. **Purpose.** Control who can author, review, approve and publish Resources content.
4. **Business outcome.** Separation of duties is real: the person who writes is not automatically the person who approves.
5. **Eligible capability.** `canManageResources`.
6. **Eligible roles.** Resource Admin and Super Admin only. Any other Resources role that reaches this page's URL is redirected away.
7. **Prerequisites.** The person already has an FHIP account. You cannot create accounts here.
8. **Navigation path.** Admin menu → Resources → Dashboard → Quick links → Users & Roles.
9. **Step-by-step.** Search by name or email. Choose a role in the person's row and select **Assign** — the control names the person it applies to. To remove a role, select the remove control on the role pill and confirm.
10. **Required fields.** The person and the role.
11. **Validation rules.** A role already held cannot be assigned again. The final active Resource Administrator cannot be removed — the interface explains why and what to do first.
12. **Status meanings.** Each person's current roles are shown as labelled pills. *FHIP Super Admin* is shown separately, because it is not a Resources role.
13. **Success confirmation.** A message names the person and the role, and — for an assignment — notes that they may need to sign out and back in before the new access takes effect. Wave 5 added this; before it, the only evidence was a pill appearing after a loading flash.
14. **Common errors.** *"That role is already assigned to this person."* *"You do not have permission to change roles."* *"Cannot remove the final active Resource Administrator …"* — assign the role to someone else first. Wave 5 stopped raw database messages naming internal tables and constraints being shown here.
15. **Recovery.** Read the message and act on it; a failed change leaves everything as it was.
16. **Conflict / stale state.** The list reloads after every change, so it always shows committed state.
17. **Audit evidence.** Every assignment and removal is recorded in the Resources audit log with the acting administrator, the target, and the before and after state.
18. **Reversal or supersession.** Assign the role again to restore it. Removing a role never deletes past work or historical assignments — content already assigned to that person keeps its assignment.
19. **Privacy and jurisdiction cautions.** This page shows other people's names and email addresses. Use it only to manage access; do not export or copy the list.
20. **Related tasks.** ADM-08, ADM-09.
21. **Recommended next step.** Ask the person to sign out and back in.
22. **Current availability.** Operational.
23. **Last validation date.** 2026-09-03, Wave 5, against DEV.
24. **Owning Admin phase.** R1.2; success confirmation, safe error reporting, a mobile layout, an announced result count and per-row accessible names added Wave 5.

---

## ADM-19 — View Resources analytics *(not operational)*

1. **Task ID.** ADM-19
2. **Task name.** View Resources analytics
3. **Purpose.** Intended future home for Resources usage and engagement reporting.
4. **Business outcome.** Intended, not delivered.
5. **Eligible capability.** `resourceAnalytics`.
6. **Eligible roles.** Analyst, Resource Admin, Super Admin — for the page's access gate only; there is nothing on it to do.
7. **Prerequisites.** None.
8. **Navigation path.** **Not in the Admin menu.** A destination that completes no task is not offered as a navigation item. It remains reachable by direct URL for a caller who holds the capability. An Analyst-only account, which would otherwise see no Admin destinations at all, is shown a fixed, non-interactive note in the Admin menu saying analytics access is confirmed but no analytics features exist yet.
9. **Step-by-step.** Opening the page shows a title and a statement that no analytics surfaces are available yet.
10–17. **Not applicable.** There is no metric, figure, chart, filter, export or control of any kind on this page, and it makes no analytics request.
18. **Reversal or supersession.** Not applicable.
19. **Privacy and jurisdiction cautions.** None yet — no data is surfaced. When analytics are built, the suppression and privacy controls in the Admin Architecture Standard §7–§10 apply in full.
20. **Related tasks.** None yet.
21. **Recommended next step.** None.
22. **Current availability.** **Not operational.** This is the one visible destination in Admin that completes no task, by explicit design and open disclosure rather than by omission.
23. **Last validation date.** 2026-09-03, Wave 5 — re-confirmed the page renders no figure of any kind and makes no data request.
24. **Owning Admin phase.** Analyst Wave 1 (shell); navigation removed Wave 3; unchanged by Wave 5.

---

## ADM-20 — Admin capability resolution

1. **Task ID.** ADM-20
2. **Task name.** Admin capability resolution
3. **Purpose.** Not a task an administrator performs. It is the shared check every Admin page and the Admin menu itself use to answer "what can this person do".
4. **Business outcome.** Navigation shows only destinations the person can actually use — while never being the thing that protects them.
5. **Eligible capability.** None by design. It is callable by any session and always answers honestly, returning an all-false capability set for a caller with none.
6. **Eligible roles.** All.
7–16. **Not applicable** — there is no user-facing procedure.
17. **Audit evidence.** None required; it is a read-only check that changes nothing.
18. **Reversal or supersession.** Not applicable.
19. **Privacy and jurisdiction cautions.** It reports only the caller's own capabilities, never anyone else's.
20. **Related tasks.** Underlies every other task's first step.
21. **Recommended next step.** Not applicable.
22. **Current availability.** Operational.
23. **Last validation date.** 2026-09-03, Wave 5 — behaviour unchanged by this Wave.
24. **Owning Admin phase.** Analyst Wave 1.

**Standing warning, repeated here because it matters:** navigation visibility is never authorisation. Hiding a link protects nothing. Every destination is independently gated at the page, the API and the database. Do not treat "they cannot see it in the menu" as a control.

---

## ADM-21 — Work a content queue

1. **Task ID.** ADM-21
2. **Task name.** Work a content queue
3. **Purpose.** See only the content at one stage of the publishing workflow, so nothing waits unnoticed.
4. **Business outcome.** Review and publication actually happen, on the content that is waiting.
5. **Eligible capability.** `resourceWorkflowAdmin`.
6. **Eligible roles.** Resource Admin, Author, Editor, Compliance Reviewer, Publisher, Super Admin.
7. **Prerequisites.** None.
8. **Navigation path.** Admin menu → Workflow → Drafts / Review Queue / Scheduled / Published / Review Due / Archived.
9. **Step-by-step.** Open the queue. Each queue is already limited to its own stage, so there is no status filter to set. Narrow further with search, type, jurisdiction, compliance and category, then sort. Select **View** on a row to open the content, then **Edit** to act on it. Use **Clear Filters** to return to the full queue.
10. **Required fields.** Not applicable.
11. **Validation rules.** Not applicable.
12. **Status meanings.** As ADM-08 field 12.
13. **Success confirmation.** Not applicable — queues change nothing.
14. **Common errors.** A permission denial, a not-found and a transient failure are now distinguished, and only recoverable failures offer a Retry.
15. **Recovery.** Retry, or clear filters if you expected results.
16. **Conflict / stale state.** Not applicable — reopening the queue always re-reads from the server.
17. **Audit evidence.** None is written by viewing.
18. **Reversal or supersession.** Not applicable.
19. **Privacy and jurisdiction cautions.** None. Content metadata only.
20. **Related tasks.** ADM-08, ADM-09.
21. **Recommended next step.** Open the content and act on it from its Workflow panel.
22. **Current availability.** Operational, read-only. Note that the **Scheduled** queue is a real queue over a real status, but nothing publishes its contents automatically — see ADM-10.
23. **Last validation date.** 2026-09-03, Wave 5, against DEV.
24. **Owning Admin phase.** R1.2/R1.3; an announced result count, a visible active-filter summary, an honest empty state and result-state accuracy added Wave 5. First documented as a task in its own right by Wave 5.

---

## Manual coverage matrix (Wave 5 §16)

| Task | Visible page | Capability | Manual | Live validated | Errors validated | Reversal validated | Help link | Status |
|---|---|---|---|---|---|---|---|---|
| ADM-01 | Yes | `isAdmin` | Yes | Yes | Yes | Yes | Yes | Complete |
| ADM-02 | Yes | `isAdmin` | Yes | Yes | Yes | Yes | Yes | Complete |
| ADM-03 | Yes | `isAdmin` | Yes | Yes | Yes | N/A (read-only) | Yes | Complete |
| ADM-04 | Yes | `isAdmin` | Yes | Yes | Yes | Yes | Yes | Complete |
| ADM-05 | Yes | `isAdmin` | Yes | Yes | Yes | N/A (no undo, stated) | Yes | Complete |
| ADM-06 | Yes | `isAdmin` | Yes | Yes | N/A | N/A (read-only) | Yes | Complete |
| ADM-07 | Yes | `resourcesDashboard` | Yes | Yes | Yes | N/A (read-only) | Yes | Complete |
| ADM-08 | Yes | `resourceContentAdmin` | Yes | Yes | Yes | Yes | Yes | Complete |
| ADM-09 | Yes | `resourceWorkflowAdmin` | Yes | Yes | Yes | Yes | Yes | Complete |
| ADM-10 | No page | — | Availability note only | N/A | N/A | N/A | Yes (states unavailable) | Correctly unavailable |
| ADM-11 | Yes | `resourceContentAdmin` | Yes | Yes | Yes | Yes | Yes | Complete |
| ADM-12 | Yes | `resourceContentAdmin` | Yes | Yes | Yes | Yes | Yes | Complete |
| ADM-13 | Yes | `resourceContentAdmin` | Yes | Yes | Yes | Yes | Yes | Complete |
| ADM-14 | Yes | `canManageFaqs` | Yes | Yes | Yes | Yes | Yes | Complete |
| ADM-15 | Yes | `canManageDiscovery` | Yes | Yes | Yes | Yes | Yes | Complete |
| ADM-16 | Yes | `canManageDiscovery` | Yes | Yes | Yes | Yes | Yes | Complete |
| ADM-17 | Yes | `canManageDiscovery` | Yes | Yes | Yes | Yes | Yes | Complete |
| ADM-18 | Yes | `canManageResources` | Yes | Yes | Yes | Yes | Yes | Complete |
| ADM-19 | Yes (direct URL) | `resourceAnalytics` | Availability note only | Yes | N/A | N/A | N/A (nothing to do) | Correctly unavailable |
| ADM-20 | No page | none by design | Yes | N/A | N/A | N/A | N/A | Complete |
| ADM-21 | Yes (6 pages) | `resourceWorkflowAdmin` | Yes | Yes | Yes | N/A (read-only) | Yes | Complete |

The "Live validated", "Errors validated" and "Reversal validated" columns are backed by the execution evidence in the Wave 5 certification report; the precise scope and limits of that evidence — including what was proven by driving the real application on DEV versus what was proven structurally — is stated there rather than summarised optimistically here.

---

## Terminology register (Wave 5 §18)

One word per concept, across every Admin surface.

| Concept | Approved word | Do not use | Note |
|---|---|---|---|
| Saving content without changing its status | **Save Changes** | "Save Draft", "Save" | Wave 5 unified all four content editors. "Save Draft" was wrong on published content. |
| Making content publicly visible | **Publish Now** | "Publish", "Go live" | Named "Now" deliberately: there is no scheduled publication. |
| Returning content to its author | **Send Back to Draft** | "Reject", "Decline" | Suffixed *(editorial)* / *(compliance)* so the two are distinguishable. |
| Withdrawing content from the public site | **Archive** | "Delete", "Unpublish" | Content is never deleted through the workflow. |
| Stopping something being used without deleting it | **Deactivate** / **Activate** | "Disable", "Turn off", "Retire" | Used for CTAs, context mappings, recommendations, FAQs and roles. |
| Taking a benchmark dataset out of service | **Retire** | "Deactivate", "Archive" | Benchmarks-specific, and distinct from Deactivate because it is a governance lifecycle event. |
| Removing a curated relationship or mapping | **Remove** | "Delete", "Unlink" | "Unlink" is reserved for FAQs specifically. |
| Detaching an FAQ from a page | **Unlink** | "Remove", "Delete" | The FAQ itself survives. |
| Permanently destroying a record | **Delete** | anything softer | Used only where deletion is genuinely irreversible — currently FAQs only. |
| A person's access grant | **Role** | "Permission", "Group" | Capabilities are internal; operators see roles. |
| Compliance classification | **GREEN / AMBER / RED**, with its meaning attached | colour alone | Meaning: Education / Review Required / Restricted. |
| A benchmark's citation origin | **Source** | "Publisher", "Reference" | Publisher is a column on a source, not a synonym for it. |

**Deferred terminology findings, recorded rather than changed:**
- The Admin menu group holding Benchmarks and Recommendations is labelled **General**, which describes neither. Renaming it would change assertions in the certified Analyst Wave 1 navigation contract and its tests, which is outside a UX Wave's authority under §14. Recorded for Product Owner decision.
- **"Add @GKTC Video"** embeds a channel handle in a control label. It is accurate today but couples the interface to one channel. Recorded for Product Owner decision.
