# AIE-1 Closure — PC5 Consumption Interface (mission section 11)

## Headline: interface + contract COMPLETE and real-DEV VERIFIED. End-to-end PC5 integration is BLOCKED — PC5 does not exist in this codebase.

## 1. Discovery

Exhaustive search (grep across `lib/`, `app/`, `docs/`) found **no PC5
table, route, service, or module anywhere in this repository.** PC5 is
referenced only as a future roadmap name:

- `docs/investment-intelligence/II_PC4_STATUS_2026_09_07.md:138` defines it
  as Investment Intelligence's own planned "owner/reconciliation resolution
  workflow" phase (PC4 → PC5 → PC6 → PC7) — not started.
- `docs/aie-programme/AIE_1_MASTER_PLAN.md:121`'s binding architectural rule
  is: "PC5 single-source-of-truth for exceptions — no second exception/
  unresolved-item system anywhere for PC5 or an adapter."
- `lib/aie/review/featureFlags.ts` defines `isAieReviewPc5ProjectionEnabled()`
  reading `AIE_REVIEW_PC5_PROJECTION_ENABLED`, with its own comment: "a
  governed AIE query/view for PC5 is NOT built this pass." The flag exists
  with no consumer behind it — confirmed still true as of this closure pass.

**Conclusion, per the mission's own instruction ("If PC5 is unavailable,
complete the interface and contract verification, but mark end-to-end PC5
closure blocked. Do not label a stub as completed integration."):** this
mission builds and verifies the AIE-side interface a future PC5 would call,
against real DEV infrastructure, and states plainly that no real PC5
consumer exists to complete the loop with.

## 2. What was built

`lib/aie/pc5/pc5ExceptionInterface.ts` — two functions:

- `listUnresolvedItemsForPc5(callerId, targetUserId, deps)` — a thin,
  capability-gated wrapper over the EXISTING `repo.listOpenUnresolvedItemsForUser`.
- `resolveUnresolvedItemForPc5(params, deps)` — a thin, capability-gated
  wrapper over the EXISTING `decideOnItem` (AIE-1.5's "the ONE path an
  item's status can change through").

**No new table, no new status vocabulary, no new lifecycle.**
`aie_unresolved_item` remains the single source of truth; nothing here
projects, caches, or duplicates it. This satisfies the mission's explicit
"do not create a parallel PC5 exception database or divergent lifecycle."

**Capability check is injected, not invented.** Since PC5 doesn't exist,
this mission has no real capability/permission model to hard-code —
inventing one would itself be "labelling a stub as completed integration."
`Pc5ExceptionInterfaceDeps.checkCapability` is a required parameter; the
real PC5 module, whenever built, supplies its own genuine check. Tenant
scoping is enforced as a SECOND, independent layer regardless (every
underlying query is scoped by `targetUserId`) — proven below.

## 3. Real DEV verification

`scripts/aiecl_pc5_interface_live_dev_check.ts` (`npx tsx
scripts/aiecl_pc5_interface_live_dev_check.ts`), run against the real DEV
Supabase project, importing the real `lib/aie/pc5/pc5ExceptionInterface.ts`
module directly (not a mock) via `tsx`'s `@/` alias resolution — real rows
in `aie_document_intake`/`aie_extraction_run`/`aie_unresolved_item`, two
real disposable synthetic DEV users (owner + attacker), real `Promise.all`
concurrency.

**16/16 checks passed:**

1. Owner can list their own unresolved items.
2. Cross-tenant list denied by the capability layer.
3. Cross-tenant resolve denied by the capability layer.
4. **Second independent tenant-scoping layer proven**: even with the
   capability layer forced to allow everything, resolving under the WRONG
   `targetUserId` finds nothing (`not_found`) — the underlying
   `decideOnItem` query is itself scoped by `(itemId, userId)`, so a
   capability-layer misconfiguration alone cannot leak cross-tenant access.
5. Stale itemVersion → `stale_conflict`, never silently applied.
6. Nonexistent/deleted item id → `not_found`, never a crash or false
   success.
7. **Six genuinely concurrent (`Promise.all`) calls sharing one idempotency
   key** all report success, but independently verified via direct DB
   query: exactly ONE `aie_review_decision` row was created, and the item's
   `item_version` advanced exactly once (1→2), not six times — real
   idempotent collapse under real concurrent load, not sequential replay.
8. Resolving the same item again with the OLD (pre-resolution) version →
   `stale_conflict` — an already-resolved item cannot be re-resolved.
9. Final DB state independently confirmed correct (`status: 'deferred'`).
10. **Zero residue**: both synthetic users and every row they touched
    (`aie_unresolved_item`, `aie_extraction_run`, `aie_document_intake`)
    independently re-verified gone via fresh queries after cleanup.

## 4. What this does and does not close

**Closed for real**: the AIE-side interface a PC5 consumer would call is
implemented, reviewed, and proven correct against real DEV infrastructure —
tenant isolation (two independent layers), capability gating, idempotent
concurrent resolution, stale-conflict rejection, and not-found handling for
deleted/expired items all genuinely work.

**Not closed, and cannot be from this side alone**: there is no real PC5
caller. "Failed downstream actions" (mission section 11's own required
test scenario — e.g. what happens if PC5's own database write fails after
AIE's resolution succeeds) cannot be tested without a real PC5 write path
to fail. This is not a gap in AIE's interface; it is the literal absence of
the other half of the integration. **End-to-end PC5 closure remains
BLOCKED pending PC5 itself being built** — this report should not be read,
and does not claim, otherwise.
