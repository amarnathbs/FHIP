# 06 — Google Search Console Runbook (Phase 31)

**No Search Console changes are made by this task.** This is a procedure for the Product Owner to
run manually, after this branch is reviewed, merged, and deployed to production by the Product
Owner (not by this task — see the final report's Production Status section).

## 1. Properties that should ideally exist

- **Domain property: `myfhip.com`** — covers `myfhip.com` and `www.myfhip.com` together (a Domain
  property in Search Console covers all subdomains and protocols at once via DNS verification).
  Recommended primary property for the brand domain, even though it only ever serves a redirect —
  Search Console's Domain property type is exactly designed to also surface how Google is treating
  known redirects/aliases of a verified domain.
- **Domain property: `financialhealthplatform.com`** — covers the bare root and any future `www`/
  subdomain. Useful even while the bare root has no DNS record, so the Product Owner can see
  whether Google has indexed anything unexpected under that domain and monitor for any Manual
  Action or Security Issue flagged against it.
- **URL-prefix property: `https://app.financialhealthplatform.com`** — the property that will show
  the actual Page Indexing, Coverage, and Core Web Vitals data for the live application, since a
  Domain property for `financialhealthplatform.com` does cover its subdomains but a dedicated
  URL-prefix property gives more granular reporting for this specific, high-traffic host.

(A Domain property requires DNS TXT-record verification, which is a DNS/Cloudflare change — out of
this task's authority; the Product Owner or whoever holds Cloudflare access must do this step.)

## 2. After production deployment, check for BOTH domain families

For `myfhip.com`:
- **URL Inspection** on `https://myfhip.com/` — confirm Google sees the 301 to
  `https://app.financialhealthplatform.com/` and is treating it as the canonical redirect target
  (not attempting to index the redirect itself as separate content).
- **Security Issues** — confirm no existing flag (unrelated to, but worth ruling out alongside,
  the AI Overview phishing mischaracterisation).
- **Manual Actions** — confirm none exist.
- **HTTPS** — confirm the certificate is valid and not showing a browser warning.

For `financialhealthplatform.com`:
- **URL Inspection** on `https://financialhealthplatform.com/` and
  `https://www.financialhealthplatform.com/` — expect "URL is not on Google" / not indexed, since
  neither currently resolves. Re-run this after any future DNS decision (see `10-residual-risk.md`)
  changes that.
- **Security Issues** / **Manual Actions** — confirm none.

For `app.financialhealthplatform.com`:
- **Page Indexing** report — confirm the new `/about` and `/security` pages get crawled and
  indexed within a normal timeframe (days, not guaranteed — see `36-residual-risk` in the final
  report). Confirm no authenticated route appears as indexed (would indicate the new
  `app/robots.ts` allowlist needs revisiting).
- **URL Inspection** on `/`, `/about`, `/security` specifically — request indexing for these three
  after deployment, since they carry the actual disambiguation content for both AI Overview
  problems.
- **Sitemaps** — submit/re-submit `https://app.financialhealthplatform.com/sitemap.xml` (Search
  Console → Sitemaps) and confirm it's read without errors and the marketing pages
  (`/`, `/about`, `/security`, `/contact`, `/privacy`, `/terms`) are picked up alongside the
  existing Resources entries.
- **HTTPS** — confirm valid.
- **Homepage/About/Security recrawl** — use "Request Indexing" from URL Inspection for these three
  URLs specifically, since they are the pages carrying the new disambiguation content that both AI
  Overview reports (`07-google-ai-report-myfhip.md`, `08-google-ai-report-financialhealthplatform.md`)
  will reference.

## 3. Do not assume success

Recrawling, re-indexing, and any change to how Google's AI Overview summarises a query are **not**
guaranteed by any of the above, and are not guaranteed to happen quickly. Treat the checks above as
verification steps, not a guarantee that either AI Overview problem will resolve on any particular
timeline. See the final report's Residual Risk section for what is and isn't within FHIP's control.
