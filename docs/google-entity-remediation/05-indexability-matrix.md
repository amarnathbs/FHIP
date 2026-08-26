# 05 — Indexability Matrix (Phase 27)

Live-verified (`curl`) against `https://app.financialhealthplatform.com` where the route exists at
time of audit; DNS behaviour for the other two domains verified against `01-domain-inventory.md`.
"Title/Canonical/Schema/Identity clear" columns reflect the state **after** this task's
implementation (see `11-before-after.md` for the explicit before/after diff).

| URL | HTTP | Title | Canonical | Robots | Schema | Indexable | Identity clear? |
|---|---|---|---|---|---|---|---|
| `https://myfhip.com/` | 301 → app domain (live-verified) | n/a (redirect, no content) | n/a | n/a | n/a | N/A (redirect) | Its *target* now carries the full FHIP entity graph declaring `myfhip.com` as the Organization/WebSite `url` — see below. |
| `https://financialhealthplatform.com/` | Does not resolve (no A/AAAA record — live-verified) | n/a | n/a | n/a | n/a | No — nothing to index | No — no content exists at this exact host to be identity-clear about. Flagged in `10-residual-risk.md`. |
| `https://app.financialhealthplatform.com/` (homepage) | 200 | `FHIP \| Financial Health` | `https://app.financialhealthplatform.com/` (new) | Allowed (`/$` in robots allowlist) | Organization+WebSite+WebApplication graph (new, site-wide) | Yes | Yes — brand name, expanded name (nav tagline + hero copy), and product presentation title all present. |
| `https://app.financialhealthplatform.com/about` | 200 (new route) | `About FHIP — Financial Health Intelligence Platform` | `.../about` (new) | Allowed | Inherits site-wide graph | Yes | Yes — explicit About narrative naming both official domains. |
| `https://app.financialhealthplatform.com/security` | 200 (new route) | `Security & Trust — FHIP` | `.../security` (new) | Allowed | Inherits site-wide graph | Yes | Yes — official domain list + phishing disambiguation. |
| `https://app.financialhealthplatform.com/contact` | 200 | `Contact — FHIP` | `.../contact` (new) | Allowed | Inherits site-wide graph | Yes | Yes (brand in title; inherits site-wide og:site_name). |
| `https://app.financialhealthplatform.com/privacy` | 200 | `Privacy Policy — FHIP` | `.../privacy` (new) | Allowed | Inherits site-wide graph | Yes | Yes. |
| `https://app.financialhealthplatform.com/terms` | 200 | `Terms of Service — FHIP` | `.../terms` (new) | Allowed | Inherits site-wide graph | Yes | Yes. |
| `https://app.financialhealthplatform.com/resources` (+ children) | 200 | Per-post, brand-suffixed (pre-existing) | Per-post (pre-existing) | Allowed | Per-post Article/Video/FAQ/Breadcrumb schema (pre-existing) + site-wide graph (new) | Per `is_indexable` flag (pre-existing) | Yes (pre-existing, unchanged). |
| Every authenticated `(app)`/`(auth)`/`(onboarding)`/`(print)` route, all `/api/*` | 200 when authenticated / redirects or empty shell otherwise | N/A (not meant to be indexed) | None (intentional) | **Disallowed** (new `app/robots.ts`, allowlist-by-default) | Inherits site-wide graph via root layout, but not intended to be crawled at all | No (by design) | N/A — private application surface. |

## Notes

- "Identity clear?" for `myfhip.com` itself is inherently limited by the fact that it never serves
  a page — this task cannot make a redirect target "identity-clear" beyond what the 301 already
  achieves (preserving path/query into the real, now identity-clear, destination). This is
  correctly the boundary of what code-side work can achieve; the rest is Google's own
  redirect-consolidation behaviour (outside FHIP's control — see `10-residual-risk.md`).
- `/resources/(browse)/search` was audited but intentionally left unchanged (see
  `03-canonical-matrix.md`); flagged, not fixed, in this pass.
