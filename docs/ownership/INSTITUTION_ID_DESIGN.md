# institution_id for bank statements -- discovery, design, what was built (PO-OBU-06)

Status: **CODE COMPLETE for the narrow slice below; test-verified; NOT DEV-certified, not deployed.** Written 2026-10-02 on `feat/owner-before-upload-phase1-20261001`.

## 1. The problem

The Expenses "Import bank statement" panel sends **no** `institution_id` (the user does not know FHIP's institution ids, and typing a bank name is free text). So every account the panel ever created had `institution_id = NULL`, and `account_fingerprint = sha256([userId, 'none', currency, last digits])`. Consequences found while building "which account is this statement for?":

1. **Two different banks in the same currency whose accounts end in the same 4 digits had the SAME fingerprint.** The unique index `uq_fdh_accounts_fingerprint (user_id, account_fingerprint)` would reject the second account, and the "add as a new account" path found the first bank's account by fingerprint and **silently reused it** -- two banks merged into one account.
2. A statement could not be tied to a bank at all, so "the only account" was claimed by whichever statement came first.

## 2. Discovery (what already exists -- nothing needed inventing)

| Question | Finding |
|---|---|
| Institution master tables | `fdh_financial_institutions (id, country_code, institution_code, institution_name, institution_type, active, ...)`, unique `(country_code, institution_code)` (migration 0045; extended and **seeded** with the AU / India library by FDH-2, migrations 0051 / 0054, which carry a genuine production certification). `fdh_financial_accounts.institution_id` and `fdh_statement_uploads.institution_id` reference it. |
| Bank adapter identifiers | Every certified bank adapter (CSV `lib/financial-data-hub/bank-csv/adapters/{au,in,generic}Adapters.ts`, PDF `.../bank-pdf/adapters/{au,in}Adapters.ts`) declares `institutionCode` (`cba`, `westpac`, `nab`, `anz`, `macquarie_bank`, `sbi`, `hdfc_bank`, `icici_bank`, `axis_bank`, `kotak_mahindra_bank`) and a `displayName`. The generic (country-neutral) adapters declare `institutionCode: null` -- they name no bank. |
| Adapter -> master mapping | The adapter `institutionCode` **is** the master's `institution_code` (the live certification scripts already look institutions up with `institution_code=eq.cba&country_code=eq.AU`). No translation table is needed. |
| Account fingerprint logic | `computeAccountFingerprint({userId, institutionId, currencyCode, maskedIdentifierNormalised})` (`bank-csv/accountIdentity.ts`) -- already includes `institutionId`; only the *value* was always `none`. |
| Upload loaders | `loadExistingAccountsForInstitutionCurrency` filters `institution_id = X` or `IS NULL` exactly. |
| AU / India catalogues | The same master (country-keyed), so an India HDFC statement resolves `(IN, hdfc_bank)`, never an AU row. |

## 3. Design

**The server derives the institution; the client never supplies one.**

1. The certified adapter that recognises the statement (CSV detection / PDF detection -- deterministic, local, no AI) yields an `institutionCode`. `readStatementIdentityFromStoredFile` now returns it alongside the bank display name and the **last 3-6 digits only**.
2. `resolveInstitutionIdByCode(countryCode, institutionCode)` looks it up in `fdh_financial_institutions` by **(country, code)** among **active** rows. Not found -> `null`: an id is **never invented** and **never derived from free text** (the typed account name is display-only).
3. `resolveStatementAccount` then matches accounts on that institution:
   - an account of **that** institution, or a **legacy** account with no institution (offered, matched by last 4 digits, **never rewritten**);
   - an account of a **different** institution never matches, is never offered, and picking it is refused (`institution_mismatch`).
4. A **new** account is created with that `institution_id` and a fingerprint that includes it, so **two banks, same currency, same last 4 digits = two accounts** with two fingerprints.
5. When a statement is assigned to an account that has an institution, the document takes the account's `institution_id` (the pair stays consistent).
6. When the bank is **known**, "the only account" no longer means "the only legacy account": a lone institution-less account is shown in the picker but is not auto-claimed.
7. Where no certified adapter names a bank (generic CSV, unreadable PDF, a code absent from the master) behaviour is exactly the previously approved fallback: bank name + trailing digits, `institution_id` stays `NULL`.

**Controlled legacy reconciliation strategy.** Accounts created before this change keep `institution_id = NULL` and their old fingerprint. They are not migrated, backfilled or merged by any script. They remain candidates for matching statements (by last 4 digits, narrowed by the displayed bank name) and are assigned only by the existing deterministic rules or by the user's explicit pick. A later, deliberate programme can offer "this account is HDFC Bank" as a user-confirmed action that recomputes the fingerprint and checks uniqueness; it is **not** done silently here.

## 4. Privacy

Only the trailing 3-6 digits of an identifier are ever read, stored, shown or sent (`trailingDigits`, `lastDigitsForDisplay`, the 4-6 digit check on user-entered digits, the DB check against 7+ digit runs). The institution code is a public catalogue key, not personal data. The reader runs **after** `checkFdhDocumentMalwareAdmission` (a blocked / never-scanned document is not parsed).

## 5. Tests (all in `tests/unit/bankAccountAssignment.test.ts`, 57 tests)

Two banks / same currency / same last 4 -> two accounts, two institutions, two fingerprints, and each document carries its account's institution; a repeat upload from the same bank finds its account silently; a Westpac statement is not offered (and cannot pick) the CBA account; a legacy account stays a candidate, is matched but not rewritten, and a lone legacy account is not auto-claimed for a known bank; an adapter code absent from the master yields no id and the fallback still works; the master is keyed by country and code; the reader returns the code and never a full number.

**Negative controls (each proven by breaking the rule and seeing named failures):** institution never resolved -> the two-banks test and the legacy test fail; any institution matches -> the Westpac test and the existing institution-mismatch test fail; a lone legacy account auto-claimed -> the legacy test fails; master not keyed by country -> the country test fails; the document keeps no institution -> the two-banks test fails; malware admission removed -> the malware-boundary test fails.

## 6. What this does NOT do (deliberately)

- It does **not** make the Expenses panel send an `institution_id`. The panel cannot know one; sending a user-typed name would be free text. If a future UI offers a **picker over the master** ("Which bank?"), it can send that id; the server logic above already honours a document that arrives with an `institution_id` (exact match).
- It does not migrate legacy accounts (section 3, last paragraph) and ships **no SQL**: no migration is needed; the columns, the master and its production seed already exist.
- It covers **bank** accounts. Credit-card / loan / retirement / investment institutions keep their existing resolution; the same pattern (adapter code -> master) is the extension point.
- Not DEV-verified: a real DEV account list may contain institution-less accounts of several banks; the rules above only ever add a match, never merge or rewrite.
