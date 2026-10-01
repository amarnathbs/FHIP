# Canonical-upload certification harness (DEV only)

Shared tooling for the certifiers of the Approved Upload -> Canonical User Data programme.
Everything targets DEV (`vqycarelcoijzwlpkpcz`); `lib/env.mjs` refuses any other project. Production is
never touched. Working files (ledgers, live session cookies, generated documents) go in `.canonical-cert/`,
which is gitignored.

## 0. Worktree setup

```powershell
New-Item -ItemType Junction -Path <worktree>\node_modules -Target D:\FHIP\.claude\worktrees\agent-aaa494ea60276ca67\node_modules
Copy-Item D:\FHIP\.env.local <worktree>\.env.local      # never print it
git config core.longpaths true
```

The fixture files are gitignored and are read from `D:\FHIP\User tests\...` automatically.

## 1. Dev server on your own port

| Range | Port |
|---|---|
| A | 3971 |
| B | 3972 |
| C | 3973 |
| D | 3974 |
| harness smoke | 3970 |

```bash
node scripts/canonical_cert/dev_server.mjs --range A          # run in the background
node scripts/canonical_cert/dev_server.mjs --wait --port 3971  # blocks until GET /login answers
```

- Binds to `127.0.0.1` only. Use `http://127.0.0.1:<port>`.
- `PRODUCTION_*` keys and `AIE_OPENAI_API_KEY` are set to `''` in the child. Deleting them is not enough, because
  Next re-reads `.env.local` and fills any key that is undefined. `check_child_env.mjs` proves this, with a
  negative control. Pass `--allow-openai` only if a journey really needs the AI fallback.
- With a junctioned `node_modules`, Turbopack refuses to start ("Symlink [project]/node_modules is invalid").
  The script therefore uses `--webpack` automatically. The first compile of a route takes about 30 s.
- Run one dev server per worktree.

## 2. Users: existing fixture users only, disjoint ranges

```bash
node scripts/canonical_cert/users.mjs show A        # your users: email, DEV id, sign-in methods, gate state
```

`USER_RANGES.json` is derived deterministically from the two fixture files. Regenerate it with
`users.mjs allocate`, which is read-only on DEV.

| Set | Users | Password in fixture? | Sign-in |
|---|---|---|---|
| FCAST (`forecast.tcNNN@example.test`) | 50 | yes (`User tests/forecasting test/...json`) | `password` or `mint` |
| E2E50 (`fhip.e2e.tcNNN@test.fhip.invalid`) | 50 (49 allocated) | no (random at seed time) | `mint` only |

- The ranges hold 25/25/25/24 users. Each range has about 13 AU and 12 IN users.
- `fhip.e2e.tc050` is held back for the harness smoke test.
- Every fixture user already carries standing fixture data (income, expenses, assets, and more). Assert
  journeys as DELTAS against the ledger baseline. For the golden pair, compare the change in M against
  the change in I, not absolute totals.
- Every fixture user starts **country-unconfirmed**, and the upload and apply routes refuse such users.
  `residue.mjs prepare` confirms the country through the real route and restores the profile afterwards.
- FCAST users have **0 household members**. Flows that need an owner member (AU investment Apply) must
  first create one through `POST /api/household-members`. The ledger captures and removes it.

## 3. Sign in

```bash
node scripts/canonical_cert/signin.mjs --range A --email forecast.tc001@example.test --method mint
node scripts/canonical_cert/signin.mjs --revoke --email forecast.tc001@example.test     # always, at the end
```

- `mint`: the service role runs `generateLink`, then `verifyOtp` runs with the hashed token. No password is
  used and no email is sent. The script refuses if the user does not already exist, so it never creates an
  account. The cookies are produced by `@supabase/ssr` itself.
- `password`: reads the FCAST fixture password at runtime and never prints it. This harness has not
  exercised this method.
- For HTTP journeys, use `api(email, method, route, {port, json | body+contentType})` from
  `lib/session.mjs`. It sends the cookies and folds refreshed cookies back into the session file.
- For a Browser pane tab on `127.0.0.1:<port>`, `signin.mjs ... --browser-js` prints `document.cookie`
  statements. This prints a live token, so revoke the session afterwards. This path has not been tested.

## 4. Residue ledger (zero residue, proven)

```bash
L=A-run1
node scripts/canonical_cert/residue.mjs baseline --ledger $L --emails a@x,b@y   # BEFORE anything else
node scripts/canonical_cert/residue.mjs prepare  --ledger $L --email a@x --port 3971
#   ... journeys through the app ...
node scripts/canonical_cert/residue.mjs record   --ledger $L --table <t> --ids <id,...>   # rows in tables WITHOUT a user column
node scripts/canonical_cert/residue.mjs cleanup  --ledger $L                   # capture new rows, delete by PK, restore saved rows
node scripts/canonical_cert/residue.mjs verify   --ledger $L                   # exit 0 only when identical to baseline
```

- The baseline snapshot records the primary key of every row in every DEV relation that has a user
  column: `user_id`, `requested_by_user_id` and similar (158 relations today). It also records every
  storage object under `<userId>/` in the 4 app buckets.
- `cleanup` deletes by primary key only and repeats until nothing changes, which handles FK order. Rows
  that existed at baseline are never deleted.
- `verify` compares key sets per table, per user. It also checks every saved-and-restored row
  column-by-column (`updated_at` is excluded) and every recorded global row.
- An UPDATE to a pre-existing fixture row is invisible to a key diff. Save the row first with
  `ResidueLedger.snapshotRows()`; `prepare` already does this for `user_profiles`.
- `residue.mjs touched --ledger $L` lists rows that existed at baseline and have `updated_at` on or after the
  ledger's start (exit 1 if any was not saved first). Run it before `cleanup`: an Apply that updates a fixture
  row (e.g. a retirement statement applied to an existing account) leaves residue that `verify` cannot see.
  Tables without `updated_at` are not covered.
- Known residue that cannot be avoided: a sign-in updates `auth.users.last_sign_in_at` and writes GoTrue's
  own audit log. Neither is reachable through PostgREST.

## 5. Synthetic documents

```bash
npx tsx scripts/canonical_cert/documents/build_documents.ts --salt A --month 2026-08   # -> .canonical-cert/docs-A/
```

The output is a payslip PDF, the oracle bank CSV, 1000-line and 1001-line bank CSVs, a card CSV, a loan
CSV, broker transaction and portfolio CSVs, and retirement summaries for fund A and fund B. It also writes
`manifest.json` with each file's sha256, its upload recipe (route, query, next calls) and its oracle.

- All names are fictional: "FHIP Test Bank", "FHIP Test Card", "FHIP Test Broker", "FHIP Test Super
  Fund A/B", "Test Person Alpha".
- `tests/unit/canonicalCertHarnessBuilders.test.ts` runs every builder through the real parsers, each with a
  negative control.
- Card and loan documents use day numbers above 12. With days of 12 or less, the dates are ambiguous
  between DD/MM and MM/DD, and the liability extractor refuses the file.

## 6. Worked example (the harness smoke test)

```bash
node scripts/canonical_cert/residue.mjs baseline --ledger SMOKE2 --emails fhip.e2e.tc050@test.fhip.invalid
node scripts/canonical_cert/residue.mjs prepare  --ledger SMOKE2 --email fhip.e2e.tc050@test.fhip.invalid --port 3970
npx tsx scripts/canonical_cert/smoke_journey.ts --email fhip.e2e.tc050@test.fhip.invalid --port 3970 --salt Z
node scripts/canonical_cert/residue.mjs verify   --ledger SMOKE2   # NEGATIVE CONTROL: exits 1 and names the residue
node scripts/canonical_cert/residue.mjs cleanup  --ledger SMOKE2
node scripts/canonical_cert/residue.mjs verify   --ledger SMOKE2   # exits 0
node scripts/canonical_cert/signin.mjs --revoke --email fhip.e2e.tc050@test.fhip.invalid
```

## 6b. Scale and UI journeys (scale-and-ui certifier)

```bash
node scripts/canonical_cert/dev_server.mjs --port 3973 --count-requests      # Supabase round trips per server process
npx tsx scripts/canonical_cert/scale_journey.ts --email <e> --port 3973 --n 1000 --salt C --repeat reexport --out test-artifacts/canonical_cert/scale-1000.json
npx tsx scripts/canonical_cert/ui_driver.ts --email <e> --port 3973 --control 3199   # headless Chromium, signed in
curl -s 127.0.0.1:3199/act -d '[{"a":"goto","url":"/expenses"},{"a":"shot","name":"exp-01"}]'
```

- `scale_journey.ts` drives upload -> detect -> process -> categorise -> category review -> decisions ->
  approve-all through the real routes, counts rows at every layer (service role reads only) and times every
  request against the 28 s Amplify limit. `--repeat byte|reexport` uploads the same statement again.
- `ui_driver.ts` holds one browser session for a fixture user (cookies from the harness session file, added
  for the 127.0.0.1 origin only) and takes screenshots on request.

## 7. Migration presence on DEV (read-only)

```bash
node scripts/canonical_cert/dev_migration_presence_probe.mjs [--json]
```

The expectations are parsed from the migration files themselves: added columns, created tables, and RPCs
that are new in that migration. The probe checks them against DEV's OpenAPI. It includes a sentinel column
that must be reported missing, which proves the probe can fail. For 0200 it also runs a behavioural check,
and 0201, which adds indexes only, is reported as not determinable.

## Owner-before-upload (2026-10-02)

Every financial-document upload route now REQUIRES the owner chosen before the file is sent (query `owner=<json>`
for the bank / liability / retirement / AU-investment routes, `owner` in the upload-session body, `meta.owner`
for Investment Intelligence). `lib/session.mjs` `api()` therefore adds a VALID synthetic owner for the fixture
user it is signed in as: Self by default, or the role a script asks for (`owner: 'spouse' | 'joint' | 'smsf'`, or
the retired loose `owner_role=<role>` query value, which is translated). Pass `owner: null` to send NO owner --
that is how the owner-required negative controls are written (`final/owner_required_negative_controls.mjs`).
The shared helper is `scripts/lib/syntheticOwner.mjs`; it only uses the app's own authenticated routes. A
UI-driven journey must choose the owner in the selector shown above the file input, exactly as a user does.
