# Admin A0.2 Wave 2 — Workflow & Ordering Integrity

**Technical certification report**
**Date:** 2026-08-31
**Branch:** `fix/admin-a02-wave2-workflow-ordering-integrity`
**Worktree:** `D:\fhip-a02-wave2`
**Base:** `origin/main` @ `1b40b0be0bbb6b7d67b611e08ca255e68562abf1`
**Migration:** `0116_admin_a02_wave2_related_reorder_and_scheduling_integrity.sql`
SHA-256 `2da81ecd155e83c0c5ee2a9f5a41d13b6071b78bbd71ae74df300c2a00b8c355`

**Verdict: CONDITIONAL PASS — CODE COMPLETE, NAMED GATE OUTSTANDING.**
The single outstanding gate is named in §9: migration `0116` has not been
applied to DEV, because no environment in this workspace can execute DDL
against a hosted Supabase project. Everything that does not depend on that
application is complete and certified.

---

## 1. Scope

Exactly two items, per the Wave 2 brief. Nothing else was changed.

| # | Item | Status |
|---|---|---|
| A | Related Content reorder atomicity | Implemented, certified locally, live-DEV gate outstanding |
| B | Scheduling-validation alignment across all four Resources content types | Implemented, certified locally, live-DEV gate outstanding |

Wave 1 / Wave 1B Recommendations work was not touched. Diff against
`origin/main` contains no Recommendations file.

---

## 2. Start gate

| Check | Result |
|---|---|
| `origin/main` at session start | `5ba55047e70d8803f9cdd567f067917253a4f022` |
| `origin/main` at report time | `1b40b0be0bbb6b7d67b611e08ca255e68562abf1` — advanced mid-wave with Wave 0's Admin Architecture Standard (documentation only: `AGENTS.md`, `CLAUDE.md`, `SECURITY.md`, the PR template, and `docs/admin/FHIP_ADMIN_ARCHITECTURE_STANDARD.md`; **no code, no migrations**). Branch rebased onto it cleanly, zero conflicts. |
| `origin/main` contains Wave 1/1B | Yes — merge `c404787` |
| Production landing page | HTTP 200 |
| Production `/admin/recommendations` | HTTP 307 → `/login` (auth gate intact) |
| Production recommendations | **562** — matches the stated baseline |
| Production active recommendations | **562** — matches |
| Production recommendation conditions | **2,183** — matches |
| Production migration `0107` | Live and functional. `admin_import_recommendation_conditions({"groups":[]})` returned `{"codes": [], "conditionsInserted": 0, "conditionsReplaced": 0, "recommendationsAffected": 0}` — a real no-op from the real function body, zero rows touched. |
| Production migration `0109` | Live and functional. `admin_upsert_recommendation_atomic` returned its own validation error (`22023`, "recommendation_code is required to create a recommendation"), i.e. the call reached the function body. |
| Wave 1/1B branch reuse | None — a new branch and worktree were used |

### 2.1 Amplify deployed-SHA confirmation — reported honestly, not claimed

The brief's stop condition is "if the deployed commit cannot be confirmed,
stop and report that Wave 2 remains blocked." Here is exactly what could and
could not be established.

**Could not be established:** the deployed commit SHA. There is no Amplify
console access in this environment. The production site exposes no build
identifier — no Next.js `buildId` appears in the served HTML, and the only
response headers available are CloudFront's (`ETag: "7e5263u1wevgg"`,
`X-Amz-Cf-Pop: MEL61-P1`), none of which map to a git SHA.

**Why no external probe can close this gap:** every file changed by the Wave
1/1B merge `c404787` is behind admin authentication —
`app/api/admin/recommendations/**`, `components/admin/AdminRecommendationsClient.tsx`,
`lib/engines/recommendations/matcher.ts`, two `lib/services/**` validators,
the two migrations, certification scripts and unit tests. There is **no
unauthenticated public surface that differs** between the pre-Wave-1 build
and the post-Wave-1 build, so no anonymous HTTP probe can distinguish them
even in principle.

**What was positively established instead:** production is healthy; the auth
gate behaves correctly; and both Wave 1/1B migrations are *live in the
production database* and executing their real function bodies, with counts
exactly at the stated baseline and zero variance caused by the probes.

Per the dispatch's explicit instruction, this is reported for the Product
Owner to rule on rather than being treated as either a silent block or a
silent pass. **Nothing in Wave 2 has been deployed, merged or applied to
production**, so the residual risk of proceeding on this evidence is
confined to the possibility that a DEV-only, unmerged branch was built on a
slightly stale assumption about production's front-end build — which no Wave
2 artefact depends on.

---

## 3. Migration-number collision control

`0116` was allocated after a full scan, not assumed. Scan surfaces: current
`origin/main`; every local and remote-tracking ref via `git ls-tree`; the
on-disk `supabase/migrations/` of every active worktree including untracked
files; the loose `_tmp_migration_*.sql` hand-off files in the Product
Owner's working tree; and the migration registry itself, including a sweep
for reservations above `0115` (the only hit was `0119` inside a prior *scan
range* description — not a reservation).

The full collision matrix is recorded in
`docs/architecture/MIGRATION_REGISTRY.md` under "Admin A0.2 Wave 2". Summary:
`0106`-`0109` are in `main`; `0108`/`0111` belong to MCC; `0110` to Module
11.0; `0112`-`0114` to FDH-12 (treated as allocated regardless of the
reported doubt about whether `0113`/`0114` are actually in effect on DEV);
`0115` to Module 11.1. **`0116` was free on every surface scanned.**

Both repository tools agree:

- `node scripts/check-migration-versions.mjs` → "OK: 103 active migrations, one file per version, next version is 0117."
- `node scripts/check-migration-versions-against-branch.mjs --against=<ref>` → zero cross-branch collisions against `origin/main` **and** all seven other migration-carrying branches (Module 11.0, Module 11.1, MCC, FDH-11, FDH-12, G0-JA-1 Wave 2, Admin A0.2 Wave 1).

No other workstream's migration was reused, overwritten or renumbered.

The registry's own stale header ("Next free version: `0064`", "63 active
migrations") was corrected in the same change, because leaving it beside a
new `0116` allocation would actively mislead the next allocation. The
correction is labelled as such.

---

## 4. Scope A — Related Content reorder atomicity

### 4.1 The original defect, reproduced before any code was written

**Route:** `PATCH /api/admin/resources/related/reorder`
**Function:** `reorderRelatedContent()` in `lib/resources/discovery/relatedAdmin.ts`
**Table:** `resource_related_content` (column `sort_order`)
**Client response on failure:** HTTP 500, `"Could not reorder related content."`

The pre-Wave-2 implementation was:

```ts
const results = await Promise.all(orderedIds.map((id, index) =>
  supabase.from('resource_related_content')
    .update({ sort_order: index }).eq('id', id).eq('source_post_id', sourcePostId)));
```

Every `.update()` is a separate PostgREST request and therefore its own
autocommitted transaction. There is no transaction, no validation that the
payload describes the complete set, and no locking.

Reproduced against real PostgreSQL in
`scripts/admin_a02_wave2_certification.mjs` **SECTION 1**, by replaying that
exact statement sequence and failing the third statement:

- the two statements that already ran **stayed committed** after the failure;
- the committed positions contained a **duplicate**;
- the committed positions were **no longer unique or contiguous**;
- the resulting order was a **mixture of the old and the requested order — neither one**.

**SECTION 2** reproduces three further latent hazards of the same path:
an omitted row strands a link and produces duplicate positions; an id
belonging to a *different* source matches zero rows, raises no error, and is
reported to the caller as success; a duplicated id produces a gap.

### 4.2 Root cause

Multi-row ordering was expressed as N independent writes rather than one
atomic write, and the payload was never validated as a complete, exclusive
set for one source. Partial application was therefore not merely possible —
it was the defined behaviour on any failure.

### 4.3 Canonical reorder contract

Determined and documented (migration `0116` header, and
`comment on function`):

| Question | Answer | Basis |
|---|---|---|
| Zero- or one-based? | **Zero-based** | `addRelatedContent()` appends `max+1` from a `-1` base; `listRelatedContentForSource()` reads ascending |
| Contiguous? | **Yes, after a reorder** (`0..n-1`) | New invariant; see §4.6 for why not enforced retroactively |
| Must the payload include every active link? | **Yes, exactly once** | Wave 2 §5.2 default; no prior authoritative behaviour |
| Omitted rows | **Rejected as a conflict** — never a silent delete or a retained position | Prevents stranded positions |
| Inactive/deleted rows | Not applicable — the table has no soft-delete or active flag | `0049` DDL |
| Duplicate target Resources | **Already prohibited** | `uq_resource_related_content (source_post_id, related_post_id, relationship_type)` |
| Maximum items | **100** (defensive cap; largest real DEV set is 6) | New; nothing in the product defined one |
| Two administrators reordering the same source | Serialised; the committed state is one complete ordering, never a blend | §4.5 |

Restated: *a reorder request represents the complete ordered set of the
existing related-content links for one source Resource. Every link must
appear exactly once, all links must belong to that source, and the resulting
positions must be unique and contiguous. The operation succeeds completely or
changes nothing. Reordering never creates, deletes or relinks a
relationship.*

### 4.4 Transaction design

`public.admin_reorder_related_content(p_source_post_id uuid, p_ordered_ids uuid[])`
— one `SECURITY DEFINER` function, therefore one transaction:

1. validates payload shape (not null, one-dimensional, non-empty, ≤ 100, no null elements, no duplicates);
2. confirms the source Resource exists;
3. takes `pg_advisory_xact_lock(hashtextextended(source::text, 0))`;
4. takes `FOR UPDATE` row locks on that source's link set;
5. proves the payload is *exactly* the existing set (no missing, no extra, no foreign);
6. writes every position in **one** statement — `UPDATE ... FROM unnest(p_ordered_ids) WITH ORDINALITY`, `sort_order = ord - 1`;
7. returns the ordering **read back from the table**, so a caller can only ever be shown a committed ordering.

Error contract: `22023` invalid payload → HTTP 422; `P0002` source not found
→ 404; `40001` set changed since the client loaded it → 409.

### 4.5 Concurrency design

The advisory lock is keyed per source, so two reorders of the **same** source
serialise while two reorders of **different** sources never contend. The
lock is transaction-scoped and released on commit or rollback, so no path
can leak it. Because each request is independently validated as the complete
set and applied atomically, the committed result is always one whole
ordering.

A racing *add* or *remove* does not take the advisory lock, and does not need
to: it changes the set, so the stale client's payload no longer matches and
is rejected with `40001` — the "refresh and try again" conflict the brief
asks for.

**Proved deterministically** (certification SECTIONS 4-5): stale set after a
removal → `40001` with the surviving links untouched; stale set after an
addition → `40001` with every link untouched; canonical refresh then
succeeds with unique, contiguous positions.

**True multi-session concurrency is proved on live DEV, not in PGlite.**
PGlite is a single-connection WASM database and cannot demonstrate real lock
contention; no Docker, `psql`, or local PostgreSQL is available in this
environment. The four concurrency cases therefore live in
`scripts/admin_a02_wave2_live_dev_verification.mjs` §A4, which fires genuinely
simultaneous PostgREST requests against real PostgreSQL. **That script is
part of the outstanding gate (§9).**

### 4.6 Why no unique constraint was added

A `unique (source_post_id, sort_order)` constraint would be the obvious
belt-and-braces control. It was deliberately **not** added: measured on live
DEV, **22 of 25** existing sources already hold duplicate positions (79 rows,
bulk-seeded at `sort_order = 0`). Such a constraint would either fail to
apply or force a silent mass repair of real content — both forbidden by the
Wave 2 brief. The invariant is therefore enforced *by the operation*: any set
this function reorders comes out unique and contiguous, proved including for
a legacy all-zero set (certification SECTION 5f). The legacy state is
recorded as a deferred finding (§10), not silently repaired.

### 4.7 Security controls

- `SECURITY DEFINER`, pinned `search_path = public`.
- Fixed SQL only — every table and column name is a literal; **no dynamic SQL**, no `format()`, no `quote_ident`, no identifier derived from client input. Asserted mechanically against `pg_proc.prosrc`.
- `EXECUTE` revoked from `public`, `anon` and `authenticated`; granted **only** to `service_role`. Verified via `proacl` and `has_function_privilege()` for each role.
- The function takes **no actor or role parameter**, so it cannot be told whom to trust. Asserted mechanically.
- It can only permute `sort_order` within one source's existing links — it cannot create, delete or relink. Proved by row-level before/after comparison (SECTION 3f).
- Route-side authority: the existing `canManageDiscovery` capability check, unchanged.

### 4.8 API and UI behaviour

**API** (`app/api/admin/resources/related/reorder/route.ts`): validates body
shape, source id UUID form, array-ness, size, element UUID form and
duplicates before any round trip; applies `canManageDiscovery`; invokes the
RPC with a service-role client; maps outcomes to **401 / 403 / 404 / 409 /
422 / 500**. Invalid payload, stale set and server failure are distinct
responses. No raw SQL error can reach a client: only the three deliberate
SQLSTATEs are surfaced (with the function-name prefix stripped), and every
other SQLSTATE is logged server-side and reported as a generic message —
pinned by tests over `23514`, `42501`, `42883`, `08006` and a transport
failure. Success returns the committed ordering.

**UI** (`components/resources/related/RelatedContentManager.tsx`): previously
reordered optimistically and fired the PATCH **without reading the
response**, so a rejected or partially applied reorder left the screen
showing an ordering that was never committed. Now: repeated submission is
blocked while saving; `saving` / `saved` / `conflict` / `failed` states are
surfaced through an `aria-live="polite"` status region; on any failure the
optimistic order is reverted **and** the canonical ordering is reloaded from
the server; on success the list is re-sorted to the ordering the database
returned. Up/Down buttons remain the reorder mechanism, so reordering is
keyboard-accessible by construction and no drag-and-drop alternative is
needed; buttons gained 44×44 minimum targets (WCAG 2.2 SC 2.5.8, well above
the 24×24 minimum), visible `focus-visible` rings, and an accessible name on
Remove. The page was not redesigned.

### 4.9 Rollback evidence

Certification SECTION 5a injects a failure **mid-`UPDATE`** (a trigger
raising `23514` when one row reaches position 3) — the same class of failure
that SECTION 1 showed corrupting the old path — and proves **not one
position changed**, positions remained unique and contiguous, and the same
reorder then succeeded cleanly once the failure source was removed. Every one
of the 13 rejected payloads in SECTION 4 was additionally verified to produce
**zero variance across the entire table**, not merely the affected source.

---

## 5. Scope B — Scheduling-validation alignment

### 5.1 The four content types and their routes

| Content type | Workflow route | Pre-Wave-2 scheduling validation | Post-Wave-2 |
|---|---|---|---|
| General Content | `app/api/admin/resources/content/[id]/workflow/route.ts` | `if (toStatus === 'scheduled' && !body?.scheduledAt)` → 422 | Shared `validateScheduledTransition(toStatus, post.scheduled_at)` |
| Glossary | `app/api/admin/resources/glossary/[id]/workflow/route.ts` | **None** | Same shared helper, identical |
| Money Updates | `app/api/admin/resources/money-updates/[id]/workflow/route.ts` | **None** | Same shared helper, identical |
| Videos | `app/api/admin/resources/videos/[id]/workflow/route.ts` | **None** | Same shared helper, identical |

All four invoke the same shared RPC via `lib/resources/workflow.ts`. The
scheduled-date field is `resource_posts.scheduled_at` (`timestamptz`,
migration `0049` line 498). All four editor-post types extend `ResourcePost`,
so `post.scheduled_at` is available on every route.

### 5.2 The original inconsistency

Three findings, each measured rather than asserted:

1. **Only the content route checked anything**, and what it checked was
   `body.scheduledAt` — a **client-supplied property that was never
   persisted, never forwarded to the RPC (which takes no scheduling
   parameter), and never compared to anything**. `scheduledAt: "banana"`
   satisfied it completely. Verified by reading all four route sources and
   `lib/resources/workflow.ts` directly from `origin/main` inside the
   certification script (SECTION 7).
2. **The shared RPC never examined `scheduled_at` at all.** Proved against a
   real pre-`0116` baseline database (SECTION 0): a year-2000 `scheduled_at`
   was **accepted**, and the post genuinely reached `status='scheduled'`.
3. **A null `scheduled_at` failed only as a raw `23514`**, whose message
   names the internal constraint `chk_resource_posts_scheduled_at` —
   surfaced to clients by `lib/resources/workflow.ts` as a **misleading HTTP
   403**. Proved on the same baseline database.

The same three findings were then reproduced **on live DEV itself** by the
verification harness running against the un-migrated database: for all four
content types, a past `scheduled_at` is currently accepted and the constraint
name currently leaks.

### 5.3 Canonical scheduling invariant

> **A transition to `scheduled` fails unless the Resource already holds a
> `scheduled_at` timestamptz strictly later than database `now()`.**

Derived from existing authoritative behaviour where it exists, and from the
brief's stated defaults where it does not:

| Question | Answer | Basis |
|---|---|---|
| Strictly future? | **Yes** | Wave 2 §6.3 default; no prior product logic said otherwise |
| Minimum lead time? | **None** | Nothing in the product defines one; inventing one would be new product scope |
| Rescheduling supported? | **Yes** (`scheduled` → `scheduled` was already permitted), now additionally requiring the stored timestamp still be future | Pre-existing from-status rule + the new invariant |
| Transitioning away | **Preserves** `scheduled_at` | The RPC has never cleared it; unchanged |
| Immediate publish | **Ignores** `scheduled_at` entirely | The `published` branch never consulted it; unchanged |
| Archived/draft retaining an old timestamp | **Permitted** | Follows from preservation; no constraint added |
| Timezone | Normalised to UTC as `timestamptz`, compared to database `now()` | `0049` column type |

Malformed, ambiguous and past timestamps are rejected. No timezone is ever
inferred from country or currency. Because the stored value is an absolute
instant, there is no ambiguous local time to silently convert across a
daylight-saving transition — pinned by tests using an instant inside the
Australian "spring forward" gap and by positive/negative-offset equivalence
tests.

### 5.4 Database enforcement — the shared RPC was extended, not replaced

`public.transition_resource_post_status` was re-declared with `CREATE OR
REPLACE`, same signature, using **migration `0098`'s body with the scheduling
guard added and nothing else altered**. It was not replaced, not forked into
four per-type functions, and transition authority was not moved to the
client.

Measured against a second, independently built baseline database that
excludes `0116` (SECTION 0):

- grants **byte-identical** (`proacl` compared directly);
- `search_path` identical;
- still `SECURITY DEFINER`;
- still exactly one function (not forked).

The guard is placed **after** the compliance and role checks, so an
unauthorised actor still receives the permission error first and learns
nothing about the post's scheduling state — asserted explicitly per content
type. RED-content, AMBER-without-approval and not-yet-approved rules all
still fire ahead of it, verified.

It raises SQLSTATE `22023`, which is what allows one canonical HTTP 422 for
all four routes.

### 5.5 Shared server validation

`lib/resources/scheduling.ts` — one implementation, called identically by all
four routes. Reads the **stored** `post.scheduled_at`, never a request body
value. Returns one canonical `{ code, message, field }`:

| Code | HTTP | Message |
|---|---|---|
| `SCHEDULED_AT_REQUIRED` | 422 | "A publish date and time is required before this content can be scheduled." |
| `SCHEDULED_AT_IN_PAST` | 422 | "The scheduled publish date and time must be in the future." |
| `SCHEDULED_AT_INVALID` | 422 | "The scheduled publish date and time is not a valid date." |

Field reference is always `scheduled_at`. The first two messages are
**identical to the strings the database raises**, so the pre-check and the
database's own rejection are indistinguishable to the administrator. The
envelope (`{ error, code, fields }`) matches the existing
`validateForReview`/`validateForPublish` gates, so no client needs a new
error shape.

`lib/resources/workflow.ts` gained exactly two narrow mappings — `22023` →
the canonical 422, and a raw `chk_resource_posts_scheduled_at` `23514` → the
same safe message (defence in depth; unreachable now, and logged if ever
reached). **All other error mapping is untouched**, preserving the certified
401/404/403 behaviour.

This helper is explicitly **not** the security boundary; the database RPC is,
and it also covers a direct RPC call that skips the API entirely.

### 5.6 UI behaviour

Unchanged and deliberately so. `components/resources/editor/WorkflowPanel.tsx`
has never offered a Schedule action — the R1.3 decision, documented in that
file, was to defer it until a scheduled-publishing worker exists. Wave 2 does
not add one.

### 5.7 Existing-data reconciliation (brief §6.5)

Measured read-only on live DEV before any change
(`scripts/admin_a02_wave2_dev_precheck.mjs`):

| Measure | Count |
|---|---|
| `resource_posts` total | 407 |
| `status='scheduled'` | 5 |
| …with **null** `scheduled_at` | **0** |
| …with **past** `scheduled_at` | **1** |
| …with future `scheduled_at` | 4 |
| Non-scheduled rows carrying a stale `scheduled_at` | **0** |
| `status='published'` | 42 |
| By content type | article 233, guide 36, fhip_explainer 34, money_update_template 16, video 30, glossary 55, money_update 3 |

**The one past-dated row is `76b4b064-d31e-4103-9a6e-fbbaecc3779e`,
`scheduled_at = 2026-08-30T12:31:03Z`, titled
`r1-1-test-1788006660995-6wiffa`** — a leftover R1.1 automated-test fixture,
**not** one of the 84 curated Resources.

**This is not a stop condition, and the reasoning is stated rather than
assumed.** The new invariant is a **transition-time** rule inside the RPC; it
adds **no table constraint**. No existing row is re-validated, modified,
published, rescheduled or deleted by `0116`. The row above remains exactly as
it is. It would only fail the invariant if someone deliberately
re-transitioned it to `scheduled`, at which point failing is the correct
outcome. Nothing was silently repaired, and the invariant was not weakened to
accommodate it. It is disclosed here for the Product Owner and carried as a
deferred cleanup item (§10).

---

## 6. Admin Architecture Standard compliance (v1.0, mandatory)

`origin/main` advanced mid-wave to include
`docs/admin/FHIP_ADMIN_ARCHITECTURE_STANDARD.md`, which `AGENTS.md` and
`CLAUDE.md` make mandatory for anything touching `app/api/admin/**`. It was
read in full and this branch is rebased onto it. Per §16.3:

### 6.1 Capabilities affected

Wave 2 **introduces no new capability and changes no capability definition.**

| Capability | Relationship to Wave 2 |
|---|---|
| `canManageDiscovery` | Gates the reorder route. Wave 2 changed *how* the route enforces and executes, never *who* is authorised. |
| Resources workflow transition authority (`private.can_publish_resource` et al.) | Gates the transition to `scheduled`. Wave 2 added a rule **after** those role checks and changed no predicate. |

### 6.2 Applicable clauses and the tests proving each

| Clause | Applies | Evidence |
|---|---|---|
| **§2** capability-based access | Yes | `tests/unit/adminA02Wave2CapabilityMatrix.test.ts` — `canManageDiscovery` is separately named, refuses 4 of the 6 Resources roles (so it is not a coarse "has some Admin role" check), and is **not** an alias for `canManageResources` (Editor passes one and fails the other). The route checks the capability separately from `auth.getUser()`. |
| **§3** multi-role composition | Yes | Same file — Analyst *plus* Editor still passes; Analyst plus a non-permitted role still fails; any one permitted role in a multi-role set suffices. |
| **§4** navigation is not authorisation; four-layer enforcement; explicit denial | Yes | **Database layer:** certification SECTION 6 — `anon` and `authenticated` hold **no** `EXECUTE` on the reorder RPC (`has_function_privilege` false for both). **Database-bypass test:** live-DEV §A5 attempts the RPC directly with the anon key, an authenticated Editor, and an Analyst. **Direct-API test:** live-DEV §B1 calls the workflow RPC directly, bypassing the route, and is still blocked. **Server/API layer:** the route's own `canManageDiscovery` check. **Explicit denial:** 401/403/404/409/422 — never a `200` with an empty array, and never a fabricated success. |
| **§5** least privilege; **Analyst is read-only** | Yes | Capability matrix (Analyst denied reorder, schedule and publish) **and** certification SECTION 8, which proves at the database layer, for each of the four content types, that an Analyst is denied both scheduling and publishing with a genuinely future timestamp — so only the role predicate can be doing the blocking — with the target post verified unchanged. |
| **§6** privileged database-access pattern | Partly — see §6.3 | Pinned `search_path`; fixed return type; no dynamic SQL; `EXECUTE` revoked from `PUBLIC`/`anon`; granted only to one specific role; explicit exception for an unauthorised caller. |
| **§6.1** approved callable pattern | Yes | The wrapper lives in the PostgREST-exposed `public` schema, the same shape as `transition_resource_post_status`. No `private`-schema exposure; no view of any kind. |
| **§13** fail closed | Yes | `tests/unit/resourcesRelatedReorder.test.ts` proves an unexpected SQLSTATE never becomes a partial or fabricated success; the UI reverts and reloads canonical state on failure rather than displaying an uncommitted ordering; a missing/invalid/past timestamp is rejected rather than silently published. |
| **§14** no hidden scope expansion | Yes | Exactly two scoped items; no unrelated role, navigation entry or defect changed. The 22-of-25 duplicate-position finding was **recorded and deferred**, not fixed (§10). |
| **§15** documentation | Yes | This report, the migration registry entry, and the invariant comments on both functions. |

**Not applicable:** §7 (privacy-preserving analytics), §8 (result-state
semantics), §9 (personal/financial data boundary), §10 (jurisdiction and
privacy review), §11 (safe exports), §12 (metric certification). Wave 2 adds
no analytics, no metric, no export and no new data surface. The reorder RPC
returns only relationship ids and integer positions; the scheduling rule
reads only a workflow timestamp. No personal, financial or behavioural data
is touched.

### 6.3 Exception requested under §16.1 — **approval outstanding**

1. **Clause departed from:** §6, first bullet — "internal authorisation using
   `auth.uid()` … an approved capability predicate (§2), evaluated inside the
   function."
2. **Reason:** `public.admin_reorder_related_content` performs **no internal
   authorisation**. Authority is enforced by the Admin server route
   (`canManageDiscovery`), and the function's `EXECUTE` is granted to
   `service_role` only. This is what the Wave 2 brief §5.3 explicitly
   directs ("Grant execution only to `service_role`", "Is unavailable to
   `public`, `anon` and ordinary `authenticated`", "Is callable only through
   the authorised Admin server route", "Does not trust client-supplied
   roles"), and it matches the already production-released pattern of
   migrations `0107` and `0109`. The two cannot both be satisfied: an
   internal `auth.uid()` predicate requires the caller's own session, which
   requires granting `EXECUTE` to `authenticated` — precisely what the brief
   forbids. Note also that §6 is written for the *analytics/reporting read*
   case (its other bullets require aggregate-only output, an output-column
   allow-list and in-function suppression), none of which is meaningful for
   a write RPC that permutes an integer column.
3. **Security/privacy/operational effect:** the function is **unreachable**
   from any browser session key, so the set of callers is strictly smaller
   than the §6 pattern would produce. The risk transferred is that route-side
   authority becomes the only capability check — mitigated below.
4. **Compensating controls:** `EXECUTE` revoked from `public`/`anon`/
   `authenticated` and granted only to `service_role` (**stricter** than §6
   requires, which §1.1 expressly permits); the route performs the
   `canManageDiscovery` check using the caller's own server-side session
   before invoking; the function accepts no actor or role parameter, so it
   cannot be told whom to trust; its blast radius is limited to permuting
   `sort_order` within one source's existing links — it cannot create, delete
   or relink, cannot read or return any personal or financial data, and
   cannot escalate privilege; and the database-bypass tests prove `anon`,
   `authenticated` and `analyst` are all refused.
5. **Approval status: REQUESTED, NOT YET GRANTED.** This is one of the two
   reasons for the CONDITIONAL verdict.
6. Recorded here, in this certification report, as §16.1(6) requires.

**Related, pre-existing:** the same tension applies to the already
production-released migrations `0107` and `0109`. Per §1.2 that is recorded,
not retroactively invalidating their certification, and is **not** fixed by
this wave (§14).

---

## 7. Verification results

### 7.1 Focused certification — `scripts/admin_a02_wave2_certification.mjs`

**249 checks, 249 passed, 0 failed.** Real PostgreSQL via PGlite, full
migration chain replayed from empty (103 migrations), **plus a second
independently built baseline database excluding `0116`** used to measure
every "before" claim rather than assert it.

| Section | Coverage |
|---|---|
| 0 | Baseline measurements; both defects reproduced against the **real** pre-`0116` RPC; grant/`search_path`/`SECURITY DEFINER`/single-function parity |
| 1 | Reorder defect reproduction (RED) |
| 2 | Omitted-row, foreign-id and duplicate-id hazards (RED) |
| 3 | Valid behaviour: two items, complete reverse, **maximum 100**, idempotent repeat, independent sources, no create/delete/relink, zero-based positions |
| 4 | 13 invalid payloads — empty, missing, extra, duplicate, foreign-source, unknown id, unknown source, null source, null array, oversized, malformed UUID, non-array, malformed source UUID — each with correct SQLSTATE and **zero variance across the whole table** |
| 5 | Rollback: mid-`UPDATE` failure injection, validation-stage failure, stale set (removal), stale set (addition), legacy duplicate-position repair |
| 6 | Security posture: `SECURITY DEFINER`, pinned `search_path`, ACL, per-role `has_function_privilege`, no dynamic SQL, no actor parameter |
| 7 | Route-level divergence reproduced by reading all four route sources from `origin/main` |
| 8 | Full scheduling matrix × 4 content types: missing, null, malformed, past, **boundary equal to now()**, valid future, far future, UTC, +offset, −offset, DST boundary, role denied, **Analyst denied (schedule and publish)**, unauthenticated direct RPC, schedule→draft, schedule→archive, reschedule valid, reschedule stale, immediate publish unchanged |
| 9 | Existing behaviour unchanged: RED, AMBER, not-approved all still blocked and checked first; full happy-path chain; history and audit correct; **a rejected attempt writes no history and no audit row** |
| 10 | Migration re-application: idempotent, zero data variance, no duplicate overloads |

### 7.2 Focused unit tests

| File | Tests | Result |
|---|---|---|
| `tests/unit/resourcesSchedulingValidation.test.ts` | 42 | Pass |
| `tests/unit/resourcesRelatedReorder.test.ts` | 14 | Pass |
| `tests/unit/adminA02Wave2CapabilityMatrix.test.ts` | 21 | Pass |
| **Total new** | **77** | **Pass** |

Includes a pinned regression for the exact `scheduledAt: "banana"` bug, and
a recorded, tested note that ECMAScript's `Date.parse` leniently rolls
`2026-02-30` over to 2 March (still rejected, and PostgreSQL — the actual
authority — rejects such a date outright).

### 7.3 Broader regression, compared against `origin/main`

The suite contains 12 test files that run against the **live shared DEV
Supabase**, creating and deleting their own fixtures. Running in parallel
they contend with one another, so the failing set is nondeterministic — it
differed between consecutive runs **on `origin/main` itself**. They were
therefore separated and both trees measured.

**Deterministic subset** (all 12 live-DEV files excluded):

| Tree | Files | Tests | Failed |
|---|---|---|---|
| `origin/main` baseline | 162 | 3511 | **0** |
| Wave 2 branch | 165 | 3588 | **0** |

Delta is exactly +3 files / +77 tests — this wave's own new tests. **Zero
regressions.**

**Live-DEV subset**, run serially (`--no-file-parallelism`) on each tree:

| Tree | Files | Tests | Failed |
|---|---|---|---|
| `origin/main` baseline | 1 failed / 10 passed / 1 skipped | 1 failed / 222 passed / 5 skipped | 1 |
| Wave 2 branch | 1 failed / 10 passed / 1 skipped | 1 failed / 222 passed / 5 skipped | 1 |

**Identical, and the same single test.** Independently reproduced on the
baseline tree: `resourcesR1_1.test.ts` → "an ordinary customer cannot edit
content, transition workflow, read audit log…" fails with `Error: Test timed
out in 5000ms` and **passes on retry**. It is a network-latency timeout
against live DEV, present on `origin/main`, unrelated to Wave 2. Classified
as pre-existing **with evidence**, not by assumption.

### 7.4 Other gates

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | Clean |
| ESLint on all 12 touched source/test files | Clean, zero warnings |
| `npm run build` | "✓ Compiled successfully in 41s" |
| `scripts/check-migration-versions.mjs` | OK, next version `0117` |
| Cross-branch collision guard | OK against `origin/main` + 7 other branches |
| PGlite security tests | Included in the 249 (SECTION 6, plus per-role denial in 8) |

### 7.5 Responsive and accessibility

Changes are confined to the three reorder/remove buttons and one status
region in `RelatedContentManager`. Buttons now use
`inline-flex min-h-11 min-w-11` (44×44 CSS px — WCAG 2.2 SC 2.5.8 Target Size
Minimum requires 24×24, so this clears it with margin), `focus-visible`
outline rings with offset, and an accessible name on every control
(`Move <title> up/down`, `Remove <title>`). Reordering is keyboard-operable
by construction — the mechanism is buttons, not drag-and-drop, so the brief's
"non-drag alternative" requirement is satisfied by the existing design. The
status region uses `role="status" aria-live="polite"` so a keyboard or
screen-reader user hears the outcome of a reorder. The surrounding layout
(`flex shrink-0 items-center gap-1.5`) is unchanged, so the responsive
behaviour of the page is unchanged.

**Not done:** these are structural/static assertions from the source. No
visual browser pass at multiple viewports was performed, because the page is
behind admin authentication and reaching it requires a real Resources-admin
session in a running app. Recorded honestly rather than claimed.

---

## 8. Scope and data

### 8.1 Exact diff — 17 files, zero unrelated

```
app/api/admin/resources/content/[id]/workflow/route.ts
app/api/admin/resources/glossary/[id]/workflow/route.ts
app/api/admin/resources/money-updates/[id]/workflow/route.ts
app/api/admin/resources/related/reorder/route.ts
app/api/admin/resources/videos/[id]/workflow/route.ts
components/resources/related/RelatedContentManager.tsx
docs/admin/A02_WAVE2_WORKFLOW_ORDERING_INTEGRITY_CERTIFICATION.md   (this file)
docs/architecture/MIGRATION_REGISTRY.md
lib/resources/discovery/relatedAdmin.ts
lib/resources/scheduling.ts                                        (new)
lib/resources/workflow.ts
scripts/admin_a02_wave2_certification.mjs                          (new)
scripts/admin_a02_wave2_dev_precheck.mjs                           (new)
scripts/admin_a02_wave2_live_dev_verification.mjs                  (new)
supabase/migrations/0116_...sql                                    (new)
tests/unit/adminA02Wave2CapabilityMatrix.test.ts                   (new)
tests/unit/resourcesRelatedReorder.test.ts                         (new)
tests/unit/resourcesSchedulingValidation.test.ts                   (new)
```

No Recommendations file, no unrelated Admin file, no unrelated migration.
Two test-artifact files (`scripts/ii-r*-certification/comparison_report.json`)
are rewritten by running the suite; they were reverted and are **not** in the
diff.

### 8.2 DEV data reconciliation

| Measure | Before | After | Variance |
|---|---|---|---|
| `resource_posts` | 407 | 407 | **0** |
| `resource_related_content` | 79 | 79 | **0** |
| `resource_workflow_history` | 344 | 344 | **0** |
| `status='published'` | 42 | 42 | **0** |
| `status='scheduled'` | 5 | 5 | **0** |
| Distinct related-content sources | 25 | 25 | **0** |
| Sources with duplicate positions | 22 | 22 | **0** |
| Sources with gapped positions | 0 | 0 | **0** |
| Duplicate `source|target|type` pairs | 0 | 0 | **0** |
| Self-links | 0 | 0 | **0** |
| Test fixtures created | — | — | all removed |
| Unrelated records changed | — | — | **0** |
| Published-content variance | — | — | **0** |
| Resources published | — | — | **none** |

`resource_audit_log` grew by 12 rows from the harness dry-run. This is **by
design and disclosed**: `resource_audit_log` is append-only and deliberately
has no cascade from `resource_posts` — an audit trail that deleted itself
when its subject was deleted would not be an audit trail. Those rows
reference only fixture Resource ids.

### 8.3 A fixture leak, found and fixed the same session

A dry-run of the live verification harness was piped through `head`, which
closed stdout, SIGPIPE-killed the process before its cleanup step, and left
**14 fixture Resources** in DEV. This was detected by direct measurement,
and DEV was restored to exactly 407 posts / 79 links / 0 orphan fixtures /
0 orphan users. The harness was then hardened: it sweeps by the shared
`a02w2-` prefix **before** taking its baseline and again after the run,
asserts that zero fixture Resources **and** zero fixture users remain from
*any* run, and carries an explicit warning not to pipe it through `head`. A
re-run of the hardened harness reconciled exactly. Reported rather than
quietly corrected.

---

## 9. The outstanding gate

**Migration `0116` has not been applied to DEV.**

This environment has no capability to execute DDL against a hosted Supabase
project — only PostgREST, which cannot run DDL — and this project's standing
process is that migrations are applied by hand in the Supabase Dashboard SQL
editor by the Product Owner. Pre-check confirms the objects are currently
absent from DEV (`PGRST202` for `admin_reorder_related_content`).

Consequently the following remain **unproven on live DEV**, though all are
proven against real PostgreSQL locally except where noted:

- true multi-session concurrency (four cases — **only** provable on live DEV; PGlite is single-connection and no other real PostgreSQL is available here);
- live anon / authenticated / analyst direct-RPC denial;
- the live per-content-type scheduling matrix;
- live workflow-history and audit correctness for the new path.

**To close it:**

1. Apply `supabase/migrations/0116_admin_a02_wave2_related_reorder_and_scheduling_integrity.sql` to **DEV only** via the Dashboard SQL editor (SHA-256 `2da81ecd155e83c0c5ee2a9f5a41d13b6071b78bbd71ae74df300c2a00b8c355`).
2. Run `node scripts/admin_a02_wave2_live_dev_verification.mjs > wave2-live.txt 2>&1` (**do not pipe through `head`**).
3. Expect all checks to pass and the reconciliation block to show zero variance.

For reference, running that harness against the **un-migrated** database
gives 96 passed / 49 failed, and every one of the 49 traces solely to `0116`
being absent. That run is itself a live-DEV reproduction of both defects on
the real database.

The second, independent gate is the **§16.1 exception in §6.3**, which needs
a Product Owner ruling.

---

## 10. Deferred findings (recorded, not fixed — §14)

| # | Finding | Recommendation |
|---|---|---|
| D-1 | 22 of 25 Related Content sources in DEV hold duplicate `sort_order` values (bulk-seeded at 0). Harmless today — read order is merely arbitrary within a tie — and now self-healing for any source an administrator reorders. | A separately authorised one-off normalisation, if the Product Owner wants it. Deliberately not done here: Wave 2 forbids silent repair of existing content. |
| D-2 | One leftover R1.1 test fixture (`76b4b064-…`, `r1-1-test-1788006660995-6wiffa`) sits at `status='scheduled'` with a past `scheduled_at`. Not one of the 84 curated Resources. | Delete as routine DEV cleanup under separate authority. It does not violate the new invariant, which is transition-time only. |
| D-3 | There is no authenticated write path for `scheduled_at` and no scheduled-publishing worker, so scheduling is uniformly and correctly *rejected* for every content type in practice. Wave 2 made that rejection consistent, non-bypassable and honestly reported; it did not build the feature. | A future wave, if scheduled publishing is wanted as a product capability. |
| D-4 | The §6 `auth.uid()`-in-function tension also applies to the production-released `0107`/`0109`. | Per standard §1.2, record and schedule under §16 — not a retroactive invalidation. |
| D-5 | 12 live-DEV test files share one DEV database and contend when run in parallel, producing a nondeterministic failing set. | Consider serialising them or giving them isolated schemas. Pre-existing; out of Wave 2 scope. |

---

## 11. Source-control status

| Item | Value |
|---|---|
| Branch | `fix/admin-a02-wave2-workflow-ordering-integrity` |
| Worktree | `D:\fhip-a02-wave2` (isolated; the Product Owner's working tree was not altered) |
| Base | `origin/main` @ `1b40b0b` |
| Merged to `main` | **No** — not authorised |
| Pushed to `main` | **No** — not authorised |
| Production migration | **No** — not authorised |
| Production deployment | **No** — not authorised |
| Any Resource published | **No** |
| Role changes | **None** |
| Wave 3 work | **None started** |
