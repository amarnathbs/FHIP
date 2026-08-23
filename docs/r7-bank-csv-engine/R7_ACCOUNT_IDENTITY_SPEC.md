# R7 — Account Identity Specification

## Fingerprint (`computeAccountFingerprint()`, spec §30)

```
sha256(JSON.stringify([userId, institutionId ?? 'none', currencyCode, maskedIdentifierNormalised ?? 'unidentified']))
```

Populates `fdh_financial_accounts.account_fingerprint` for the first time — the column was reserved-but-unpopulated since FDH-1 pending exactly this kind of matching logic. One-way (SHA-256, never reversible), and inherently tenant-scoped (`userId` is part of the hash input, so two users can never collide even with identical institution/identifier — R7-TC127).

## Masked-identifier safety (`normaliseMaskedIdentifier()`)

Rejects any string containing 7+ consecutive digits BEFORE it ever reaches a database write — a client-side mirror of `fdh_financial_accounts.chk_fdh_accounts_masked_identifier`'s own check constraint (R7-TC122). An AU BSB+account number or an Indian 11-18-digit account number cannot pass; `"****1234"` can.

## Resolution decision table (`resolveAccountIdentity()`, spec §30-31)

| Identifier supplied? | Existing accounts for (institution, currency) | Outcome |
|---|---|---|
| Yes, matches an existing fingerprint | — | `reuse` that account |
| Yes, no match | — | `create` a new account |
| No | 0 existing | `create` a new account (nothing to conflict with) |
| No | exactly 1, created WITHOUT an identifier (same "unidentified" fingerprint) | `reuse` it |
| No | exactly 1, created WITH a real identifier | **`ambiguous`** — never silently attach an unidentified import to a specifically-identified account |
| No | 2 or more | **`ambiguous`** — which one is this? |

Every `ambiguous` outcome halts the import: `financial_account_id` stays null on the document, a blocking `fdh_review_items` row is raised (`review_type='other'`, `title_code='bank_csv.account_identity_ambiguous'`), and `processBankCsvDocument()` refuses to run the parsing pipeline at all until the ambiguity is resolved (ACCOUNT_REVIEW_REQUIRED fail-safe, spec §31, §91's "two accounts incorrectly merged" critical-fail condition).

## Where the identifier comes from

R7 does not extract an account number from CSV row content by default (real bank exports rarely repeat it per-row, and doing so risks over-collecting sensitive data). Instead `POST /bank-csv/upload` accepts an optional `masked_identifier` query parameter — a value the USER already typed (e.g. "the account ending 1234"), validated by the same 7-digit guard before ever being persisted.

## Multi-currency safety (spec §61 bucket, R7-TC126)

The fingerprint includes `currencyCode` — the same institution + masked identifier in two different currencies (e.g. an AUD and a USD sub-account at the same bank) fingerprints differently and is never merged.

## Certification (cases R7-TC121-R7-TC130)

13 cases covering masked-identifier acceptance/rejection, fingerprint determinism/currency-scope/tenant-scope/one-wayness, and all five resolution-table rows — all pure, DB-free, run in `tests/unit/r7AccountIdentity.test.ts`.
