# Market Index Data: how to apply migration 0280 (edit an entitlement record, no duplicates) on DEV (Product Owner step)

Written 08-10-2026. Why: you asked for an edit option on entitlement records "so there is no duplicate of records; if any mistake happens it needs to be rectified and approved again". Until now an approved record was frozen, so changing a right meant proposing a second record, and the rights of all approved records for one benchmark are combined (any record that grants a right is enough). That left two approved records for one benchmark.

**Evidence label:** the SQL was replayed on an isolated in-memory Postgres (PGlite) together with the whole migration ledger and every rule was exercised there as the real database roles (see "What was proved" below). It has **not** been applied to DEV or production. The screens were checked as pure logic and route tests, not yet in a browser against a database.

## What it does, in plain words

- **A draft** (proposed, not yet approved) can be edited in place by **the person who proposed it**. Each save is recorded with what changed.
- **An approved record** is never changed in place. **Edit (needs approval)** creates **one open revision** linked to it. The form is pre-filled with the approved values and asks for a reason (at least 10 characters). The revision grants **nothing** until it is approved. The approved record **keeps granting exactly as before** until then, so there is no gap.
- **Approving the revision** (a person with the existing approval permission) does two things in one database transaction: the revision becomes approved and the original is closed as "replaced". The original is **kept** (never deleted) and is visible under **Show history**. At no moment are both in force from the outside, and at no moment is neither.
- **Cancel or reject:** the proposer can cancel their own revision, an approver can reject it. The original is untouched either way.
- **At most one open revision per record**, enforced by the database itself.
- **Revoking** a record that has an open revision closes that revision in the same step, so a revoked licence cannot be brought back by approving an older revision.
- **Stale screen protection:** if the proposer edits a draft after an approver opened it, the approval is refused and the approver reviews it again.
- The screen shows only **current** records (drafts, approved records, and an open revision as a badge on its original). **Show history** adds replaced and revoked records. **History** on any record opens its audit timeline: what changed (before and after, dates day-first), the reason, and when. A person appears only as "You" or by role, never by name.
- It creates **no new permission**, changes **no existing record**, loads nothing and grants nothing.

How a replaced record is stored: the status list of the table is **not** widened. A replaced original has status `revoked` plus two new columns (`superseded_at`, `superseded_by`), and a new check makes it impossible to have `superseded_at` set while the status is still `approved`. Every existing reader already ignores a revoked record, so a replaced record cannot grant a right, even to code written before this migration.

## Before you start

1. Project: Supabase **DEV**. Check the project reference is `vqycarelcoijzwlpkpcz` (browser address bar of the Supabase dashboard, and Project Settings, General). **If it is anything else, stop.** Do not run this on production yet.
2. Migration `0241` (benchmark data governance) must already be applied on DEV. If it is missing, part a stops with a clear message and changes nothing.
3. Apply the **SQL first, then deploy the branch** (the evidence for this order is in "PRODUCTION: release order" below).
4. **Do not run `0241` again after `0280`.** `0241` would put back the older three-argument approve function and the older revoke function. If that ever happens, run `0280` again (it is safe to run twice and repairs both).
5. Migration number: `0280`. Re-scanned on 14-10-2026 after merging origin/main (b94724d): 878 branch, remote and tag refs and 183 worktree folders. The highest number anywhere is `0280`, found only in this branch and in your DEV integration worktree (a byte-identical copy of this file). `0279` is the promo hardening release, `0260-0263` and `0269-0271` are NAV2, `0272-0274` are the bulk upload branch. The remote called `doclife` still cannot be fetched (it points at a local folder, `worktrees/doc-lifecycle`, that is not a git repository root), but its previously fetched branches were scanned, and that folder has no migrations of its own; nothing above `0279`.

## Apply (Supabase SQL editor, DEV)

The whole file is `supabase/migrations/0280_bench1_entitlement_edit_revision.sql`. It is long, so it is also split into three parts. Paste them **one at a time, in order**. Each part can be run on its own and can be run twice safely.

1. Open `docs/benchmark-data/po_apply_entitlement_edit/parts/0280a.sql`, paste all of it, press Run. Expect "Success. No rows returned".
2. Open `parts/0280b.sql`, paste, Run. Same result.
3. Open `parts/0280c.sql`, paste, Run. Same result.

(Or paste the whole migration file in one go. If the editor complains, use the three parts.)

## Check it worked

Open `docs/benchmark-data/po_apply_entitlement_edit/verify.sql`, paste, Run. It only reads. It must return **12 rows and every `result` must be `PASS`**. It lists, for each check, what was expected and what was found.

The database cannot be driven from the SQL editor to try the edit itself (the functions check which signed-in person is calling, and the editor has none). The end-to-end check is done in the screen after the branch is deployed to DEV: I will do it with a catalogue-permission account and an approver account and report back.

## What was proved (PGlite, the whole ledger 0001 to 0280)

- Draft edit by the proposer only (not by another catalogue administrator, not by someone whose permission was withdrawn); each save audited with the fields before and after and no user id in the audit images.
- Approved record: edit creates exactly one linked revision, needs a reason, grants nothing; the original keeps granting; a second open revision is refused by the function and by a unique index; a revision cannot move to another benchmark; a revision that changes nothing is refused.
- Approval of a revision: the original becomes `revoked` plus superseded, the revision approved, exactly one record grants afterwards, the original is kept and readable by a view-only administrator but not by a plain user.
- The rights combination never counts a replaced record: rights removed by the revision are really gone; the data-date scope reported to consumers is the revision's only; the series read policy follows (a plain reader loses access when a revision removes calculation); a replaced row cannot be set back to approved.
- No gap: an injected failure at either step of the approval rolls everything back (original still in force, revision still a draft); an observer inside the transaction saw at least one record in force at every step and exactly one at the end.
- Capability matrix by calling the functions directly as non-admin, view-only, admin without capability, catalogue-only, approver-only and both; the anonymous role cannot run any new function; direct table writes are still refused.
- Self-approval acknowledgement unchanged and applies to revisions; a stale approval is refused.
- Re-applying is idempotent; rollback restores the earlier behaviour and the migration applies again on top.
- Nine named negative controls (each removes one rule, the named test goes red, the rule is restored, it goes green): the original not closed, no single-open-revision rule, no capability check on draft edit, no proposer-only rule, no self-approval rule, the structural superseded check removed together with a non-closing approval, a non-atomic approval, revoke not closing the revision, no stale check.

## What to paste back to me

1. The 12 rows of `verify.sql` (or just tell me all are PASS).
2. Any error text, exactly as shown, if a part did not run.

## Undo (roll back)

Safe at any time. It closes any open revision (so the earlier approve function cannot create a duplicate), removes the five new functions, and puts back the earlier approve and revoke functions. The new columns, checks and indexes stay in place on purpose (they hold the history of which record replaced which and do no harm). A record already replaced stays closed.

1. Open `docs/benchmark-data/po_apply_entitlement_edit/rollback.sql`, paste all of it, press Run. Expect "Success. No rows returned".
2. Check: `select count(*) from pg_proc where proname = 'update_benchmark_entitlement_draft';` must return 0.

You can apply `0280` again later.

## Admin Architecture Standard: what applies

- **Capabilities affected (no new capability):** `can_manage_benchmark_catalogue` (edit a draft, propose or cancel a revision: the same authority that proposes) and `can_approve_benchmark_entitlements` (approve or reject a revision, revoke: the same authority that approves). `view` (any of the benchmark capabilities, read only) reads the list and the history. A new capability was not needed because editing a draft or proposing a revision is drafting, which the catalogue capability already authorises (its column comment in 0241 says "drafting entitlement records"), and nothing is approved without the approver capability.
- **Clauses:** section 2 and 4 (capability enforced at database, API and UI; direct-API and database-bypass tests), section 5 (separation of duties: proposer and approver stay separate; self-approval needs the recorded acknowledgement), section 6 (security definer functions with internal capability checks, fixed search path, grants to authenticated only, no dynamic SQL), section 9 (the history returns no user id and only whitelisted fields), section 13 (fail closed: a stale or missing column is an explicit unavailable, never an empty success).
- **Exceptions requested:** none.
- **Audit:** the existing append-only governance event log (`ii_benchmark_governance_events`). It has only a length check on the event type, no list, so the new event types needed no widening of any shared constraint. New types: `entitlement_draft_edited`, `entitlement_revision_proposed`, `entitlement_revision_edited`, `entitlement_revision_approved`, `entitlement_superseded`, `entitlement_revision_cancelled`, `entitlement_revision_rejected`, `entitlement_revision_closed`.
- **Not changed:** the shared audit events table and its delta chain; the status list of the entitlement table; the 0241 rights evaluator, entitled-actions function, calc-readable function and the series read policy (they already ignore revoked records).

## PRODUCTION: release order, precheck, backup (decided 14-10-2026)

State: 0280 was applied on DEV by you and `verify.sql` returned 12/12 PASS; you tested Edit, Review, Reject and Cancel revision there. This section is for production. Production has **no managed backups** (Free plan), so the backup step below is not optional.

### Decision: SQL first, then push

**Recommended order: backup, precheck, SQL 0280 (parts a, b, c), `verify.sql`, then the push.** Both orders were examined with evidence; this one has no known harmful window, and if the SQL step fails nothing was deployed.

**If the SQL is applied BEFORE the new app is deployed (the recommended order): what breaks for the OLD app? Nothing known.**
- The old app calls `approve_benchmark_entitlement` by argument name with three arguments (`p_id`, `p_note`, `p_self_approval_ack`). 0280 replaces that function by one with a fourth, optional argument, so the old call still resolves. Evidence (PGlite, test "RELEASE ORDER, SQL first"): the old three-name call approves a draft, approves a revision correctly (the original is closed as replaced), and revoke by name still works; every column the old overview reads still exists.
- The old app has no screen that creates a revision, so no revision can exist before the new app is live. The old screen therefore never sees a state it cannot show.
- How long: until the deploy finishes (Amplify, a few minutes). Not harmful for any length of time.
- Not verified here: PostgREST's own schema cache. Supabase reloads it automatically after DDL (seconds). A named call resolves inside Postgres, so a stale cache should not matter, but I could not exercise PostgREST. So: **do not approve or revoke an entitlement while part c is running and for one minute after it.**

**If the push goes BEFORE 0280: what does the NEW app do against the OLD database?**
- The overview first reads the 0280 columns; Postgres answers "column does not exist" (code 42703); the app repeats the read with the older columns and reports edit as unsupported. **Edit, Show history and History are hidden** and the tab behaves as before (unit tests of the fallback, including the rule that any other error is shown as an error and never as an empty list).
- The approve route would have failed here: it used to always send the 4th argument, and the old function has no such argument (PGlite: SQLSTATE 42883, "function does not exist"), which would have blocked **every** approval until the SQL was applied. **This is fixed on this branch**: the route sends the 4th argument only when the screen has an edit counter, and the screen has one only when the database reported the 0280 columns. Evidence: route test "without a counter the 4th argument is not sent" and the PGlite test of the old database accepting the three-name call and refusing the four-name call.
- So push-first is also safe after that fix, but it leaves a period with no Edit button, which looks like a failed release. That is why SQL first is recommended.

**What not to do during the release**
1. Do not run `0241` (or `scripts/bench1_phase2_po_apply_0241.sql`) again after 0280. It puts back the older approve and revoke functions. If it happens, run 0280 again.
2. Do not approve, revoke or propose entitlements while part c runs and for one minute after.
3. Do not paste part b or c before part a, and do not apply anything before the backup file is saved.
4. Do not run `rollback.sql` after anyone has created a revision unless you accept that it closes every open revision (it says so in its header). Approved and already-replaced records are not touched.

### Production steps, in this order
1. **Backup.** Run `production_backup.sql` on production (it only reads), press Export to CSV, and keep the file outside the project. It holds every entitlement record.
2. **Precheck.** Run `production_precheck.sql`. It only reads. It must return 10 rows, every `result` PASS, including row 8 (two approved records) and row 6 (one approve function with three arguments). If any row says FAIL, stop and send me the rows.
3. **SQL.** Run `parts/0280a.sql`, `0280b.sql`, `0280c.sql`, one at a time, each pasted completely, each answering "Success. No rows returned".
4. **Verify.** Run `verify.sql`: 12 rows, all PASS. Also run the precheck again: it must now show FAIL on rows 2 to 6, which is correct and proves 0280 is in.
5. **Push** the merge commit (the exact command is in the release note I gave you). Amplify deploys.
6. **Smoke** on production once the deploy shows Deployed: open Market Index Data, Entitlements; you should see the two approved records, the "Show history" box, and Edit (needs approval) on each with your catalogue permission. Do not save a revision on a real benchmark unless you intend it; to see the flow without changing anything, open Edit and press Cancel.

### If something goes wrong
- SQL failed part way: send me the exact error text. Every part is safe to run twice.
- The screen misbehaves after the deploy: the previous deploy can be re-run from Amplify, and the old app works with the new database (evidence above), so the SQL does not need to be rolled back.
- Need to undo the SQL: `rollback.sql` (it keeps the new columns, which do no harm). The new app then simply hides Edit.
- Last resort: restore from the CSV backup. It contains every column, so the records can be re-inserted.

Evidence for this section is in `tests/unit/benchmarkEntitlementEditRevisionPglite.test.ts` and `tests/unit/benchmarkEntitlementEditProductionPrecheckPglite.test.ts`. PGlite-verified, not run on production.
