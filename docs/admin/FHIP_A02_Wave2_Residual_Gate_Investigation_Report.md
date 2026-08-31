# FHIP Admin A0.2 Wave 2 — Residual Gate Investigation Report

**Verdict: `CONDITIONAL PASS — NAMED ENVIRONMENTAL GATE REMAINS`**

Independently re-verified: worktree clean at `6f57d27` (unchanged — diagnostic only, no code changes), migration `0116` checksum unchanged (`aeac16c50a11e49707bad7e7086a5f91002d93346bd1d966edb475d21bf6882b`), PGlite certification reproduced exactly (325/325), zero residual diagnostic fixtures independently confirmed on DEV.

---

## 1. Branch / commit

`fix/admin-a02-wave2-workflow-ordering-integrity` @ `6f57d27c76406905aabe91fe8033a7c8d220a3ce` — **unchanged**. This was a diagnostic-only investigation; the one temporary file created (`scripts/_tmp_wave2_isolated_a3.mjs`) was deleted before finishing. `git status --short` is clean.

## 2. Migration 0116 checksum

`aeac16c50a11e49707bad7e7086a5f91002d93346bd1d966edb475d21bf6882b` — **confirmed unchanged**, matches the expected baseline exactly.

## 3. Reconciled test arithmetic

From a fresh, complete, untruncated harness run:

| Passed | Failed | Skipped | Total |
|---|---|---|---|
| 157 | 4 | 0 | 161 |

(161 independently verified by hand-counting every `check()` call site, including the four-content-type §B1 loop — arithmetic is sound, no denominator ambiguity.)

## 4. The previously-unnamed 4th failure

`A4: "stale client set (a link removed underneath) is rejected as a conflict"` — same failure signature as the three named A3 failures (`FAIL ... undefined: upstream request timeout`). It sits inside §A4 (real concurrency), not §A3, but reaches the identical SQL code path (see §6 below).

## 5. Three-round isolated negative-control evidence

Fresh script, fixture-only, own fixture setup/teardown, **zero concurrency**, run 3 consecutive rounds. **The negative controls did NOT pass cleanly in isolation — they failed 9/9 times**, never once delivering the intended SQLSTATE 40001:

| Round | Check | SQLSTATE | Message | Latency | DB variance |
|---|---|---|---|---|---|
| 1 | missing id | *(none)* | "upstream request timeout" | 125,196 ms | zero |
| 1 | foreign-source id | **42501** | "you do not have permission to manage Related Content" | 99,993 ms | zero |
| 1 | unknown id | **42501** | same | 207 ms | zero |
| 2 | missing id | *(none)* | "upstream request timeout" | 125,173 ms | zero |
| 2 | foreign-source id | *(none)* | "upstream request timeout" | 125,164 ms | zero |
| 2 | unknown id | *(none)* | "upstream request timeout" | 125,513 ms | zero |
| 3 | missing id | *(none)* | "upstream request timeout" | 125,181 ms | zero |
| 3 | foreign-source id | *(none)* | "upstream request timeout" | 125,188 ms | zero |
| 3 | unknown id | *(none)* | "upstream request timeout" | 125,502 ms | zero |

Combined with the full-harness run (4/4 same-signature failures), that's **13/13 live attempts across this investigation that failed to deliver the designed 40001 response**, with **0/13 partial writes** and **0/13 broken orderings** — zero database variance held every single time.

## 6. Error-origin analysis by system layer

- **RPC's own logic**: almost certainly correct. The PGlite certification (`admin_a02_wave2_certification.mjs`) exercises these exact same payload shapes against real PostgreSQL semantics in-process and passes (325/325). Live valid-payload calls using the *identical* `pg_advisory_xact_lock` + `SELECT...FOR UPDATE` code path (A2's reverse/swap, A4's two concurrent valid reorders) completed in milliseconds in the same live run. The failures correlate 100% with the specific branch that must run two extra SELECTs and find a *count mismatch* before raising 40001 — not with advisory-locking itself.
- **PostgREST**: no evidence of PostgREST doing anything wrong; it's a pass-through, and it correctly passed through the real 42501 codes for expected-forbidden cases elsewhere in the same run.
- **Harness code**: ruled out. A `grep` across `scripts/`, `lib/`, and `node_modules/@supabase` found zero occurrences of the literal string `"upstream request timeout"` anywhere in this codebase — it is not fabricated by any test script.
- **Gateway/connection-pool layer**: this is where it originates. Evidence:
  (a) 7 of 9 isolated timeouts clustered at 125.16–125.51 s — a ~350 ms spread across independent calls, a signature of a *fixed configured timeout*, not organic queueing jitter;
  (b) `error.code` is `undefined` for these, a shape no Postgres SQLSTATE ever produces;
  (c) two other active worktrees on this same machine (running unrelated concurrent certification work) point at this exact same DEV Supabase project — genuine shared-project connection/resource contention from unrelated concurrent load is a confirmed confound, not speculation.
- **A newly-found second failure mode**: 2 of 9 isolated calls (both in round 1, both following the first timeout) came back **fast** with SQLSTATE **42501** — the RPC's own "you do not have permission" message — for the *same* correctly-provisioned Resource Admin actor that succeeded moments earlier. This was never disclosed by prior runs (both only ever saw the timeout signature). This looks like transient connection/session-state corruption on a pooled connection recycled after an aborted request, though it cannot be proven without direct `pg_stat_activity`/`pg_locks` access, which is not available (no direct Postgres connection string in `.env.local`, no exposed introspection RPC in any migration).
- Confirmed via source read of `lib/resources/discovery/relatedAdmin.ts` and `app/api/admin/resources/related/reorder/route.ts`: **both failure shapes are handled safely** by the application — an unrecognized/undefined code falls to a generic 500, a 42501 falls to a fixed, safe 403 message — neither ever leaks a raw SQL error. The route never crashes under either symptom.

## 7. SQLSTATE 40001 design assessment

This is a **real, live-confirmed governance concern, not merely theoretical**. 40001 is conventionally `serialization_failure`, which some drivers/proxies are configured to auto-retry. No retry/timeout override was found anywhere in this codebase's Supabase client setup (`lib/supabase/server.ts`, the harness's own client construction) and no retry logic in the vendored `@supabase/postgrest-js` — so this application's own code is not the source of any retry behavior. That leaves Supabase's managed infrastructure (gateway/Supavisor) as the only remaining candidate, and the extremely tight ~125.2 s clustering across independent calls is consistent with *some* layer enforcing a fixed timeout specifically on the class of request that ends in this errcode's code path. It cannot be proven whether a literal "retry" is occurring versus a straightforward timeout on a contended connection, but: **the intended 40001→409 "refresh and retry" contract has never once been observed to complete live**, across 13 independent attempts. Worth flagging for a future revision (e.g., avoid overloading 40001 for a business-rule staleness check; a distinct, retry-safe-by-convention code, or an application-level pre-check, would sidestep whatever layer is treating 40001 specially) — but per the explicit scope boundary, the migration was **not** modified.

## 8. Full-harness re-run

**Not reached.** The precondition — "if and only if all isolated rounds pass cleanly" — was not met (9/9 isolated failures). Re-running the full harness again would not have added diagnostic value beyond confirming the same disclosed gap a third time at ~15 more minutes of cost, and risked adding more orphaned fixtures under continued external contention.

## 9. Two-connection concurrency (§A4) — distinct from the stale-conflict sub-case

**PASSED cleanly** in the full run — both same-source-simultaneous-valid-reorders and different-source-simultaneous-reorders resolved correctly, positions unique/contiguous, committed state was exactly one of the two valid orderings, never a blend. Only the embedded stale-conflict negative control (which shares the 40001 code path, not the core locking mechanism) failed.

## 10. Database before/after reconciliation

Full harness: `posts 410→410, links 79→79, published 42→42, scheduled 5→5, history 344→344` (audit grew by 7, expected/append-only). After the isolated run + manual sweep: same real-time check returned `posts=410, links=79, history=344, published=42, scheduled=5` — **exactly the same baseline**. Audit grew further (23,826→23,920), attributed to confirmed concurrent unrelated activity on this shared DEV project, not this testing (which wrote zero audit rows — all attempts were rejected before commit).

## 11. Fixture cleanup

The isolated diagnostic script had **a real bug in its own cleanup path** (`admin.from(...).delete(...).eq(...).catch is not a function` — a bug in the throwaway script, not a repo defect), which left **24 orphaned fixture posts and 1 orphaned fixture user** (prefix `a02w2-iso-...`) after it crashed mid-cleanup. This was caught immediately, manually swept, and **independently re-verified as zero residue** — both by the investigating agent and separately, again, by the orchestrating session (fresh query against DEV: `residual a02w2-iso- posts: 0`, `residual a02w2-iso users: 0`).

## 12. Changed-file diff

**No code changes — diagnostic only.** The one temporary file created (`scripts/_tmp_wave2_isolated_a3.mjs`) was deleted before finishing; `git status --short` on the worktree is clean and HEAD is unchanged from `6f57d27`.

## 13. Final verdict

**`CONDITIONAL PASS — NAMED ENVIRONMENTAL GATE REMAINS`**

**Precise limitation**: The RPC's own logic is sound (PGlite-certified, zero database variance across all 13 live attempts, and the identical locking mechanism succeeds fast under valid payloads in the same live runs). But the specific code path that requires `pg_advisory_xact_lock` + `SELECT...FOR UPDATE` followed by a completeness-mismatch (raising SQLSTATE 40001) has **never once, in 13 independent live attempts across two sessions, delivered its intended response to a real client** — it either times out at a strikingly consistent ~125.2 seconds (undefined code, "upstream request timeout"), or, in 2 of 9 isolated attempts, returns a spurious SQLSTATE 42501 for a correctly-provisioned actor. This is **not** an A4/concurrency-adjacency artifact — it reproduces identically with zero concurrency, in full isolation.

**Operational risk**: (a) a real editor hitting a genuinely stale link set in production would see the UI hang ~2 minutes and then get a generic error instead of a fast "refresh and retry" prompt; (b) the newly-found 42501 misclassification could mislead an on-call engineer investigating logs into suspecting a real authorization/grant defect.

**Required closure action**: obtain direct Supabase infrastructure visibility (`pg_stat_activity`/`pg_locks`, or a Supabase support engagement) to identify the exact ~125.2 s timeout source, and re-test this specific negative-control class in a window with no other concurrent load against this DEV project, before certifying it end-to-end.

---

## Scope discipline (confirmed)

- DEV only — no production access, no production migration, no production data action.
- No merge to main, no push, no deploy.
- No new migration created.
- Migrations `0107`/`0109` (approved Pattern B exceptions) untouched.
- No FDH, Analyst, navigation, audit-expansion, or other Admin work touched.
- The Pattern A privileged-RPC authorization design preserved exactly as-is.
- Every test fixture created was cleaned up, including the one that required manual recovery after a throwaway-script bug — independently re-verified zero residue.

## Next action

Do not merge, deploy, or start Wave 3 until the ~125.2 s timeout source is identified and this specific negative-control class passes at least once with no concurrent DEV load. This does not require re-litigating the RPC design (Pattern A remains correct and approved) — it requires environment-level diagnosis this role does not have the access to perform.
