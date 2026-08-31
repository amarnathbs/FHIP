# Admin A0.2 Wave 2 — Workflow & Ordering Integrity — Terminal Report

**Verdict: `CONDITIONAL PASS`** (Product Owner's own framing, carried forward
unchanged): implementation and core concurrency proven; the fixed
negative-control contract is now proven **locally** but **not yet proven
live**.

**This report supersedes both prior Wave 2 documents.** It is the
authoritative status of Admin A0.2 Wave 2 as of this round:

- `docs/admin/A02_WAVE2_WORKFLOW_ORDERING_INTEGRITY_CERTIFICATION.md` — the
  original, pre-DEV-application certification (Pattern A, 325/325 PGlite at
  the time). Superseded: its §9 "outstanding gate" (DEV application) is now
  additionally blocked on the fix delivered in this round, and its SECTION 4/5
  negative-control assertions (`40001`) are stale — the code no longer raises
  that SQLSTATE.
- `docs/admin/FHIP_A02_Wave2_Residual_Gate_Investigation_Report.md` — the
  diagnostic-only investigation that found the live negative controls never
  once delivered their intended response. Superseded: it correctly diagnosed
  the problem and correctly declined to modify code under its own mandate,
  but it is not the final word — this report is, because it contains the
  actual fix that investigation's own §7 recommended and the Product Owner
  then directed.

Neither prior document should be read as authoritative for Wave 2's current
state. This one is.

---

## 1. What this round did, in one paragraph

The residual-gate investigation found that 0116's stale/incomplete-link-set
conflict branch — which deliberately raises SQLSTATE `40001`
(`serialization_failure`) — never once delivered that response to a real
client across 13 independent live-DEV attempts, timing out at a consistent
~125.2s instead. The Product Owner ruled to revise the conflict contract away
from the `40xxx` family. This round authored a new, forward-only migration —
`0118` — that changes `admin_reorder_related_content`'s two conflict `RAISE`
statements from `errcode = '40001'` to `errcode = '55000'`
(`object_not_in_prerequisite_state`, Class 55 — not Class 40, and already this
codebase's own precedent for analogous state-conflict errors), updated the
one line of application code that maps that SQLSTATE to the `'conflict'`
kind, adapted and extended the PGlite certification and the live-DEV harness
to match, and re-ran local certification. **0118 has not been applied to
DEV** — this environment has no DDL capability against any hosted Supabase
project, exactly as every prior round.

---

## 2. Carried forward from `1cdd411`, not re-litigated

The file-count correction already committed stands: the original
certification's diff is **18 files, not 17** — see §8.1 of the original
certification report and commit `1cdd411`. This round adds four more files on
top of that 18 (§7 below); it does not reopen or recount that correction.

## 3. Carried forward from the residual-gate investigation, cited not re-derived

From `docs/admin/FHIP_A02_Wave2_Residual_Gate_Investigation_Report.md`:

- **Reconciled arithmetic**: 157 passed / 4 failed / 0 skipped = **161** total
  live-harness checks, hand-counted against every `check()` call site
  including the four-content-type §B1 loop.
- **The previously-unnamed 4th failure**: `A4: "stale client set (a link
  removed underneath) is rejected as a conflict"` — same failure signature as
  the three named §A3 failures (`FAIL ... undefined: upstream request
  timeout`), reached via the identical SQL code path as §A3 even though it
  sits inside §A4 (real concurrency), not §A3.
- **13/13 live attempts** across two sessions (a full-harness run and three
  isolated, zero-concurrency rounds) never once delivered the intended
  `40001` response: 11 timed out (~125.2s, `error.code: undefined`) and 2
  returned a spurious `42501` for a correctly-provisioned actor.
- **Zero database variance** held in all 13 attempts — no partial writes, no
  broken orderings, regardless of how the request failed.
- **Origin analysis**: the RPC's own logic was cleared (PGlite-certified;
  the identical locking mechanism succeeds in milliseconds under valid
  payloads in the same live runs); no retry logic exists anywhere in this
  application's own code; the failure correlates 100% with the specific
  branch that raises `40001` after a completeness-mismatch, pointing at
  Supabase's managed infrastructure (gateway/Supavisor) treating Class 40
  specially, not at this codebase.

This round does not re-run those 13 live attempts — it cannot, without DEV
DDL access to apply the fix first. It treats that evidence as settled and
acts on the Product Owner's ruling built from it.

---

## 4. The fix — exactly what changed and why

### 4.1 The SQLSTATE/contract change

| | Before (0116) | After (0118) |
|---|---|---|
| Stale/incomplete-set conflict | `errcode = '40001'` (×2 `RAISE` sites) | `errcode = '55000'` (×2 `RAISE` sites, same sites) |
| SQLSTATE class | Class 40 — Transaction Rollback (`serialization_failure`) | Class 55 — Object Not In Prerequisite State |
| Conventional retry semantics | Some drivers/proxies auto-retry Class 40 by convention | None — 55000 carries no such convention |
| Message text | Unchanged | Unchanged |
| `app` mapping (`REORDER_ERROR_KINDS`) | `'40001': 'conflict'` | `'55000': 'conflict'`; `'40001'` removed (falls through to `'error'` if ever seen) |
| Client-visible HTTP contract | 409, "refresh and try again" | **Unchanged** — still 409, same message |
| Every other branch, grant, lock, check | — | **Byte-for-byte unchanged** |

**Why `55000` and not an invented custom code.** The guidance allowed either
a PostgreSQL-reserved application range (`70000`–`99999`, `P0001`-class) or a
distinct application-level signal the route already parses. `55000`
(`object_not_in_prerequisite_state`) was chosen instead of inventing a new
code because:

1. It is a **real, standard PostgreSQL SQLSTATE**, not an ad hoc string —
   Class 55 is precisely "the object is not in the state this operation
   requires," which is exactly what a stale/incomplete link set is.
2. It is **already this exact codebase's own convention** for the same shape
   of problem: `supabase/migrations/0084_geo_jurisdiction_smsf.sql` and
   `supabase/migrations/0090_smsf_current_balance_integrity_guard.sql` both
   raise `55000` for "fund is already in detailed/summary mode" state
   conflicts (confirmed by direct `grep` — see §4.2). Following an existing,
   already-reviewed precedent is lower-risk than introducing a new
   convention for one RPC.
3. It is **unambiguously outside the `40xxx` family**, satisfying the
   Product Owner's requirement directly.

### 4.2 Precedent confirmed by direct search

```
$ grep -rn "errcode = '" supabase/migrations/ | grep -viE "'(22023|23514|23505|42501|P0002|40001|08006|42883)'"
supabase/migrations/0084_geo_jurisdiction_smsf.sql:477:  ... using errcode = '55000';
supabase/migrations/0089_smsf_switch_to_summary.sql:60:  ... using errcode = '55000';
supabase/migrations/0090_smsf_current_balance_integrity_guard.sql:195: ... using errcode = '55000';
```

No other custom/non-standard SQLSTATE convention exists anywhere else in this
project's migrations.

### 4.3 Files changed

| File | Change |
|---|---|
| `supabase/migrations/0118_admin_a02_wave2_reorder_conflict_errcode_fix.sql` | **New.** `CREATE OR REPLACE FUNCTION public.admin_reorder_related_content` — identical body to 0116's except the two `errcode` literals, plus an updated `COMMENT ON FUNCTION`. No grant, schema or data statement. |
| `lib/resources/discovery/relatedAdmin.ts` | `REORDER_ERROR_KINDS['55000'] = 'conflict'` (was `'40001'`); `'40001'` removed so an unexpected sighting of it falls through to the generic, logged `'error'` kind rather than being silently trusted as a deliberate conflict. |
| `app/api/admin/resources/related/reorder/route.ts` | **Not changed.** It switches on `result.kind`, never on a raw SQLSTATE, so the `'conflict'` → 409 mapping needed no edit — confirmed by reading the file; see §4.4. |
| `scripts/admin_a02_wave2_certification.mjs` | SECTION 4/5 negative-control cases updated to expect `55000`; pre-Wave-2 baseline build now excludes both `0116` and `0118`; SECTION 10 restores the fix on `db` after re-applying 0116 alone; new **SECTION 11** proves the fix's narrow scope and idempotency (see §5.2). |
| `scripts/admin_a02_wave2_live_dev_verification.mjs` | The three isolated §A3 cases and the §A4 stale-conflict case now expect `55000`. **Not run in this round** (0118 is not on DEV) — updated so it is ready for the Product Owner's next live run. |
| `tests/unit/resourcesRelatedReorder.test.ts` | The classification test now asserts `55000 → 'conflict'`; `'40001'` moved into the "unexpected SQLSTATE → generic error" table as a forward regression pin. |

### 4.4 Why the API route needed no change

`app/api/admin/resources/related/reorder/route.ts` never inspects a raw
PostgreSQL SQLSTATE. It calls `reorderRelatedContent()`, which returns a
`ReorderResult` discriminated on a small, named `kind` — `'invalid' |
'not_found' | 'conflict' | 'forbidden' | 'error'` — and the route switches
only on `result.kind`:

```ts
case 'conflict':
  return bad('The related items for this Resource have changed since this list was loaded. Refresh and try again.', 409);
```

The SQLSTATE-to-`kind` translation happens in exactly one place —
`REORDER_ERROR_KINDS` in `lib/resources/discovery/relatedAdmin.ts` — which is
the only file that changed on the application side. The external contract
(status code, message, response shape) is untouched by construction, not
merely by inspection.

---

## 5. Fresh PGlite certification results (this round)

### 5.1 Headline

```
$ node scripts/admin_a02_wave2_certification.mjs
...
================ RESULT: 352 passed, 0 failed ================
```

Independently re-counted, not just trusted from the script's own tally:

```
$ grep -c "^  PASS" <output>   ->  352
$ grep -c "^  FAIL" <output>   ->  0
```

**352/352, up from 325/325** at the prior certification. The delta (+27) is
entirely SECTION 11 (new, 26 checks) plus one restoration check appended to
SECTION 10 (see §5.2) — every one of the 325 prior checks still exists and
still passes; none were removed, only four had their *expected SQLSTATE
literal* updated from `40001` to `55000` (two in SECTION 4, two in SECTION
5), which is the fix's own intended effect, not a weakening of the check.

### 5.2 What SECTION 10 and the new SECTION 11 prove

**SECTION 10** (idempotency) previously re-applied 0116's own file verbatim
to prove *0116* is idempotent — which, applied alone, genuinely regresses the
conflict branch back to raising `40001` (that is what "0116 unmodified"
means). This round added one line: re-apply `0118` immediately afterward, so
the shared `db` instance used throughout the script is left in the correct,
fully-fixed state, and added an explicit check that the restoration worked
(`0118 re-applied after 0116 restores the 55000 fix on 'db'`).

**SECTION 11** is new and does five things, each measured against a real,
independently built PostgreSQL database (`buildDbPreHotfix()` — 0116 applied,
0118 not applied — the exact pre-hotfix state), not asserted from reading the
diff:

1. **Before/after source-text proof**: the pre-0118 function body contains
   exactly two `errcode = '40001'` sites and zero `'55000'` sites; after
   applying 0118 on top, exactly two `'55000'` sites and zero `'40001'`
   sites.
2. **Narrow-scope proof**: `admin_reorder_related_content`'s ACL,
   `search_path` and `SECURITY DEFINER` posture are byte-identical
   before/after 0118, and it still exists exactly once (not forked). The
   Pattern A grant model (`authenticated` granted; `anon`/`service_role` not)
   is re-verified on the post-0118 function.
3. **"Touches nothing else" proof**: `transition_resource_post_status`'s ACL,
   `search_path` **and full source body** are byte-identical before/after
   0118 is applied, and the same for `private.can_manage_discovery`.
4. **Live behavioural proof**: a real incomplete link-set reorder, executed
   through the RPC by a genuine, freshly created `resource_admin` session on
   this database, is rejected with SQLSTATE `55000` (not `40001`), the exact
   same message text as before, and zero database variance.
5. **Idempotency of 0118 itself**: re-applying `0118` alone a second time
   causes zero data variance and leaves exactly two functions in `public`
   (no duplicate overloads).

### 5.3 Focused unit tests

```
$ npx vitest run tests/unit/resourcesRelatedReorder.test.ts tests/unit/resourcesSchedulingValidation.test.ts tests/unit/adminA02Wave2CapabilityMatrix.test.ts
 Test Files  3 passed (3)
      Tests  87 passed (87)
```

87, up from the prior 86 — the one addition is the `40001`-is-now-unexpected
regression pin in `resourcesRelatedReorder.test.ts`.

### 5.4 Other gates

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | Clean |
| ESLint on every file touched this round (5 files, incl. the new `.sql`) | 0 errors (the `.sql` file produces the expected "no matching configuration" info-level notice; ESLint does not lint SQL) |
| `node scripts/check-migration-versions.mjs` | `OK: 104 active migrations, one file per version, next version is 0119.` |
| `node scripts/check-migration-versions-against-branch.mjs --against=origin/main` | `OK: no cross-branch migration collisions` (run post-commit, against committed `HEAD`) |
| `npm run build` | **Confirmed: exit code 0.** Full production build completed clean, all routes compiled (static + dynamic), no errors. |

### 5.5 Migration-number re-verification, done fresh (not assumed)

Per the dispatch's explicit instruction to re-verify `0118` is free rather
than trust the prior scan:

```
$ node scripts/check-migration-versions.mjs
OK: 103 active migrations, one file per version, next version is 0117.
$ node scripts/check-migration-versions-against-branch.mjs --against=origin/main
OK: no cross-branch migration collisions ... HEAD (103 files) vs origin/main (111 files).
```

Then an exhaustive scan of **every worktree on this machine** for a
`0117`/`0118` migration file, and **every local and remote-tracking git ref**
for the same:

```
$ for wt in $(git worktree list | awk '{print $1}'); do
    find "$wt/supabase/migrations" -maxdepth 1 \( -name "0117*" -o -name "0118*" \)
  done
HIT: D:/fhip-module11-2/supabase/migrations/0117_module11_2_deterministic_answer_router.sql

$ for ref in $(git for-each-ref --format='%(refname)'); do
    git ls-tree -r --name-only "$ref" -- supabase/migrations | grep -E "01(17|18)"
  done
REF refs/heads/feature/module-11-2-deterministic-answer-router:
  supabase/migrations/0117_module11_2_deterministic_answer_router.sql
```

**Result: `0117` is claimed only by the unmerged Module 11.2 branch (local
branch and its own worktree; no remote-tracking ref for it was found — that
branch has not been pushed). No `0118` file exists anywhere.** This confirms
the orchestrating session's fresh scan: `0118` is genuinely free.

---

## 6. Migration `0118` — filename and checksum

`supabase/migrations/0118_admin_a02_wave2_reorder_conflict_errcode_fix.sql`

SHA-256: `ca870d009e2d3b06fe5a8cd326300bacbacf9733f5f90ca90580c32d343b2feb`

`0116`'s own checksum is re-confirmed **unchanged** in this round —
`aeac16c50a11e49707bad7e7086a5f91002d93346bd1d966edb475d21bf6882b` — matching
every prior report exactly. `0116`'s file was not touched.

---

## 7. Scope and diff, this round

Four files changed/added on top of the 18-file baseline from `1cdd411`:

```
supabase/migrations/0118_admin_a02_wave2_reorder_conflict_errcode_fix.sql   (new)
lib/resources/discovery/relatedAdmin.ts
scripts/admin_a02_wave2_certification.mjs
scripts/admin_a02_wave2_live_dev_verification.mjs
tests/unit/resourcesRelatedReorder.test.ts
docs/admin/FHIP_A02_Wave2_Terminal_Report.md                                (new — this file)
```

No Recommendations file, no FDH/Analyst/navigation file, no other Admin
migration, no unrelated code. `0107`/`0109` untouched. `0116`'s own file
untouched.

Commits this round: `8f33074` (migration), `067caa5` (code + tests +
certification script), `3057393` (live-DEV harness update).

---

## 8. Broader regression check

Ran the full non-live-tagged unit suite (`tests/unit`, 177 files, 3826
tests) once, in parallel, as a scoped sanity check (not the full 12-file
live-DEV sweep the original certification separately measured — that
exercise stands as already done and is not re-litigated here):

```
Test Files  2 failed | 174 passed | 1 skipped (177)
     Tests  2 failed | 3819 passed | 5 skipped (3826)
```

Both failures are in files that hit the **live shared DEV Supabase**
(`resourcesR1_1.test.ts`, `resourcesAdminR1_2.test.ts`) — neither file is
touched by this round's diff, and neither exercises
`admin_reorder_related_content`, `resource_related_content`, or anything
this round's code change reaches. Re-run in isolation (`--no-file-parallelism`,
no other live-DEV files contending for the same shared project):

- `resourcesR1_1.test.ts`'s one failure reproduced identically —
  `Error: Test timed out in 5000ms` on a live-DEV network round trip. This is
  the exact same pre-existing, already-documented flake from the original
  certification's own §7.3 ("a network-latency timeout against live DEV,
  present on `origin/main`, unrelated to Wave 2").
- `resourcesAdminR1_2.test.ts`'s failure (`expected 256 to be 254`, a
  dashboard draft-count assertion) **passed cleanly** when isolated from
  parallel contention — confirming it was fixture-count drift from other
  live-DEV test files racing on the same shared project during the parallel
  run, not a real regression.

Neither failure is attributable to this round's change. Both are consistent
with the shared-DEV-project contention this exact investigation already
identified as a confirmed confound (§6 of the residual-gate report).

---

## 9. What remains open — the live-DEV gate, honestly stated

**The live-DEV negative-control contract remains NOT YET terminally
certified.** This round closed the **code-fix gap** — the RPC now raises a
SQLSTATE with no conventional retry semantics, proven correct and narrowly
scoped against real PostgreSQL via PGlite. It did **not**, and could not,
close the **live-proof gap**: whether the ~125.2s timeout actually
disappears against real Supabase-managed infrastructure once this exact
fix is live. That can only be shown by running the request against DEV
itself.

**This environment has no DDL execution capability against any hosted
Supabase project** — only PostgREST, which cannot run DDL — exactly as every
prior round. `0118` cannot be applied by this session.

### Named, closable-in-one-step next action

1. Apply `supabase/migrations/0118_admin_a02_wave2_reorder_conflict_errcode_fix.sql`
   to **DEV only**, via the Supabase Dashboard SQL editor (SHA-256
   `ca870d009e2d3b06fe5a8cd326300bacbacf9733f5f90ca90580c32d343b2feb`).
2. Run `node scripts/admin_a02_wave2_live_dev_verification.mjs > wave2-live-2.txt 2>&1`
   (do not pipe through `head` — the prior investigation found this kills the
   process before its own cleanup step and leaks fixtures).
3. Confirm the three §A3 cases and the §A4 stale-conflict case now return
   `55000` rather than timing out, and that the reconciliation block shows
   zero variance.

Nothing else is required to move Wave 2 past CONDITIONAL PASS.

---

## 10. Verdict

**CONDITIONAL PASS** — the Product Owner's own framing, unchanged in kind
from before this round: implementation and core concurrency are proven (0116
unmodified; the two-connection concurrency proof in the original
certification's §4.5/§A4 stands as-is). What has changed is which half of the
negative-control contract is proven: **the fixed contract (SQLSTATE 55000,
narrow scope, zero regressions) is now proven locally**, against real
PostgreSQL via PGlite, with 352/352 passing. **It is not yet proven live** —
that requires DEV DDL access this session does not have, and is the single,
named, closable-in-one-step action in §9.

No merge, no push, no production action, no Wave 3 work. Awaiting Product
Owner review and, when ready, manual application of `0118` to DEV.
