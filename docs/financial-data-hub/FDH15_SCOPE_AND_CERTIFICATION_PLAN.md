# FDH-15 — Scope and Certification Plan

FRESH FDH-15 EXECUTION. FDH-14 terminally certified the standalone Financial Data Hub core
(`FDH14_COMPLETION_REPORT.md`, merged to `origin/main` at `179c60d`). FDH-15 certifies the NEXT
architectural boundary: **FDH structured evidence → domain proposal → compare → user decision →
explicit Apply → canonical FHIP data.**

## Starting point (verified by `git log`, not assumed)

- `origin/main` SHA at branch fork: `179c60d` (merge: FDH-14 Standalone Financial Data Hub
  Certification — TERMINAL FULL PASS). Confirmed via `git log --oneline -5` on this worktree.
- Branch: `cert/fdh15-bridge-governance-certification`.
- `git fetch origin` at the time of this pass showed `origin/main` unchanged at `179c60d` — no
  reconciliation was required (spec §203).
- Migration count at fork: 111 active migrations (0001–0115, with 0079/0080/0081/0103 unused
  gaps already present before this branch started).

## What FDH-15 owns (spec §3) vs. does not own (spec §4–6)

Owns: proposal creation/lifecycle, target-domain typing, canonical-target matching,
compare-vs-existing, user decisions (Add/Update/Keep), explicit/atomic Apply, idempotency, stale
detection, conflict handling, provenance, cross-document evidence, cross-domain economic
integrity, canonical ownership, cross-tenant/same-tenant authority protection, failure semantics,
UI bridge behaviour, manual-entry coexistence.

Does NOT own: FDH-13 Admin redesign, new parsers/adapters, new investment/retirement engines,
whole-application integration (FDH-16). Reused verbatim from FDH-14's own boundary statement
(`FDH13_ADMIN_GOVERNANCE_INTEGRATION.md`, `FDH14_COMPLETION_REPORT.md` "FDH-13" section).

## Method

1. **Discovery first** (spec §9–12): six parallel read-only investigations of the actual current
   source for Income (FDH-9), Liabilities (FDH-10), AU Investments (FDH-11), Retirement (FDH-12),
   Expenses (FDH-7/8), and the shared proposal framework/security patterns — before writing any
   inventory document. Findings feed `FDH15_BRIDGE_ARCHITECTURE_INVENTORY.md`.
2. **Reuse prior certified evidence explicitly, re-verify what matters** (rule 5/7): FDH-14 had
   already built a golden-household oracle, a foreign-canonical-target certification, and a
   multi-account/cross-border fixture — all against real hosted DEV. Those are REUSED EVIDENCE for
   architecture claims, but re-inspected here because FDH-14's golden-household oracle wrote
   canonical rows directly via service-role REST rather than invoking the real Apply RPCs — which
   does not meet FDH-15's own §215 bar for a *bridge Apply* decisive test. FDH-15 therefore built
   its own fresh live-DEV script that calls the real RPCs with a real authenticated-user JWT.
3. **No refactor for aesthetic consistency** (spec §12): Income/Liability/Retirement/AU-Investment
   bridges are NOT unified into one abstraction merely because they differ internally.
4. **Defect discipline** (spec §8): any genuine defect found is reproduced live, root-caused,
   fixed at the smallest correct scope, negative-controlled, and the affected module + FDH-15
   bridge gates are rerun. Two such defects were found and fixed this round — see
   `FDH15_RESIDUAL_RISK_REGISTER.md` and `FDH15_COMPLETION_REPORT.md`.
5. **Live DEV is decisive for security/provenance/stale/idempotency claims** (spec §149, §164–165,
   §215): every decisive Apply/security/provenance/cross-tenant test in this round was executed
   against real hosted Supabase DEV (`vqycarelcoijzwlpkpcz`) using a real `authenticated`-role JWT
   obtained via the documented password-grant technique, never the service-role key, for the
   mutating call itself. The service-role key was used only for synthetic-user creation, evidence
   fixture seeding, ground-truth re-queries, and cleanup.

## Deliverables

See `FDH15_COMPLETION_REPORT.md` §"Documentation Deliverables" for the full list and status of
every required document.
