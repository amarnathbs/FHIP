# A3.5 — Scheduled and Operational Workflows Migration

**Status: NOT STARTED.**

## Scheduling (ADM-10)

`admin/resources/content/scheduled/page.tsx` remains `hide-until-ready` (`A1_08` §6) — correctly non-functional-but-honest, exactly as before this dispatch. Building the actual scheduler requires:
1. A new database table (job queue) — a schema change requiring explicit Product Owner authorization before any DDL is drafted, per this mission's own §10.1 migration-authorization gate (applied by the same principle to any new schema, not literally only migration `0165`).
2. A worker/execution mechanism this repository does not currently have an established pattern for (confirmed by direct search: no existing background-job/queue-worker infrastructure exists in this codebase to extend).
3. A fault-injection test proving a job that fails partway does not leave content in an inconsistent published/unpublished state (`A1_20`'s own A3.1 test requirement) — not writable without the schema existing first.

None of this was started. No migration was even drafted for this feature (unlike migration `0165`, which was drafted-but-unapplied for A4.1/4.2) — judged lower priority than the capability-split work this dispatch actually completed, and explicitly recorded as the largest scoped-out A3 item in the original dispatch's own terminal handover, carried forward here unchanged.

## Operations (the nav area more broadly)

`A2_09_TEST_AND_REGRESSION_REPORT.md` (from the original A2 pass, live-tested by hermetic unit test) already established: "no persona ever sees Operations... no genuinely usable destination exists yet." This remains true — this dispatch added no Operations-area destination. There is no "migration" to perform for an area with no existing or proposed operational feature yet; the FDH-13 requirements that would eventually populate it (13 rows in `A1_16`'s Operations column, 0 Implemented / 4 Partial / 9 Missing) are part of the separately-authorized FDH-13 workstream (`A2A5_15`), not this dispatch's to build.

## Verdict

**NOT STARTED, correctly and explicitly** — both halves of this domain require either a new migration with Product Owner authorization (Scheduling) or a separately-authorized workstream with no current feature to migrate at all (Operations). Neither is silently incomplete; both are recorded here as explicitly out of this dispatch's authorized scope, matching `A1_20`'s own binding sequencing which places this domain (PO-8 step 5) last, after the FDH governance step this dispatch also correctly did not attempt.
