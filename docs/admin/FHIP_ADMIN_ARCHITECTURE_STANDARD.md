# FHIP Admin Architecture Standard

**Version:** 1.0
**Effective date:** 2026-08-30
**Status:** Product Owner approved
**Source:** Analyst Analytics Phase 0 discovery, Phase 0 correction supplement, Phase 0 final closure addendum, and the Phase A Implementation Plan's three correction/closure addenda (planning closure)
**Change control:** see §16

This is the single canonical source of truth for FHIP's Admin architecture. Other repository files (`AGENTS.md`, `CLAUDE.md`, `SECURITY.md`, the pull-request template) point to this document rather than duplicating it. Where any other document conflicts with this one on an Admin architecture question, this document controls.

---

## 1. Scope

### 1.1 Applicability

This standard applies to every FHIP workstream that introduces or changes:

- Admin navigation;
- Admin pages or dashboards;
- Admin roles or capabilities;
- Admin APIs;
- privileged database access;
- analytics or management reporting;
- Admin filters, drill-downs or exports;
- content or operational workflows;
- Resources, Recommendations, or Benchmark administration;
- future Admin integrations;
- any non-Admin module that adds an Admin-facing control or reporting surface.

A module may apply stricter controls than this standard requires, but must never weaken or bypass it.

### 1.2 When the standard applies

- **Prospectively** to all new Admin work, from this document's effective date forward.
- To **in-progress workstreams** when they next change an Admin integration.
- To **existing functionality** when a material conflict with this standard is discovered.

This standard does **not** require an indiscriminate retrospective rebuild of already-certified functionality. A conflict discovered in already-certified code is recorded and scheduled for correction under §16 (Exceptions and change control) or a normal defect-fix process — it does not, by itself, invalidate a prior certification retroactively.

### 1.3 What "Mandatory controls" means

Every numbered requirement below (§2 onward) is a **mandatory control**, not a suggestion, unless the text explicitly says "may" or gives a worked example. Examples, sample wording, and illustrative scenarios in this document are marked as such and exist to clarify intent — they do not narrow the rule's actual scope. In particular, worked examples that happen to reference Resources, Recommendations, or a Resources-specific Analyst-role scenario apply to every Admin surface this standard covers (§1.1), not only to Resources.

---

## 2. Capability-based access

Every protected Admin action is gated by an explicit, independently named **capability** — never by a broader signal.

**Prohibited as the sole basis for authorization:**
- authentication alone;
- possession of *any* Admin-related role (a coarse "has some Admin role" check);
- broad flags such as `hasAdminAccess`, `hasResourcesAccess`, or an equivalent catch-all boolean;
- route knowledge (knowing a URL exists is not permission to use it);
- navigation visibility (see §4);
- client-side checks alone.

**Every capability must define:**
1. Authorised roles or role combinations.
2. UI visibility rule.
3. Route enforcement.
4. API enforcement.
5. Database enforcement.
6. Denial behaviour (what a disallowed caller actually receives — see §4).
7. Positive and negative tests.

Capabilities may share lower-level role-resolution helpers (e.g. a shared function that fetches a caller's current roles), but each capability itself must remain **separately named, separately documented, and separately tested**. One broad boolean must never gate multiple, otherwise-unrelated Admin functions — if two capabilities happen to be granted to the same roles today, they are still two capabilities, not one, because a future change to one must not silently change the other.

---

## 3. Multi-role composition

- A user receives the **union** of capabilities granted by every role they hold.
- An Analyst-only user receives Analytics capabilities only.
- A user holding Analyst *plus* another role receives Analytics **in addition to** that other role's legitimate capabilities — Analyst never displaces or narrows another role's access.
- A role must never **inherit** unrelated editorial, compliance, publishing, role-management, configuration, or destructive authority it was not explicitly granted.
- Any role hierarchy or implied inheritance (e.g. "Super Admin automatically gets everything") requires explicit, separate Product Owner approval — it is not assumed by default even where it seems obviously safe.

---

## 4. Navigation is not authorisation

Navigation visibility is a **UX convenience only**. Hiding a link is never a security control.

Every protected Admin capability must be enforced **independently** at all four layers:

1. **Database layer** — RLS policies and/or `SECURITY DEFINER` RPC-internal checks (§7).
2. **Server/API layer** — the route handler itself verifies the caller's capability before doing any work.
3. **Route/page layer** — a disallowed direct navigation is redirected or rejected, not silently rendered empty.
4. **UI/navigation layer** — the nav entry is hidden for callers who lack the capability (this layer alone proves nothing about the other three).

Every capability's test suite must include a **direct-URL test**, a **direct-API test**, and — for anything gated by a privileged RPC — a **database-bypass test** (calling the RPC or reading the table directly, not through the intended route).

An unauthorised caller must receive an **explicit denial** — a `401` (not authenticated) or `403` (authenticated but not permitted). A misleading empty result (`200` with an empty array, or a `200` with all-zero/all-suppressed values presented as if they were genuine) must never substitute for a clean denial. A caller who is denied and a caller who correctly sees "no data exists yet" must be distinguishable from the HTTP response alone.

---

## 5. Least privilege and separation of duties

Grant the minimum access a role genuinely needs, and preserve separation between at least these role families (and any future specialist Admin role added later, under the same discipline):

- Analyst
- Author
- Editor
- Compliance Reviewer
- Publisher
- Resource Admin
- Super Admin

**Analyst is read-only.** Analyst must not receive authority to:
- create or edit content;
- approve compliance classifications;
- schedule or publish;
- assign or remove roles;
- alter Benchmarks or Recommendations;
- access individual financial records;
- view direct identifiers;
- export raw personal information;
- change configuration;
- perform destructive operations;
- view named individual staff-performance reporting.

This list is the read-only boundary specifically for the Analyst role. It is an example of applying §2/§5's separation-of-duties principle to one named role, not an exhaustive list of every restriction every role might ever need — future roles define their own equivalent boundary under the same principle.

---

## 6. Privileged database-access pattern

Where an Admin reporting or analytics feature needs data the caller cannot safely read directly (e.g. an aggregate across all users' data), the approved pattern is a **narrowly scoped, authenticated, aggregate-only `SECURITY DEFINER` RPC**, exposed through FHIP's approved public-schema wrapper pattern (§6.1) — never a bare view, never a directly-grantable table.

**Every privileged RPC must include:**

- internal authorisation using `auth.uid()` — never a caller-supplied identity;
- an approved capability predicate (§2), evaluated inside the function;
- fixed, safe `search_path` (schema-qualified references throughout the function body);
- an explicit, fixed return type — never a dynamic/untyped shape;
- an output-column allow-list (only named, intended columns can ever be returned);
- a filter/grouping allow-list (only named, intended filter and grouping dimensions are accepted — never an arbitrary client-supplied column name);
- no dynamic SQL built from caller input;
- no raw-row return path (aggregate-only; see §8 for the suppression this implies);
- no sensitive-column return path (see §9);
- suppression logic evaluated **inside** the database function, not left to the caller or the UI;
- `EXECUTE` revoked from `PUBLIC` and `anon`;
- `EXECUTE` granted only to the specific, intended authenticated database role;
- an explicit failure (exception or typed error) for an unauthorised caller — never a quiet empty/zero result (see §4, §8);
- an explicit inference/reconstruction assessment before the RPC is considered complete (§8).

### 6.1 The approved callable pattern

FHIP's approved pattern is an **exposed-schema wrapper RPC**, optionally backed by `private`-schema implementation or authorisation helpers where useful for code organisation. The wrapper itself lives in a PostgREST-exposed schema (in this codebase, `public`) so it is directly callable via the normal Supabase RPC path — the same shape already proven in this codebase by functions such as `transition_resource_post_status`.

- Do **not** expose the general `private` schema merely to make an RPC callable from the application. `private`-schema functions exist for internal composition between trusted `SECURITY DEFINER` functions; they are not PostgREST-exposed by design, and treating that as an implementation detail to route around is itself a standard violation.
- Traditional owner-context views (a view that relies on the querying session's own RLS context to filter rows) must **not** be used for this purpose — an aggregate-analytics reader is not the row owner, so an owner-context view either fails to return anything useful or, worse, silently returns more than intended if misconfigured.
- A `security_invoker` view may be proposed as an alternative **only** when the underlying table's RLS, the view's own grants, and the impossibility of an unintended direct-table read have all been explicitly proven safe and documented — this is an exception path (§16), not a default option.

---

## 7. Privacy-preserving analytics

Aggregation and privacy preservation are the default, not an opt-in.

**The central suppression model must address:**
- minimum cell count;
- minimum distinct-person count;
- dominance protection (no single contributor dominating a cell that looks aggregate);
- primary suppression (a cell that fails a threshold on its own);
- complementary suppression — when a cell in a partition is primary-suppressed, at least one further cell in that **same partition** is also suppressed, so a visible-cell sum cannot solve for the hidden value by subtraction from a known total (two unknowns, one equation);
- the requirement that an affected exhaustive partition ends up with **at least two** protected/unknown cells, unless the entire partition is instead returned as `unavailable`;
- totals, subtotals, denominators, and ratios — none of these may leak a value the cell-level suppression was meant to hide;
- cross-metric and cross-RPC reconstruction (a different metric or a different RPC covering the same underlying population must not disclose what one RPC suppressed);
- filter-combination reconstruction (narrowing filters until a suppressed cohort is isolated);
- repeated-query and differencing attacks (calling the same or a related endpoint more than once, including with a deliberately-inserted change between calls, to try to isolate a delta) — see §7.1;
- changes between database snapshots (a value that was safe at one point in time and becomes unsafe after a data change, or vice versa, must still be evaluated fresh each time, not carried over from a stale decision);
- cached or previously-observed results (a cached response must not become a lever for reconstructing a currently-suppressed value);
- identical treatment across every surface the data reaches — SQL, API, UI, CSV, and PDF must never disagree about what is suppressed;
- the distinction between public content-level data (e.g. how many published Resources exist) and user-derived behavioural data (e.g. how many distinct people viewed something) — the latter is held to the full suppression model even where the former might not need it.

### 7.1 Per-call independence

Where suppression decisions are recomputed independently, fresh, on every call (rather than relying on a shared session or a cache), that per-call independence is itself part of the design: it must hold under the ≥2-unknowns-per-partition rule above regardless of timing, so that no combination of calls — however far apart, however different the underlying data — can jointly be solved for a suppressed cell. A design is not required to implement cross-call caching or locking; it is required to be safe without depending on any assumption that it will.

### 7.2 Provisional thresholds

- Minimum cell count: **5**
- Minimum distinct people: **10**
- Minimum evaluation runs: **20**

These are **starting controls**, not permanent constants — they require pre-production revalidation against real data distributions before this standard is applied to a production release. No workstream may silently use a weaker threshold than these, and no workstream may enforce suppression only in the UI while leaving the API or database unprotected.

---

## 8. Result-state semantics

Every analytics result must distinguish exactly these states:

- `ok` — a real, safe-to-show value;
- `suppressed` — a value exists but is being withheld for privacy reasons;
- `unavailable` — the underlying data does not exist yet, or cannot currently be computed, for a reason unrelated to privacy suppression;
- **unauthorised or failed request** — this is an exception or an explicit error response, not a fourth successful data state.

A `suppressed` or `unavailable` value must **never** be returned as a bare `0` or an empty-looking success. A suppressed result should use the fixed label: **"Insufficient data to display safely."**

**Typed result contracts must address:**
- a nullable numeric value (null exactly when the state is not `ok`);
- the `state` field itself;
- a `sufficient_data` indicator where relevant;
- a suppression reason, where the state is `suppressed`;
- numerator/denominator handling for any ratio (joint suppression — see §7);
- freshness, where the underlying data has a meaningful "as of" time;
- zero-value semantics (a genuine zero is `ok` with value `0`, never confused with `unavailable` or `suppressed`);
- unavailable-source semantics (distinguishing "this data source itself is down" from "this cohort has no data").

---

## 9. Personal and financial data boundary

Admin analytics must **not** expose:

- `user_id`;
- names, emails, phone numbers, or any other direct identifier;
- household or profile identifiers;
- raw financial records — account, income, expense, asset, liability, investment, or retirement records;
- raw recommendation contexts;
- raw `context_snapshot` payloads;
- scenario identifiers;
- unrestricted sensitive free text;
- any cohort small enough to be reconstructable to an individual (see §7).

Any **proposed** use of user-derived personal, financial, or behavioural data in an Admin surface requires, before implementation:
1. An explicit stated purpose.
2. A data-minimisation assessment.
3. A privacy-notice compatibility review.
4. A retention and deletion design.
5. A suppression and inference-risk assessment.
6. A jurisdiction review (§10).
7. Separate, explicit Product Owner approval.

---

## 10. Jurisdiction and privacy review

Every Admin feature touching personal or behavioural data must consider, as design controls — not as a substitute for qualified legal advice:

- the Australian Privacy Act and applicable Australian Privacy Principles (APPs);
- India's Digital Personal Data Protection Act 2023 and DPDP Rules 2025, evaluated against their **then-current commencement status** at the time of implementation, not assumed static;
- collection-notice and purpose-compatibility;
- retention and deletion;
- hosting, processors, and cross-border data handling;
- children and minors;
- whether the feature needs formal legal review or a Privacy Impact Assessment (PIA).

**Required, at minimum:**
- A documented **lightweight privacy review** for any Phase-A/B-equivalent Admin analytics feature.
- A **formal PIA, privacy-notice review, and qualified Australian/Indian legal review** before any telemetry or behavioural-instrumentation collection begins.

Legal requirements must be rechecked at implementation time, since law and its commencement status can change between when this standard is written and when a given feature is actually built. Nothing in this section is legal advice; it is a checklist for when to obtain legal advice.

---

## 11. Safe exports

Every CSV or PDF export from an Admin surface must have:

- a concrete, approved operational purpose (an export is not included merely because the on-screen data exists — see below);
- explicit authorised roles (not inherited automatically from screen access);
- the **same or stricter** suppression as the screen and API that back it;
- a column allow-list — no hidden raw fields riding along in the export that don't appear on screen;
- server-side generation and validation (never a client-side dump of already-fetched data);
- spreadsheet-formula-injection protection (values starting with `=`, `+`, `-`, `@`, or other formula-triggering characters are neutralised);
- stable suppressed-value handling (a suppressed cell exports as the same fixed label as on screen, never as blank-meaning-zero or a raw null);
- authorisation checked at both generation and download time (a link that stays valid after the caller's access is revoked is a defect);
- an appropriate, non-identifying file name;
- auditability (who generated/downloaded what, when);
- negative security tests proving an unauthorised caller cannot generate or download it.

Raw personal-data export remains **prohibited for Analyst**, regardless of any other capability Analyst might hold.

---

## 12. Metric certification

Every Admin metric must define:

- metric ID and name;
- business purpose;
- numerator and denominator (where applicable);
- source tables and fields;
- join semantics;
- deduplication rule;
- null and malformed-data handling;
- refresh behaviour (real-time, scheduled, cached — and how stale it can get before that matters);
- the allow-listed filters it accepts (§6);
- suppression requirements specific to this metric;
- known limitations;
- sufficient-data behaviour (what it shows when there isn't enough data yet, distinct from `suppressed` — see §8);
- semantic and security tests.

**Missing history must never be represented as zero.** A metric with no historical data yet is `unavailable`, not a genuine `0`.

**A proxy must not be presented as the underlying concept it approximates.** For example, `updated_at` may legitimately support a metric like "inactive for N days," but must not be presented as "time spent in this workflow stage" unless the system actually has reliable stage-entry history to compute that from — using the wrong timestamp to answer a question it cannot actually answer is a metric-certification failure, not a rounding error.

---

## 13. Safe failure behaviour

Every Admin surface must **fail closed** on:

- role-resolution failure;
- a database error;
- a malformed filter;
- an unexpected enum or category value;
- a suppression-evaluation failure;
- an unavailable data source;
- an RPC or API contract mismatch.

An error in any of the above must never silently become:
- a fabricated zero;
- an unsuppressed result;
- a partial raw result;
- a misleading empty success;
- a default grant of access.

The correct behaviour on any of these failures is an explicit error state or an `unavailable` result (§8) — never a value a caller could mistake for real data, and never treating an error condition as equivalent to "the caller is authorised."

---

## 14. No hidden scope expansion

An Admin integration is authorised to add only:

- its own approved navigation entry;
- its own explicit capabilities;
- its own approved read or write pathways;
- its own tests;
- its own operating instructions.

It must **not**:
- reorganise unrelated Admin functionality;
- alter unrelated roles;
- fix unrelated defects without separate authority to do so;
- create shared privileges purely for implementation convenience;
- absorb another, separately-scoped workstream.

A material defect discovered incidentally during an authorised piece of work must be recorded, and then either:
- fixed **only** where fixing it is necessary to preserve the specific capability or security boundary that workstream was authorised to build; or
- deferred and flagged for separate Product Owner authorisation.

---

## 15. Documentation and operating controls

Every Admin capability, once built, must have:

- role-to-capability documentation;
- its navigation and integration contract;
- metric definitions, where relevant (§12);
- its security and privacy controls (§6–§10);
- operating instructions;
- known limitations;
- sufficient-data behaviour (§8, §12);
- test and certification evidence;
- a rollback or disablement strategy;
- a named future-review owner.

---

## 16. Exceptions and change control

### 16.1 Exceptions

Any proposed exception to this standard must, before implementation:
1. Identify the exact clause of this standard being departed from.
2. State the reason.
3. Document the security, privacy, and operational effect of the departure.
4. Identify compensating controls.
5. Receive explicit Product Owner approval.
6. Be recorded in the relevant implementation/certification report.

An exception is scoped to the specific workstream that requested it — it does not become a general permission for future work.

### 16.2 Changing this standard

Any substantive change to this document itself requires:
- evidence-backed review (a stated reason grounded in real experience or a real finding, not a preference);
- explicit Product Owner approval;
- a version increment;
- a dated entry in §17 (Version history);
- no silent amendment — a change to the mandatory controls without a version bump and history entry is not a valid update to this standard.

### 16.3 Compliance evidence requirements

A workstream claiming compliance with this standard must be able to show, on request:
- which capabilities it introduced or touched;
- which numbered sections of this standard applied;
- the specific tests proving each applicable control (§2 through §15, as relevant);
- any exception taken under §16.1, with its approval record.

---

## 17. Version history

| Version | Date | Change | Approved by |
|---|---|---|---|
| 1.0 | 2026-08-30 | Initial canonical standard established (Wave 0), consolidating the Analyst Analytics Phase 0/Phase A planning closure decisions. | Product Owner |
