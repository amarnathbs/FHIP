# Premium Upload Entitlement -- PO apply pack

Branch: `feat/premium-upload-entitlement-20261014`. **Code-only release**: no migration, no SQL to apply, no Amplify environment variable. The things to
run on a database are **read-only** (`01_precheck_readonly.sql`, `03_verification_readonly.sql`).

## Ordered steps

1. **Review** the branch. Developer reference: `docs/entitlements/PREMIUM_UPLOAD_ENTITLEMENT.md` (the rule, the one capability, the full 28-route matrix,
   the downgrade policy, the known limits). Decide the sequencing with the AI-access branch (`feat/ai-premium-wide-access-20261014`): the two touch some of the
   same files (listed in the programme report); either order works, expect a small textual merge in those files. After the second merge re-run
   `npx vitest run tests/unit/premiumUpload*.test.ts` and `npx tsc --noEmit`.
2. **Pre-check (optional)**: run `01_precheck_readonly.sql` on production; keep the output.
3. **Push** (you push; the agent cannot): the exact command with the verified SHA is in the programme report. Immediately before pushing:
   `git fetch origin` then `git merge-base --is-ancestor origin/main <sha>`; if it fails, `main` moved -- merge `origin/main` into the branch and re-run the gates.
4. **Wait for Amplify** to show the deployment of that SHA as *Deployed*. Record the build id and the time it went live.
5. **Verify on production** with synthetic users only: `SYNTHETIC_PRODUCTION_TEST.md` (probe script `synthetic_probe.js`, evidence form `EVIDENCE_TEMPLATE.md`),
   then `03_verification_readonly.sql` with the release timestamp.
6. **Decide the verdict** with the evidence: the report states the exact wording each level of evidence supports. Nothing is "production verified" until step 5 is done.

## Production has no managed backups

Nothing in this pack changes or deletes production data, so no backup is needed. Step 5's optional real upload creates and then deletes one synthetic document through
the app's own delete; if you choose to clean up anything by SQL instead, take a manual table backup of the affected tables first.

## Rollback

`rollback.md` -- redeploy the previous Amplify build, or revert the merge. No data impact in either direction.

## Files

| File | Purpose |
|---|---|
| `01_precheck_readonly.sql` | Read-only: plan counts, the entitlement shape, the storage policies, baseline document count |
| (no `02` file) | There is nothing to apply: the release is code-only |
| `03_verification_readonly.sql` | Read-only: every document admitted since the release is stamped Premium; plan counts unchanged |
| `SYNTHETIC_PRODUCTION_TEST.md` | The production test procedure, step by step, with expected results and cleanup |
| `synthetic_probe.js` | Browser-console probe: 28 requests that cannot create data; run once as Free and once as Premium |
| `EVIDENCE_TEMPLATE.md` | The form to fill in and attach |
| `rollback.md` | Code rollback; no data impact |
