# FDH-15 — Stale / Conflict Certification

## Mechanism (spec §35)

Every generic-bridge domain (Income, Liability, Retirement) uses the **same** mechanism: a
per-field TEXT snapshot (`fhip_import_proposal_fields.existing_value`) taken at proposal-generation
time. At Apply time, the RPC re-reads the live target row and recomputes the same serialised text
for every SELECTED field; any mismatch returns `STALE_PROPOSAL` with the field name, the snapshot
value, and the current value, and mutates nothing. This is a **value-comparison** staleness gate,
not an `updated_at`/version-column gate — deliberately, because `income_sources`/`liabilities`/
`retirement_accounts` have no DB-trigger-maintained `updated_at` guarantee project-wide
(`FDH9_REUSE_AND_GAP_AUDIT.md`). AU Investment uses a different, equally real mechanism: a
compare-and-swap on the evidence row's own `apply_status` column (`pending→applying`), backed by a
DB unique-index/fingerprint check on the canonical write itself.

The snapshot itself cannot be tampered with to defeat the check: `fhip_import_proposal_fields` has
no UPDATE policy at all for the authenticated role.

## Required scenario, live-reproduced (spec §34, Income)

1. Canonical `income_sources.frequency = 'monthly'` (version A).
2. Proposal generated proposing `frequency = 'fortnightly'`, snapshot `existing_value='monthly'`.
3. User independently PATCHes their own row to `frequency = 'weekly'` (version B) — a real
   authenticated PATCH, not a service-role edit.
4. Apply is attempted.

**Result (INC-4/INC-4b, live on DEV)**: `STALE_PROPOSAL`, and the canonical value remains the
user's manual edit (`weekly`) — not silently overwritten with the proposal's stale target
(`fortnightly`), and not reverted to the original snapshot (`monthly`).

## Competing proposals (spec §62)

Not independently live-tested this round as a dedicated two-proposal scenario (time-boxed out);
architecturally, the mechanism above generalises directly: Proposal A applied first changes the
canonical row's live value, so Proposal B's later Apply attempt (referencing its own, now-stale
snapshot of the pre-A value) is guaranteed to hit the identical `STALE_PROPOSAL` path unless B's
selected fields happen to be disjoint from A's — in which case both can legitimately apply, which
is the correct, non-silent outcome for non-overlapping field-level changes. Disclosed as
architecturally-covered-but-not-freshly-live-tested (P3 residual — the underlying mechanism IS
freshly live-tested via the single-proposal scenario above).

## Manual edit after proposal / new statement after manual override (spec §187–188)

The stale-detection mechanism above IS the enforcement for both scenarios: any proposal generated
before a manual edit will have a snapshot that no longer matches, so a subsequent Apply attempt
(old or freshly regenerated-then-compared) is blocked/refreshed by the same value-comparison gate.
A freshly regenerated proposal, by construction, re-reads the CURRENT canonical value at generation
time, so its own snapshot reflects the manual override — confirmed by reading
`incomeProposalService.ts#generateIncomeProposal()`/`retirementAdapter`, both of which query the
live table at generation time, never a cached/stale copy.

## Older statement applied after newer canonical state (spec §127)

Not independently live-tested as a distinct multi-statement-ordering scenario this round; covered
by the same per-field value-comparison mechanism (an older statement's snapshot will mismatch the
newer canonical value on any overlapping field) — same P3 disclosure as competing proposals above.

## NEW this round — Self/Spouse target-forgery is a stale/conflict-ADJACENT class, now closed

Migrations `0119`/`0120` add a **`MEMBER_MISMATCH`** outcome, distinct from `STALE_PROPOSAL`,
for the case where the target's household member/owner does not match the evidence's resolved
member — see `FDH15_RESIDUAL_RISK_REGISTER.md` (FDH15-DEF-001/002) for the full defect record and
live-DEV negative-control reproduction, and `FDH15_CANONICAL_TARGET_AND_OWNERSHIP_MATRIX.md` for
the architectural placement of this new guard.
