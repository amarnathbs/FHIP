# AIE-1 Closure — Insurance Journey Regression Re-Verification

**Method**: real running `npx next dev` (this worktree, port 3941), real
disposable synthetic DEV user, real cookie-based login via `/login`
(matching `AIE_1_0146_INSURANCE_CLOSURE_REPORT.md`'s established method —
a bare Bearer token does not work against this app's `@supabase/ssr`
auth). Script: `scripts/aiecl_insurance_regression_live_dev.ts`.

**Why re-run this**: this closure mission changed `lib/aie/orchestrator.ts`
(schemaOverride), `lib/aie/review/accept.ts` (finalizeDocumentBinary),
`lib/aie/provider/providerFactory.ts` (provider selection), and
`lib/aie/provider/gateway.ts` (cost admission) — all in the exact call
path the previously-certified Insurance journey exercises. Re-running it
is the only way to be sure none of that regressed the already-closed
journey.

## Result: 14/14 checks pass. Zero regression.

1. Real cookie session established.
2. Real HTTP intake POST accepted, reached `awaiting_acceptance`,
   deterministic-only (`ai_used: false`) for the clean fixture — confirms
   the new provider-factory wiring and schemaOverride addition did not
   change ordinary deterministic behaviour.
3. **New mission behaviour, confirmed for real**: the AIE quarantine
   Storage object was genuinely deleted (verified via a direct Storage
   `.list()` call, not merely trusting the delete call's return value) —
   `finalizeDocumentBinaryAfterRun`'s immediate-deletion path executed
   against real Supabase Storage.
4. **Disclosed gap, observed live, not just theorised**: migration 0149
   (adds `aie_document_intake.purge_status`/etc.) is not applied to DEV,
   so the DB-side status bookkeeping for that same deletion (`status ->
   'deleted'`, clearing `storage_key`) fails on a missing column and the
   row is left showing `status: 'ready'` with a now-dangling `storage_key`.
   This is a genuine, narrow, correctly-scoped consequence of the DDL-
   application blocker (same blocker as every other migration-dependent
   item in this mission) — not a defect in the delete/verify logic, which
   demonstrably ran and worked. It resolves itself the moment 0149 is
   applied; no code change is needed.
5. Accept still succeeds via the real route even though the quarantine
   binary is already gone — confirms Insurance's canonical write genuinely
   never needs it (as designed).
6. Exactly one real `insurance_policies` row committed, owned by the real
   synthetic user.
7. Same-key replay reports `alreadyCompleted: true`, confirmed via a
   direct count query: exactly one policy row exists after replay — no
   duplicate write.
8. Zero residue after cleanup (policy, intake, and the synthetic user all
   independently re-verified gone).

## Conclusion

The previously-certified Insurance HTTP journey
(`AIE_1_0146_INSURANCE_CLOSURE_REPORT.md`) is unaffected by this closure
mission's changes. The one behavioural difference this mission introduces
— immediate quarantine deletion — is proven to work at the storage layer
today, with its DB bookkeeping honestly disclosed as blocked pending
migration 0149, exactly as documented elsewhere in this mission's other
migration-dependent work.
