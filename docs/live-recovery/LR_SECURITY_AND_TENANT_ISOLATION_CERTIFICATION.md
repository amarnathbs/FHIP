# LR Security and Tenant Isolation Certification

## 2026-09-21 ADDENDUM — fresh live re-confirmation, not merely carried forward

Everything below this line is the 2026-09-14 baseline, preserved as-is. This pass independently **re-ran the same class of test fresh, today, against the real DEV database**, using two newly-created disposable authenticated users each time (not the same rows, not the same users, not a re-read of the old report) — `scripts/audit-lr/z01_dev_rls_cross_tenant_live.mjs` and `z02_dev_rls_cross_tenant_more_tables.mjs`, written this pass using native `fetch` only (this worktree's `node_modules` could not be reliably installed for most of this session, so the TypeScript oracle scripts that depend on `@supabase/supabase-js` and the application's own engines could not be run — see the Section 7 note in the master addendum. RLS itself is enforced entirely at the Postgres/PostgREST layer, so it does not require the application's JS to be running, which is why this specific class of test remained possible).

| Table | READ as user B | UPDATE as user B | DELETE as user B | Positive control (A reads own row) | Result |
|---|---|---|---|---|---|
| `liabilities` | 0 rows (200) | 0 rows affected (200) | 0 rows affected (200) | 1 row (200) | **PASS — isolated, live-reconfirmed 2026-09-21** |
| `business_entities` | 0 rows (200) | — | 0 rows affected (200) | 1 row (200) | **PASS — isolated, live-reconfirmed 2026-09-21** |
| `ii_source_documents` | 0 rows (200) | — | 0 rows affected (200) | 1 row (200) | **PASS — isolated, live-reconfirmed 2026-09-21.** This is the table behind the P1-3 finding (no upload gate, no malware scan) — confirming RLS still holds here matters specifically because it means that finding is a *content-safety* gap (unscanned bytes reach the parser), not also a *cross-tenant data* gap. Both would have compounded badly together; they do not. |

All test users were created via the Auth Admin API and deleted at the end of each run regardless of outcome (`cleanup: deleted N synthetic DEV users`, confirmed in script output both times). No production credentials were used or available in this pass (`.env.local` in this worktree is DEV-only by construction — verified before use by confirming the production project ref is absent from the file).

Not re-run this pass (carried forward from 09-14 as Tier 4 evidence only): every other table in the matrix below, and the unauthenticated production probes (`a01`, `a03`, `a04`, `a08`, `a11`, `a14`, `a15` were not re-executed — several are explicitly production-only probes and this pass was deliberately issued DEV-only credentials).

---

**Date:** 2026-09-14 · **Baseline:** `origin/main` @ `ff35f54`
**Method:** two real authenticated users with real JWTs (anon-denied is explicitly *not* accepted as equivalent), plus live unauthenticated probes against the production application, plus service-role introspection of both databases. Script: `scripts/audit-lr/oracle6_security_deletion_residue.ts`, `a01`, `a03`, `a04`, `a08`, `a11`, `a14`, `a15`.

---

## 1. Authenticated cross-tenant isolation — PASS with a positive control

User A and user B, both real, both country-confirmed, distinct JWTs. B attempts to reach A's rows.

| Table (LR-created or LR-touched) | B reads | B updates | B deletes | Verdict |
|---|---|---|---|---|
| `business_entities` | 0 rows | 0 rows affected | 0 rows affected | **ISOLATED** |
| `business_entity_assets` | 0 rows | — | — | **ISOLATED** |
| `business_entity_liabilities` | 0 rows | — | — | **ISOLATED** |
| `account_deletion_requests` | 0 rows | — | — | **ISOLATED** |
| `smsf_funds` | 0 rows | — | — | **ISOLATED** |
| `user_entitlements` | 0 rows | — | — | **ISOLATED** |
| **Positive control — A reads A's own `business_entities` row** | **1 row** | — | — | **CONTROL OK** |

The positive control is the part that makes the zeros meaningful: it proves the policies admit the owner, so the zeros above are isolation rather than a policy that blocks everyone.

`payment_webhook_events` has RLS enabled with **zero policies** (`0133:58-62`), which is default-deny for every non-owner role — correct for a table only service-role webhook handlers should touch.

**This closes the LR-11 gap that was disclosed but never done** ("authenticated two-user cross-tenant round trip against hosted DEV — only anon-write-blocked was live-proven"). It is now genuinely proven, and it passes.

---

## 2. Storage security

| Control | Result |
|---|---|
| Every bucket private | **PASS** — `public: false` on all four DEV buckets and the one production bucket |
| Object keys user-prefixed | **PASS** — `${userId}/…` in all three writers |
| Storage RLS scopes objects to the owner | **PASS** — `0022:14-15` uses `(storage.foldername(name))[1] = auth.uid()::text` |
| Signed URLs short-lived | **PASS** — 60 s |
| Signed URL issued only after ownership verification | **PASS** — `app/api/report-exports/[exportId]/download/route.ts:17` reads through the RLS client with `.eq('requested_by_user_id', user.id)` **before** the service-role `createSignedUrl` at `:28` |
| The signed-URL redirect leaks the user's auth UUID in the path | **Minor finding** — `Location` carries `${user.id}/${reportId}/${exportId}.pdf`; opaque and 60-second-lived, but it lands in browser history and logs |

---

## 3. Report and export ownership (IDOR sweep)

Every report and export route was checked for a user predicate before any read or write.

| Route | Scoping | Verdict |
|---|---|---|
| `reports` GET / `reports/[id]` GET+DELETE / `sections` / `sources` / `methodology` / `publish` / `retry` / `revise` | `.eq('user_id', userId)` on the RLS client in every case; `retry` reads through RLS **before** the admin-client update | **OK** |
| `reports/[id]/exports` GET + POST | `.eq('requested_by_user_id', user.id)`; POST re-verifies report ownership before any write | **OK** |
| `report-exports/[exportId]` GET+DELETE and `/download` | `.eq('requested_by_user_id', user.id)` before the signed URL | **OK** |
| `professional-access/proxy/report` | `checkAccessLive(clientUserId, user.id, 'VIEW_REPORTS')` then `.eq('user_id', clientUserId)`; the relationship id is re-derived server-side, never trusted from the client | **OK** |
| `(print)/reports/[id]/print` | session wins over token, so an authenticated attacker cannot use a leaked token to read another user's report | **OK** |
| `(print)/forecast/report/print` | `userId` comes from the token row, never the query string; an attacker-supplied `scenario` id falls back to the token owner's base scenario | **OK** |

**No IDOR was found in any report or export route.**

---

## 4. The render token

`lib/services/reportsData.ts:407-423` verifies `(report_id, render_token)` together and rejects a NULL or past `render_token_expires_at` (fail-closed). The token is 256 bits of CSPRNG (`reportPdfRenderer.ts:20-25`), TTL 5 minutes, and is cleared in a `finally` block after the render.

| Property | Status |
|---|---|
| Unguessable | **PASS** — 256-bit CSPRNG |
| Bound to the specific report | **PASS** — both predicates in one query |
| Expiry enforced, NULL rejected | **PASS** |
| **Single use** | **FAIL (P2-12)** — `getReportByRenderToken` is a plain SELECT with no consume-on-read; within the live window the token is replayable, including concurrently. `reportPdfRenderer.ts:15-17` claims "single-use" |
| Transport | **Weak (P2-12)** — carried in a query string, so it reaches Next/Amplify/CloudFront access logs, any reverse-proxy log, and `Referer` headers on outbound subresources |
| Index on `render_token` | **Absent** — no index at all (`0022:17-19`) |

Realistic risk is bounded (the window is the render duration, and a session takes precedence over the token), but the "single-use" claim should be corrected or made true.

---

## 5. Upload gate and malware boundary

Covered in full in `LR_PRODUCTION_UPLOAD_READINESS.md`. Summary:

- `isFdhDocumentUploadEnabled()` is a genuine fail-closed allowlist with no env override. **PASS.**
- All ten FDH upload surfaces check it before touching bytes. **PASS.**
- **`app/api/investment-intelligence/source-documents/route.ts` checks nothing.** It is live in production, accepts up to 20 MB of arbitrary bytes under a service-role write, and its companion process route downloads those bytes back into `pdf-parse`/pdf.js with a 300-second budget. **FAIL — P1-3.**
- **No malware scanner exists anywhere in the codebase.** The `'malware_detected'` error code is declared and never assigned. **FAIL — prerequisite incomplete.**
- The II validator checks only client-supplied extension and MIME plus size — **weaker than FDH's**, which at least does magic-byte detection.

---

## 6. Payment webhook security

Verified live against production, unauthenticated and non-mutating:

```
POST /api/payments/stripe/webhook    -> 503 "Stripe not configured"
POST /api/payments/razorpay/webhook  -> 503 "Razorpay not configured"
```

| Control | Status |
|---|---|
| Signature verified over the **raw** body before any state change | **PASS** (source) — `req.text()`, then `stripe.webhooks.constructEvent` / `Razorpay.validateWebhookSignature`, both before `claimWebhookEvent` |
| Missing signature rejected | **PASS** — 400 |
| Unset secret fails **closed**, never "skip verification" | **PASS** — 503, proven live |
| Secret from env only, no literal fallback | **PASS** |
| Premium granted only by a verified webhook | **PASS** — `entitlementSync.ts:54-72` is the only writer of `plan_tier`; the two checkout-time writes touch only provider ids |
| Idempotency DB-enforced | **PASS** — composite PK `(provider, provider_event_id)` |
| **Failed events retryable** | **FAIL (P2-7)** — the claim is a plain INSERT returning `ALREADY_PROCESSED` on any `23505`, so a `'failed'` event is permanently dropped on retry. The route comment asserts the opposite |
| **Razorpay fallback event key collision-safe** | **FAIL (P2-7)** — `${event}:${sub.id}:${sub.status}` is identical for every `subscription.charged` with status `active`, so renewals are silently swallowed |
| **Configured at all in production** | **FAIL (P1-2)** — `amplify.yml:46` never forwards `STRIPE_*`/`RAZORPAY_*` |

**Secrets hygiene: PASS.** A repo-wide search for `sk_live_`, `sk_test_`, `rzp_live_`, `rzp_test_`, `whsec_`, `price_`, `plan_` across source, tests, scripts, migrations and docs found only prefix-classification logic, obvious test placeholders, and prose. **Zero real-looking secrets**, including in `supabase/migrations/` and `scripts/`.

**One standing exposure, disclosed by the code itself and not fixed:** migration `0135`'s header (`:44-49`) records that the real cron secret has been in git history since migration `0010`'s plaintext-literal pattern. `0135` itself correctly resolves the secret from `vault.decrypted_secrets`. The historical exposure remains.

---

## 7. Cron secret

Verified live against production:
```
POST /api/financial-data-hub/documents/cron/purge-sweep  (no secret)   -> 401
POST /api/financial-data-hub/documents/cron/purge-sweep  (real secret) -> 200 + correct sweep JSON
```
**PASS** — the endpoint authorises correctly and fails closed without the header.

---

## 8. Account deletion security

| Control | Status |
|---|---|
| User can only request, never execute | **PASS** |
| User can cancel only while `pending` | **PASS** — enforced by RLS, not only by the route (`0132:100-102`) |
| Admin capability required to view or execute | **PASS** — `requireAccountDeletionAdmin()` checks `admin_users.can_manage_account_deletions`, then country confirmation |
| **Admin cannot execute their own request** | **PASS** — explicit check before `executeAccountDeletion` is called, with the live 2026-09-11 production reproduction recorded in the code |
| Storage purge attempted before identity deletion | **PASS** |
| Any purge failure aborts the whole deletion | **PASS in code** — but **vacuous for two of three buckets in production** (P1-9): a missing bucket returns `200 []`, never an error |
| Identity deleted only after verified purge | **PASS in code**, same caveat |
| DB cascade removes owned rows | **PASS** — live-proven |
| Tombstone survives by request UUID with `user_id` NULL | **PASS** — live-proven |
| Former user cannot authenticate | Proven by LR-9's own e2e; not re-run here |
| **No financial rows remain** | **FAIL (P2-1)** — `ii_analytics_results` survives with a dangling `user_id`; live-proven against a cascading control row |
| **Deletion always completes** | **FAIL (P1-8)** — live-proven that a bare `NO ACTION` FK blocks `deleteUser()` outright; 15 such columns exist |
| Admin-side RLS symmetry | **Minor** — the admin UPDATE policy (`0132:113-114`) has a `USING` clause and **no `WITH CHECK`**, so a deletion admin could write arbitrary column values to any request row |
| Failed requests retryable | **FAIL (P2-16)** — the execute route claims only `pending`; nothing returns `failed` → `pending` |
| Purge pagination | **FAIL (P2-17)** — `{ limit: 1000 }` with no cursor; >1000 objects silently leaves residue and still reports `error: null` |

---

## 9. Country / jurisdiction gating

| Control | Status |
|---|---|
| `proxy.ts` app-route regex names every directory under `app/(app)/` | **PASS** — enforced by `tests/unit/countryGateAccessMatrix.test.ts` (MC-17) |
| Unauthenticated app routes redirect to `/login` | **PASS** — live-proven in production |
| GENERIC-experience containment via allowlist | **PASS** (fail-closed direction) |
| API layer refuses generic users independently | **PASS** |
| Database backstop on financial tables | **PASS**, except `business_entities`/`_assets`/`_liabilities`, created after the backstop migrations and never retrofitted (**P2-14**) |
| SMSF is AU-only | **PASS** — app gate plus DB trigger |
| AU pricing only AU, India pricing only India, Global never falls back | **PASS** — `plansForBillingCountry()` filters on exact region; `NO_PLAN_FOR_REGION` 422; no fabricated Global price exists anywhere |
| Billing country cannot change under an active subscription | **FAIL (P2-8)** — the route check is real, but `confirm_billing_country` is granted directly to `authenticated` (`0122:622`) with no subscription check, so it is bypassable via PostgREST |

A live DEV journey as an AU user confirmed the pricing surface behaves correctly: `/api/payments/status` returned `availablePlans` containing only `premium_monthly_au`/`premium_annual_au` in AUD, and `/api/payments/checkout` returned `503 NOT_CONFIGURED` rather than any fallback.

---

## 10. Cache control on personal documents

Repo-wide, exactly **three** routes set `Cache-Control`: the two PDF download routes and the SMSF CSV export. Every report-content JSON route (`reports/[id]`, `sections`, `sources`, `methodology`, `exports` GET, `report-exports/[id]`, and the professional-access proxy that returns *another person's* full financial report) sets none, and neither print view declares `dynamic = 'force-dynamic'`.

These are all dynamic routes (each calls `cookies()`), so Next.js emits a private default in practice — but the app sits behind CloudFront, no test pins the behaviour, and `lib/api.ts`'s `ok()` is a single choke point where `private, no-store` would fix roughly 200 routes at once. **Personal financial documents relying on a framework default is not the same as failing closed.** Recorded as P2-11.

---

## 11. Verdict

| Area | Verdict |
|---|---|
| Authenticated cross-tenant isolation | **PASS** (with positive control) |
| Storage isolation and signed-URL handling | **PASS** |
| Report/export ownership (IDOR) | **PASS** |
| Render token | **PARTIAL** — not single-use, query-string transport |
| Upload gate | **FAIL** — one ungated production surface |
| Malware boundary | **FAIL** — none exists |
| Payment webhook verification | **PASS in code**; **non-functional in production** |
| Payment idempotency | **PARTIAL** — two real defects |
| Cron secret | **PASS** |
| Account deletion | **PARTIAL** — two hard failures (blocking FK, residue) plus a vacuous purge in production |
| Country / jurisdiction gating | **PASS** with two gaps |
| Cache control | **PARTIAL** |
| Secrets hygiene | **PASS** |

**Overall: tenant isolation — the control most likely to cause customer harm — is genuinely strong and now genuinely proven. The security failures are concentrated in the document-ingestion boundary and in account deletion's completeness.**
