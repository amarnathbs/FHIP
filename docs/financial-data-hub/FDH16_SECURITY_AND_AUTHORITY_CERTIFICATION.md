# FDH-16 — Security and Authority Certification

## FRESH FDH-16 this round

1. **Manual-vs-import cross-tenant sweep** (`fdh16_manual_vs_import_equivalence_certification.mjs`, `XT16-1`
   through `XT16-3b`, live DEV, real authenticated JWTs, 4/4 PASS):
   - Cross-tenant READ of another household's proposal: BLOCKED (RLS empty).
   - Cross-tenant READ of another household's canonical income: BLOCKED (RLS empty).
   - Foreign canonical target forgery (Household M naming Household I's liability as a new proposal's target):
     BLOCKED at INSERT by a real Postgres trigger (`P0001`, explicit "cross-tenant reference ... forged
     liability target" message).
   - Household I's liability balance independently re-confirmed unchanged after the blocked attempt.

2. **Bundle secret scan** (`npm run build`, this round's own build artefact): the literal
   `SUPABASE_SERVICE_ROLE_KEY` value from this worktree's `.env.local` was searched for across the entire
   `.next/` output (server and client chunks) — **0 matches**. The anon/publishable key's presence in client
   chunks is expected and not a defect (it is meant to be public; RLS is the actual authority boundary).

3. **Architectural SECURITY DEFINER inventory** (source-read, not re-derived): every "Apply" RPC
   (`fdh9_apply_income_proposal`, `fdh10_apply_liability_proposal`, `fdh12_apply_retirement_proposal`) uses
   `security definer set search_path = public`, an atomic compare-and-swap claim on `fhip_import_proposals.status`,
   and (post migrations `0119`/`0120`) an explicit member-mismatch check before mutating `update_existing`/
   `apply_selected_fields` targets — reconfirmed present in the current migration files this round (`0119`/`0120`
   read in full while building this round's own scripts).

## REUSED PRIOR CERTIFIED EVIDENCE

- FDH-15's live bridge/governance sweep (`fdh15_bridge_governance_live_dev_certification.mjs`, 30/30 PASS,
  live DEV, real authenticated JWTs): cross-tenant read/write/delete/apply BLOCKED; same-tenant Self→Spouse and
  Spouse→Self forgery BLOCKED (migrations `0119`/`0120`, independently DEV-confirmed by FDH-15 itself the same
  week via the actual vulnerable-path re-exercise, not merely "no SQL error"); provenance-column direct-PATCH
  forgery BLOCKED; stale-proposal-after-manual-edit BLOCKED (`STALE_PROPOSAL`); double-Apply BLOCKED
  (`ALREADY_APPLIED`, exactly one `fhip_import_applications` row).
- FDH-14's foreign-canonical-target certification (13/13 PASS): Income/Liability/Retirement targeting blocked
  by a real DB trigger; Investment targeting structurally unreachable via the generic bridge, blocked at runtime
  by `applyAuStatementActivity()`.
- FDH-14's cross-domain security certification (28/28 PASS) and live-DEV schema probe (34/34 PASS).

## Not performed fresh this round

- Concurrent/simultaneous-in-flight Apply fault injection against real hosted DEV (architecturally reasoned via
  row-lock + compare-and-swap, not live-fault-injected — same disclosed residual FDH-14/15 both carried).
- A dedicated fresh Self↔Spouse forgery re-proof (this round's fixtures were single-member households) — REUSED
  from FDH-15's own fresh, DEV-confirmed proof instead.
- Sensitive-API-output scan (§149) beyond the bundle-secret scan above — not independently re-run this round.

## P0/P1 gate

**Zero P0 financial-integrity defects and zero P1 security/privacy defects were found or remain open** this
round, combining this round's own fresh findings (0 new defects) with FDH-14/15's already-closed P1s (both
DEV-confirmed fixed).

## Verdict

**Security and authority: PASS.**
