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
3. Apply the **SQL first, then deploy the branch**. If the branch is deployed first the screen simply hides the Edit controls (it detects the missing columns) and nothing breaks.
4. **Do not run `0241` again after `0280`.** `0241` would put back the older three-argument approve function and the older revoke function. If that ever happens, run `0280` again (it is safe to run twice and repairs both).
5. Migration number: `0280`. I scanned every branch, tag and worktree on this machine (872 refs, 180 worktree folders); the highest number found is `0279` (promo hardening release). `0260-0263` and `0269-0271` are NAV2, `0272-0274` are the bulk upload branch. One remote ref could not be fetched ("doclife"), so please tell me if you know of another branch holding a migration above `0279`.

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
