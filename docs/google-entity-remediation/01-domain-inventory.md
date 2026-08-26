# 01 — Domain Inventory (Phase 1)

Complete repository search for `myfhip.com`, `www.myfhip.com`, `financialhealthplatform.com`,
`www.financialhealthplatform.com`, `app.financialhealthplatform.com`, and related config, run
against the full working tree (excluding `node_modules`, `.next`).

## In-repository occurrences

| File | Occurrence | Classification |
|---|---|---|
| `app/(marketing)/page.tsx:29` | Code comment only: *"myfhip.com short-brand update: the browser/share title is now the short..."* | Documentation-only reference (explains a past metadata change). No functional wiring. |
| `app/api/contact/route.ts:74` | `CONTACT_FROM_EMAIL` default `'FHIP Contact Form <no-reply@auth.financialhealthplatform.com>'` | Email identity (transactional sender address, Resend-verified domain). Mail infrastructure — out of scope to modify per standing rules. |
| `components/auth/OAuthButtons.tsx:29` | Comment noting `financialhealthplatform.com`/`app.financialhealthplatform.com` were registered as Meta App Domains for a (currently disabled) Facebook OAuth provider | Stale/historical comment about third-party OAuth config, not a live code reference. No change needed. |
| `.env.example`, `ENVIRONMENT_VARIABLES.md`, `DEPLOYMENT.md` | `APP_BASE_URL` documented/exemplified as `https://app.financialhealthplatform.com` | Application URL / environment configuration (the one real, functional domain reference in the codebase). |
| `OPERATIONS_RUNBOOK.md`, `DEPLOYMENT_COMPLETION_REPORT.md`, various `docs/**/*.md`, `scripts/*_production_readonly_schema_check.mjs` | Assorted mentions of `app.financialhealthplatform.com` / `financialhealthplatform.com` in historical delivery reports and read-only production-schema-check scripts | Documentation-only / script-comment references to the known production host. Historical, not touched (Phase 25: "do not change historical documentation unnecessarily"). |

**No occurrence of `myfhip.com` exists anywhere in application code, configuration, redirect
rules, middleware, or environment variable definitions.** The domain is entirely external to this
codebase — it is wired up only at the DNS/Cloudflare layer, outside this repository's control and
outside this task's write access (per standing hard rule #1).

## Live domain behaviour (read-only checks; see `03-canonical-matrix.md` / `18-redirects` in
`09-validation.md` for the full test matrix)

- **`myfhip.com`, `www.myfhip.com`** (HTTP and HTTPS): resolves via Cloudflare, returns `301
  Moved Permanently` → `https://app.financialhealthplatform.com/<original path><original
  query>`. Verified with a path+query test (`/about?utm=test` → same path+query preserved on the
  target). This is a Cloudflare-level redirect (response header `server: cloudflare`, no
  Next.js/Amplify signature) — it happens before any request reaches this application's code.
- **`financialhealthplatform.com`** (bare root, no subdomain): Cloudflare zone exists and is
  correctly delegated (NS records present, matching `abby`/`dante.ns.cloudflare.com`), but **no
  A/AAAA record is configured for the zone apex** — confirmed via both the local resolver and a
  direct query to `8.8.8.8`. The domain does not resolve to any server; there is nothing to serve
  HTTP from.
- **`www.financialhealthplatform.com`**: NXDOMAIN (name does not exist at all).
- **`app.financialhealthplatform.com`**: resolves (CNAME → CloudFront distribution), serves the
  live application over HTTPS, `200 OK` on `/`, `404` on unmapped paths (confirmed for `/about`
  and `/security`, which do not exist yet before this task's implementation), `200` on `/contact`
  and `/privacy`.

## Classification against the Phase 1 checklist

| Domain | Production public URL? | Application URL? | Canonical URL (current)? | Redirect target? | Callback/API URL? | Email identity? |
|---|---|---|---|---|---|---|
| `myfhip.com` | Intended, per PO (§4) | No | No (no canonical tags exist anywhere in the code yet — see `02-seo-entity-audit.md`) | No — it *is* the source of a redirect | No | No |
| `www.myfhip.com` | No (redirects) | No | No | No — redirects (to apex, which then redirects onward) | No | No |
| `financialhealthplatform.com` | No (does not resolve) | No | No | No | No | No |
| `www.financialhealthplatform.com` | No (does not resolve) | No | No | No | No | No |
| `app.financialhealthplatform.com` | Yes (de facto — this is where all real traffic lands) | **Yes — this is the application** | No explicit canonical tags exist pre-implementation | Redirect **target** (from `myfhip.com`) | Yes (all `/api/*` routes, Supabase Auth callback `/auth/callback`) | Sending subdomain `auth.financialhealthplatform.com` used for transactional email |

## Conclusion carried into Phase 3+ (see `02-seo-entity-audit.md` and the final report)

- `app.financialhealthplatform.com` is unambiguously the application: every route, every API, all
  real content, lives here. This does not change under this task.
- `myfhip.com` is a bare Cloudflare redirect with **zero independent content**. It correctly
  forwards visitors and preserves path/query, which is good redirect hygiene, but it gives Google
  no first-party page to crawl and understand on its own — everything Google could ever index
  "as myfhip.com" is actually indexed as `app.financialhealthplatform.com` content after the
  redirect. This absence of independent, crawlable, brand-identifying content at the domain Google
  is confusing with a phishing site is assessed as a material contributing factor to Problem A
  (see the final report's root-cause section) — not a defect this task can fix by itself (DNS/
  hosting changes are out of scope), but the entity-consolidation work below (canonical WebSite/
  Organization schema declaring `myfhip.com` as the brand's stated `url`, plus the About/Security
  disambiguation content actually served at `app.financialhealthplatform.com` after the redirect)
  is the correct code-side lever available.
- `financialhealthplatform.com` (bare root) having **no DNS record at all** is assessed as a
  material contributing factor to Problem B: Google has no independently-crawlable site at that
  exact string, so when a user's query matches the domain-like phrase "financial health platform"
  it falls back to generic category interpretation rather than resolving to a specific entity.
  The subdomain that *does* exist and serve real content — `app.financialhealthplatform.com` — is
  correctly identified by Google's organic result (title "FHIP | Financial Health") but the AI
  Overview is evidently not consistently connecting the bare-domain string in the query to that
  subdomain's entity. Structured data explicitly declaring the FHIP entity's relationship to both
  strings (this task's Phase 5-8 implementation) is the correct code-side lever; DNS-level
  decisions about whether to point the bare root somewhere are flagged for Product Owner review in
  `10-residual-risk.md` and are explicitly out of this task's authority.
