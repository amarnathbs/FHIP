# A3.1 — Content and Resources Migration

**Status: DONE** (see `A2A5_11` §3/§4 for the exact row-level register; this document gives the domain-specific detail the mission's own §9.2 checklist requires).

## Scope confirmed migrated

- Content authoring, editing, editorial review, compliance review, approval, publication: all under `admin/resources/content/**`, `admin/resources/{videos,glossary,money-updates,faqs}/**` — reachable via the canonical shell's Content area (`lib/admin/adminAreas.ts`), unchanged URLs (`A1_08` §5/§6).
- CTA assignment, author assignment, related-content management: `admin/resources/{related,ctas,context}/**`, grouped under Content's Discovery sub-group per `A1_06`.
- Work queues (drafts/review/scheduled/published/review-due/archived): `admin/resources/content/{drafts,review,scheduled,published,review-due,archived}`, folded into Content per `A1_06` §2.2. `scheduled` specifically remains `hide-until-ready` — see below.
- Task-help/manual paths: `lib/admin/taskHelp.ts`'s pre-existing A0.2 Wave 5 entries (ADM-08 through ADM-21) are reused verbatim, unedited by A2 or this dispatch.

## Preserved invariants (mission §9.1's explicit requirement)

- **Author/editor/reviewer/publisher separation**: unchanged — `lib/resources/permissions.ts`'s capability predicates (`canCreateResource`, `canReviewResource`, `canComplianceApproveResource`, `canPublishResource`) were not touched by A2 or this dispatch (confirmed: zero diff to that file across all 5 commits on this branch).
- **A0.2 atomicity**: the `transition_resource_post_status` RPC and its audit-in-the-same-transaction guarantee are unchanged (zero diff to any RPC/migration file touching Resources workflow).
- **Audit**: `resource_audit_log`/`resource_workflow_history` unchanged.
- **Result states, publication eligibility, private Draft behaviour**: unchanged — no page's rendering logic for these states was edited, only the shell/nav wrapping them.

## Not published as part of this work

No Resource was published, unpublished, or otherwise mutated by this dispatch or its verification steps — every check performed was either static analysis (`git diff`, `grep`) or a hermetic unit test using a mocked Supabase client (never a real database write). No synthetic fixture was created for this domain (consistent with `A2_10`'s "N/A — none was created" precedent, still true).

## Still blocked

Live-DEV, real-browser proof that the migrated shell renders and behaves correctly for a real Author/Editor/Compliance Reviewer/Publisher/Resource Admin session remains part of `A2A5_09`'s BLOCKED live-role matrix — no DEV credentials exist in this environment. This is a verification-evidence gap, not a functional defect (the underlying pages and their authorization are unchanged from their already-certified A0.2 state; only their nav wrapping changed, and that wrapping's logic is unit-tested — see `A2_09`, `tests/unit/adminA2CanonicalShell.test.ts`).
