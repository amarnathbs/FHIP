# One "self" member per user: database guard (migration 0276), DEV hand-over

**Run on DEV `vqycarelcoijzwlpkpcz` first. Production is a separate decision, with the same steps.**

## What this is, and what it is NOT

During the DEV browser test the owner selector created **two "Self" household members for one person, 67 milliseconds apart**, and the selector then listed the person twice. The application now handles that, but only the database can make it impossible.

Migration 0276 adds **one** rule: *a person may have at most one active "self" row.*

**It does not limit the size of a household.** Read it carefully:

- The rule looks only at rows whose relationship is `self` **and** which are active.
- Spouse, partner, child, parent, other dependant and other rows are **outside the rule**. A household of 4, 6, 10 or more people works exactly as before. The proof test adds a self, a spouse, three children, a parent and a relative (7 people) and it is accepted.
- Removed members are not affected. Removing a member only marks it inactive, and inactive rows (self or not) are outside the rule, so a person can have as many removed rows as they like.
- I also checked the application: no code and no database constraint caps the number of household members. The only minimum anywhere is the retirement calculator wanting at least 2 retirement members, which is unrelated and unchanged.
- The migration changes no row. It adds one index. It can be run twice.

## Steps (SQL editor, one file per paste, in this order)

| # | File | What it does | Expected |
|---|---|---|---|
| 1 | `00_detect_duplicate_self_members.sql` | Read only. Lists any user with more than one active self row (ids cut to 8 characters). | **Zero rows.** On 07-10-2026 I read DEV through the API and found no duplicate left (54 self rows, 54 active, none doubled), so zero is expected. |
| 2 | `01_references_of_duplicate_rows.sql` | Read only. Only if step 1 listed someone: how many accounts, allocations, documents, publications and goals point at each duplicate. | Not needed if step 1 is empty. |
| 3 | `02_apply_0276_one_active_self.sql` | The migration (identical to `supabase/migrations/0276_...sql`). **If any duplicate exists it stops with a clear message and changes nothing.** | "Success". Running it a second time is also "Success". |
| 4 | `03_verify_index_and_household_sizes.sql` | Read only. Shows the new index and the five biggest households. | One `index` row; household sizes unchanged. |

Paste back the result grids of 00 and 03, and any red error text.

## If step 1 lists someone: merging or deactivating a duplicate safely

Do **not** delete a duplicate. Delete is blocked in places (`ii_ownership_allocation` points at members with ON DELETE RESTRICT) and would lose ownership history.

1. Run file 01. The row marked `KEEP (oldest)` is the one the application keeps.
2. A duplicate with **every count at 0** can simply be deactivated: set `is_active = false` on that one row (by its full id, which you get from the table, never by guessing from the 8 characters).
3. A duplicate that **is referenced**: tell me the user and I prepare a one-user, guarded, row-counting merge script (re-point accounts, allocations, documents, publications and goals to the oldest row, then deactivate the extra). Allocations are append-only by design (superseded, not edited), so I will not hand you a blind `update`.
4. Run file 00 again until it is empty, then run file 02.

## How the application stays consistent

`ensureSelfHouseholdMember` already settled on the oldest row. With the index in place a racing insert now fails with a unique violation (code 23505); the code catches that and returns the row that won, so the person never sees an error. The Household members route also answers that case with a plain 409 sentence instead of a database message.

## What was proved before this hand-over (not on DEV)

`scripts/owner_before_upload_0276_self_unique_pglite_verification.mjs`: real PostgreSQL in memory, the repository's own migration chain up to 0275, then 0276: the guard refuses (and changes nothing) while a duplicate exists; after the duplicate is deactivated it applies; a second active self is refused; a self plus a spouse, three children, a parent and a relative (7 members) is accepted; an inactive self next to an active one is accepted; reactivating an inactive self while another active one exists is refused; two users each have their own self; the migration is idempotent; the shipped file is byte-identical to the one in this folder. Named negative controls: with the index dropped the same two-self insert IS accepted, so the index is what refused it.
