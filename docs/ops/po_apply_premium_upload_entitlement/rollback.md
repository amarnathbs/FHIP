# Rollback -- Premium Upload Entitlement

This release is **code-only**: no migration, no SQL apply part, no environment variable, no configuration change. It never writes
`user_entitlements` and adds no table, column, policy or function. Rolling back therefore cannot touch imported data, payment
entitlements, or any record.

## Steps (any one is enough)

1. **Amplify**: redeploy the previous successful build of `main` (Amplify console -> the app -> the previous deployment -> Redeploy this version).
2. **Git**: `git revert -m 1 <merge-commit-sha>` on `main`, push, let Amplify build. (If it was fast-forwarded, revert the range `git revert <first>^..<last>`.)

## What a rollback restores

* Free users can upload again through every path (the pre-change behaviour).
* Nothing imported while the gate was live is affected: documents admitted by Premium users stay, canonical data stays, the
  `import_entitlement: 'premium'` marker on `document_upload_created` audit events simply stays in the audit history (harmless).

## What a rollback does NOT change

* Payments, entitlements, webhooks, pricing, tax, receipts: untouched by this change in both directions.
* The AI-access programme's own Premium AI gate (separate branch).
