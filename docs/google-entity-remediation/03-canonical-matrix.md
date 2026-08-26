# 03 — Canonical Matrix (Phase 17)

All canonical URLs resolve against `metadataBase` (`app/layout.tsx`), which is set to the real
application host via `getFhipApplicationUrl()` (`APP_BASE_URL` env var — production value
`https://app.financialhealthplatform.com`). No canonical tag anywhere in this task points at
`myfhip.com` — per Phase 9's explicit rule, canonical tags stay on the domain that actually serves
the content; the myfhip.com ↔ application relationship is carried by structured data instead (see
`04-structured-data-design.md`), not by canonical tags.

| Route | Host that serves it | Canonical BEFORE | Canonical AFTER | Indexable? | Reason |
|---|---|---|---|---|---|
| `/` (homepage) | `app.financialhealthplatform.com` | none | `https://app.financialhealthplatform.com/` | Yes | Public marketing homepage; real content lives here. |
| `/about` | `app.financialhealthplatform.com` | n/a (route did not exist) | `https://app.financialhealthplatform.com/about` | Yes | New page, Phase 12. |
| `/security` | `app.financialhealthplatform.com` | n/a (route did not exist) | `https://app.financialhealthplatform.com/security` | Yes | New page, Phase 24. |
| `/contact` | `app.financialhealthplatform.com` | none | `https://app.financialhealthplatform.com/contact` | Yes | Existing public contact form page. |
| `/privacy` | `app.financialhealthplatform.com` | none | `https://app.financialhealthplatform.com/privacy` | Yes | Draft-but-real, intentionally indexable (OAuth-provider validation requirement — see the page's own code comment). |
| `/terms` | `app.financialhealthplatform.com` | none | `https://app.financialhealthplatform.com/terms` | Yes | Same as above. |
| `/resources`, `/resources/[slug]`, `/resources/topic/[slug]`, `/resources/videos`, `/resources/glossary`, `/resources/money-updates` | `app.financialhealthplatform.com` | Already correct — per-post `alternates.canonical` via `lib/resources/public/metadata.ts` | Unchanged (already correct, R1.5 delivery) | Per-post (`is_indexable` flag) | Pre-existing, mature implementation — this task did not need to touch it. |
| `/resources/(browse)/search` | `app.financialhealthplatform.com` | none | none (unchanged) | Not addressed by this task | Search-results-style page; flagged as a residual item in `10-residual-risk.md` (candidate for a page-level `noindex`, not a canonical/robots.txt change — outside this task's Phase 3-22 core scope). |
| `myfhip.com` (any path) | Cloudflare (301 redirect, no app code) | n/a — never serves a page | n/a — never serves a page | N/A — the redirect target's canonical is what search engines see (per 301 semantics, that is correct standard behaviour and requires no code change) | Confirms Google should already be consolidating link/ranking signal from `myfhip.com` to the app domain via the 301 — the entity-identity gap this task fixes is separate from canonical/redirect mechanics, which were already correct. |
| `financialhealthplatform.com` / `www.financialhealthplatform.com` | Does not resolve | n/a | n/a | N/A | No content exists to canonicalize. See `10-residual-risk.md` for the DNS-level recommendation (outside this task's authority). |
| Every `(app)`, `(auth)`, `(onboarding)`, `(print)`, `/api/*` route | `app.financialhealthplatform.com` | none | Intentionally still none | No — blocked by `app/robots.ts` allowlist (Phase 19) | Authenticated/private/API surfaces must never be indexed; no canonical needed for pages that must not be crawled at all. |

## Conflicting-canonical-signal check (Phase 17's explicit requirement)

Verified: no route emits more than one `alternates.canonical` value, no two distinct routes claim
the same canonical URL, and no page canonicalizes to a host other than the one serving it. The
`myfhip.com` → app-domain relationship is intentionally **not** expressed via canonical tags (that
would be canonicalizing across domains, which Phase 9 explicitly forbids doing "merely to
consolidate SEO") — it is expressed via the 301 redirect (already correct, pre-existing
infrastructure) and via structured data (`Organization.url`/`WebSite.url` = `myfhip.com`, see
`04-structured-data-design.md`), which is the semantically correct mechanism for this case.
