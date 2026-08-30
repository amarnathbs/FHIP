# FDH-12 — Security Certification

Spec sections 87-92, 96-103, 163, 169-170.

Harness: `scripts/fdh12_certification.mjs` — a clean rebuild of the entire
101-migration chain on real PostgreSQL 18 (PGlite), real multi-tenant data,
`set_config('request.jwt.claims', ...)` + `set role` to exercise RLS and
triggers for real.

**Result: 53 checks, 53 PASS, 0 FAIL.**

## Same-tenant authority (spec 96)

Six real forgery attempts as the `authenticated` role, each refused with
`this field is system-authoritative`:

| Forged field | Result |
| --- | --- |
| `reconciliation_status` → `reconciled` | BLOCKED |
| `account_match_status` → `matched` | BLOCKED |
| `approval_status` → `approved` | BLOCKED |
| `canonical_account_id` → own account | BLOCKED |
| `closing_balance` → `999999.00` | BLOCKED |
| `smsf_classification` → clearing a real SMSF flag | BLOCKED |

The last one is the sharpest: the statement is first set to `possible_smsf` by
the service role, so the attempt is a real state change — a user must not be
able to clear their own SMSF routing flag and thereby unlock an import.

**Two positive controls prove these are not vacuous:**
* the user CAN edit their own `nickname` (so not all updates fail);
* the service-role bridge CAN write the authoritative columns (so the real path
  works).

## Anti-vacuity self-check

Section 7 rebuilds the database with the authoritative-write trigger
**deliberately removed**, and confirms the forgery then SUCCEEDS. The harness
throws if its own removal regex stops matching, so it cannot drift out of sync
with the migration and silently stop testing anything.

## Cross-tenant security (spec 97-102)

| Control | Spec | Result |
| --- | --- | --- |
| Tenant B reads A's statement | 97 | BLOCKED (RLS returns no rows) |
| Tenant B writes A's statement | 97 | No effect |
| Tenant B applies A's proposal | 97 | `PROPOSAL_NOT_FOUND`, A's balance unchanged |
| A's statement targets B's retirement account | 98 | BLOCKED — `cross-tenant reference` |
| A's activity links B's bank transaction | 99 | BLOCKED |
| A's activity links B's payslip | 100 | BLOCKED |
| A's statement attaches B's member row | 101 | BLOCKED |
| A's activity references B's statement | — | BLOCKED |
| Global reference data mutated by import | 102 | No write path exists |

Every cross-tenant FK test is issued **as `service_role`**, so RLS is out of the
picture and the ownership TRIGGER alone is under test. A positive control
confirms the tenant's OWN member attaches successfully.

The bridge's own guards were extended for the retirement domain
(`fdh9_assert_proposal_owner` / `fdh9_assert_application_owner`), so spec
section 98 is enforced at the proposal and application layers too.

## Apply security (spec 104-110)

| Control | Result |
| --- | --- |
| Duplicate apply | `ALREADY_APPLIED`; balance unchanged; exactly one application row |
| Concurrent apply (two in parallel) | Exactly ONE succeeded; exactly one application row |
| Stale proposal | `STALE_PROPOSAL`; the user's newer value preserved |
| `target_retirement_age` in a forged proposal | `FORBIDDEN_FIELD`; member's age unchanged (67) |
| Selective apply | Selected field applied; unselected field left `null` |
| Keep existing | `kept_existing`; canonical unchanged |
| Unapproved evidence | `EVIDENCE_NOT_APPROVED` |
| SMSF target | `SMSF_ACCOUNT_NOT_IMPORTABLE`; SMSF balance unchanged |
| Atomicity on failure | No application row; proposal still `ready`; balance not partially written |

## Deduplication as a DB constraint (spec 22, 38, 51-53)

Three real unique indexes, all proven live:
* a duplicate activity fingerprint is rejected (`23505`);
* NULL fingerprints do NOT collide (the index is partial);
* one payslip cannot evidence two fund contributions.

## Privacy (spec 87-90)

Not persisted anywhere in the schema — asserted by scanning migration 0112 for
each token: `tfn`, `tax_file_number`, `pan_number`, `beneficiary`,
`date_of_birth`. Full bank details and addresses have no column either.

`masked_account_identifier` is protected by a DB CHECK (`!~ '[0-9]{7,}'`) and
by a matching Zod refusal in the upload route.

## Password-protected PDFs (spec 92)

Reuses FDH-3/FDH-5's transient handling unchanged. FDH-12 adds no password
column, no password log and no password parameter of its own — PDFs are not a
supported layout in this release at all.

## Raw document lifecycle (spec 91)

Reuses FDH-3 unchanged: private `fdh-source-documents` bucket, SELECT-only
storage RLS scoped to the user's own folder, service-role writes, byte-hash
duplicate flagging, and the existing purge schedule. FDH-12 establishes no
permanent raw retirement-document storage of its own.

## Logging (spec 170)

FDH-12 emits no `console.log` of statement content. Audit events record
identifiers and counts only — statement id, outcome, reason code, match counts
— never amounts, member numbers or document bytes. Failure `error_code` values
come from FDH-1's controlled taxonomy, never a stack trace.

## Bundle security (spec 169)

Scanned the production build: **101 client files** in `.next/static` and
**3,582 server files** in `.next/server`, for verbatim occurrences of every
private `.env.local` value plus service-role JWT claims, TFN patterns,
unmasked identifiers and raw-document references.

**Client bundle: 0 findings.** No service-role key, no `CRON_SECRET`, no
`RESEND_API_KEY`, no `createAdminClient`, no private value.

One server-only finding, disclosed honestly: `CONTACT_FROM_EMAIL` (a sender
address, not a credential) appears in a server chunk for the pre-existing
contact route. It is server-only, never shipped to a browser, unrelated to
FDH-12, and present on `origin/main`.

`NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` appear in the
client bundle **by design** — that is what the `NEXT_PUBLIC_` prefix means —
and are excluded from the private-value set.

## What was NOT done — honestly disclosed

* **Live-DEV security probing of FDH-12's own tables has not been performed**,
  because migration 0112 has not been applied to DEV. Applying it is the
  Product Owner's action, per this project's standing convention. Everything
  above is real-Postgres (PGlite) evidence, not simulation, but it is not
  hosted-DEV evidence.
* Live-DEV probes WERE run against the canonical tables FDH-12 depends on (see
  `FDH12_LIVE_DEV_CERTIFICATION.md`).
* No malware scanning of uploaded documents — inherited FDH-3 residual,
  unchanged by FDH-12.
