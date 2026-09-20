# Rollback and Release Plan

## 1. Rollback readiness by change type

| Change | Rollback mechanism | Data-loss risk |
|---|---|---|
| Capability-split rename (34 files) | `git revert` the single commit (`1e38609`'s relevant hunks) — pure rename, no logic change, no migration | None — behaviourally inert change |
| PC6/PC7 nav-visibility fix | `git revert` | None |
| `taskHelp.ts`/`navigationRegistry.ts` additions | `git revert` | None |
| Migration `0165` | **Not applied anywhere** — rollback is simply never applying it. If ever applied to DEV and later needing reversal: `DROP TABLE IF EXISTS public.admin_audit_events, public.admin_security_events CASCADE;` — safe because nothing has ever written to either table | None (tables would be empty) |
| Documentation (`docs/admin/A2A5_*`) | `git revert`, or simply left in place (docs carry no runtime risk either way) | None |

**Every change in this dispatch is fully and safely revertible.** No change is one-way, no change requires a data migration to undo (since the one schema change was never applied), and no change touches a table with existing data.

## 2. Release readiness (Control Template 14 fields)

| Field | Status |
|---|---|
| Implementation | Integrated on `feature/admin-a2-a5-master-execution`, not integrated into `main` |
| Tests | Terminal pass for everything testable without live-DEV credentials (`A2A5_24`); live-DEV gates BLOCKED (`A2A5_09`, `A2A5_25`) |
| Security/privacy | No open blocker introduced by this dispatch's own changes (all additive/inert); A4's security-sensitive mechanisms are correctly NOT built rather than built-and-unverified |
| Rollback | Rehearsed by design (§1) — not rehearsed by an actual live drill, since nothing was ever applied to a live environment to drill against |
| Docs | Current — this entire `A2A5_*` set, cross-referenced and internally reconciled (`A2A5_29` §1 confirms no drift between docs and code) |
| Authority | Merge/deploy/migration-application authority is separately reserved to the Product Owner throughout — never assumed by this dispatch |

## 3. Monitoring plan, if ever merged and deployed

Since every code change in this dispatch is behaviourally inert (a rename, or an addition gated on an already-existing, already-tested capability check), there is no new runtime behavior to monitor beyond ordinary post-deploy smoke-testing of the 34 renamed routes' 401/403/200 responses — exactly the cases `tests/unit/adminCapabilitySplit.test.ts` already covers hermetically. No new alert, no new dashboard, no new on-call runbook entry is required by anything in this dispatch.

## 4. What a future pass's release plan would additionally need (not this dispatch's to write, since these features don't exist yet)

- A4.1–4.4 (once built): each needs its own rollback/disablement plan per `A1_20`'s own explicit requirement ("a feature flag or capability that can be flipped off without a schema rollback") — not written here because nothing has been built to flip off yet.
- A3.1 (scheduled publishing, once built): needs a fault-injection-tested rollback for a partially-failed scheduled job, per `A1_20`'s A3.1 rollback strategy.

## 5. Verdict

**Rollback readiness: PASS, by design, for everything actually built this pass.** Release readiness: every field in Control Template 14 has a real, non-fabricated answer — nothing is marked "ready" where it is not.
