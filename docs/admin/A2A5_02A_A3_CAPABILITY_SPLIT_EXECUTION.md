# A3.3 — `requireAdmin()` Capability Split, Execution: Detail Report

Cross-referenced from `A2A5_02_A3_STATUS.md` §2/§3. This is the one concrete A3 code deliverable in this dispatch, closing `A1_02_CAPABILITY_CATALOGUE.md`'s recorded CAP-16 Standard §2 violation.

## 1. What Standard §2 required, and why the old shape violated it

> "One broad boolean must never gate multiple, otherwise-unrelated Admin functions — if two capabilities happen to be granted to the same roles today, they are still two capabilities, not one, because a future change to one must not silently change the other."

`requireAdmin()` in `lib/services/adminAuth.ts` gated **35 route files across 3 unrelated functional domains** (Benchmarks: 10, Recommendations: 4, AI Admin: 20 — plus `account-deletions/route.ts`, which turned out on inspection to already use its own separately-named `requireAccountDeletionAdmin()` and never actually called the broad gate at all). This is precisely the pattern §2 prohibits.

## 2. What was built

`lib/services/adminAuth.ts` gained:
- `requireBenchmarksAdmin()` — CAP-16a.
- `requireRecommendationsAdmin()` — CAP-16b.
- `requireAIPlatformAdmin()` — CAP-16c.

Each is a two-line function that calls a shared private `requireNamedCapability()` helper, which in turn calls the original, completely unmodified `requireAdmin()`. **The authorization logic itself — the `admin_users` row check, the country-confirmation gate, the 401/403 semantics — was not touched anywhere.** This is a pure naming/structural change, matching `A1_20`'s own explicit design constraint: "new named capabilities that initially resolve identically to the old broad check."

## 3. Call-site changes

All 34 route files that called the generic `requireAdmin()` were mechanically renamed to their domain-scoped function (verified programmatically — see the exact per-file counts below). Zero other lines in any of these 34 files changed.

| Domain | Files | New function |
|---|---|---|
| `app/api/admin/benchmarks/**` | 10 | `requireBenchmarksAdmin` |
| `app/api/admin/recommendations/**` | 4 | `requireRecommendationsAdmin` |
| `app/api/admin/ai/**` | 20 | `requireAIPlatformAdmin` |

`app/api/admin/account-deletions/route.ts` was inspected and confirmed to already call its own `requireAccountDeletionAdmin()` (from `lib/services/accountDeletionAdmin.ts`, an LR-9 deliverable) — **no change was needed or made there.**

## 4. A line-ending mistake made and corrected during this same work session

The first attempt at this mechanical rename used a naive Python script that opened each file in **text mode** on Windows, which silently converts the repository's LF line endings to CRLF on write — this would have produced a 35-file diff where every single line appeared changed (pure noise, no functional difference, but a reviewer-hostile diff and a real risk of merge conflicts). It also incorrectly renamed a *comment* in `account-deletions/route.ts` that merely mentioned "bare `requireAdmin()`" in prose (there was no actual call to rename in that file). **Both mistakes were caught before commit** (by inspecting `git diff --stat`, which showed suspiciously large line counts for small changes) and fully reverted via `git checkout HEAD --`, then redone correctly with binary-mode file I/O. The final diffs are minimal (2-3 changed lines per file, matching the actual number of `requireAdmin()` occurrences in each). This is disclosed here per Programme Charter 9's evidence doctrine — an error caught and corrected within the same pass, not silently smoothed over.

## 5. Test evidence

New file `tests/unit/adminCapabilitySplit.test.ts`:
- **Behavioural equivalence** (parametrized across all 3 new functions): denies unauthenticated (401), denies authenticated non-admin (403), allows a real `admin_users` holder — all three functions produce byte-identical outcomes to the original `requireAdmin()` in each case.
- **Structural regression guard**: walks every `route.ts` under `app/api/admin/{benchmarks,recommendations,ai}` and asserts (a) it calls its expected domain-scoped function and (b) it contains zero occurrences of the bare word `requireAdmin` — this fails loudly if a future edit reintroduces the broad gate on any of these 34 routes.
- **Account-deletions non-regression**: asserts that route still calls its own pre-existing `requireAccountDeletionAdmin()` and never calls the broad gate.

Pre-existing `tests/unit/countryGateAdminAndHousehold.test.ts` continues to exercise the real `benchmarkSourcesGET` route handler end-to-end (imports and calls the actual exported route function, not a mock of the auth layer) and passed without modification — proof that the rename did not change the route's actual runtime behaviour.

Exact suite-wide pass/fail/skip arithmetic (this file plus the rest of the repository's test suite) is recorded in `A2A5_06_TERMINAL_HANDOVER.md` §2.

## 6. What is explicitly NOT proven by this evidence

- **Live-DEV, 9-caller-type matrix** (`A1_20`'s own "Test requirements" for this exact kind of gate-shape change) — blocked, no Supabase DEV credentials in this environment (see `A2A5_01`).
- **The other 44 `app/api/admin/**` route files** (Resources content/workflow, account-deletions) were not touched and were not re-verified as part of this specific change — they were not part of CAP-16's violation and carry no new risk from this pass, but no fresh direct-route probe was run against them either.

## 7. Verdict

**CONDITIONAL PASS.** Implementation is complete, minimal, and behaviourally inert (a rename, not a logic change) — the lowest-risk way to close a real, named Standard §2 violation. Unit-test evidence is real and passing. The live-DEV verification `A1_20` itself asks for this class of change remains blocked by environment, not by omission.
