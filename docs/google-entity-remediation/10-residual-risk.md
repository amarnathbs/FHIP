# 10 — Residual Risk Assessment (Phase 36) + DNS recommendation (Phase 10)

## Root `financialhealthplatform.com` behaviour — recommendation (Phase 10)

Current state (live-verified): the Cloudflare zone for `financialhealthplatform.com` exists and is
correctly delegated, but the zone apex has no A/AAAA record, and `www.financialhealthplatform.com`
does not exist as a name at all. Only `app.financialhealthplatform.com` resolves.

**Recommendation for Product Owner review (infrastructure change, NOT made by this task):** point
the bare `financialhealthplatform.com` root (and ideally `www.financialhealthplatform.com`) at the
same redirect behaviour already proven correct for `myfhip.com` — a 301 to
`https://app.financialhealthplatform.com/`, preserving path and query. This would:

- Give the bare domain string an actual, crawlable HTTP presence (currently it has none at all),
  which is likely to help Google stop treating "financialhealthplatform.com" as a dangling,
  content-free string.
- Match the existing, working pattern (`myfhip.com` already does exactly this) rather than
  introducing a new redirect mechanism.
- Require no application code change — it is a Cloudflare Page Rule / Redirect Rule, the same
  mechanism already used for `myfhip.com`.

This is **not implemented by this task** (DNS/Cloudflare changes are outside this task's authority
per the standing hard rules) — it is documented here for Product Owner decision and, if approved,
implementation by whoever holds Cloudflare access.

## What is under FHIP's control (this task's actual scope)

- All metadata, JSON-LD/structured data, canonical tags, `robots.ts`, `sitemap.ts`, and public page
  content shipped in this branch.
- Internal link hygiene (the About/Security footer links, previously dead placeholders).
- The wording and existence of the two Google AI Overview feedback reports (documentation only).
- The Search Console runbook procedure (documentation only — the checks themselves are the Product
  Owner's to run after deployment).

## What is explicitly OUTSIDE FHIP's control

- **Google recrawl timing** — there is no way to force or predict when Google will next crawl any
  of these pages, even after Search Console "Request Indexing."
- **Google AI Overview generation** — the AI Overview is a separate system from organic search
  ranking/indexing; correct structured data and content do not guarantee the AI Overview changes
  its summary, or changes it quickly.
- **Google entity resolution** — whether Google's Knowledge Graph / entity-resolution systems merge
  `myfhip.com` and `app.financialhealthplatform.com` into one recognized entity is Google's internal
  process; this task provides the evidence, not the outcome.
- **Old third-party social posts** (the Facebook/Threads posts the Product Owner reviewed, which
  cite unrelated `.cyou`/Taiwan-marketplace domains) — these already exist and are outside FHIP's
  ability to edit, remove, or influence.
- **Ranking and AI citation selection** — which sources Google's AI Overview chooses to cite for a
  given query is not something this task can direct.
- **Knowledge-graph formation timelines** — establishing a new, well-corroborated entity in
  Google's knowledge graph typically takes sustained signal over time (see Phase 37/final report's
  external-authority plan), not a single deployment.

## This task does NOT promise that implementation will immediately remove either AI Overview

Per the spec's own explicit instruction (§42): this implementation provides the correct,
non-manipulative technical and content-level evidence. It does not, and cannot, guarantee that
Google's AI Overview stops making either incorrect statement, or on what timeline. The Product
Owner should treat the two AI Overview feedback reports and the Search Console runbook as the next
manual steps after deployment, not as a guaranteed fix.

## Other residual items (not blocking, disclosed rather than fixed in this pass)

- `/resources/(browse)/search` — a search-results-style public page with no explicit
  canonical/robots treatment of its own (it inherits the general `/resources` allow rule). A
  future pass could add a page-level `noindex` if duplicate/thin-content concerns arise; not
  addressed here since it is not part of the core entity-consolidation problem and the spec's
  priority order places it below the core fixes.
- Privacy/Terms pages remain explicitly marked "Draft — pending legal review" (pre-existing,
  unrelated to this task; not touched beyond swapping the contact-email addresses).
- No malware/phishing-lookalike-domain monitoring service is set up — outside this task's scope
  and budget; would be a legitimate future addition (e.g. a brand-monitoring or domain-watch
  service) but is not a code change.
- `myfhip.com`/`financialhealthplatform.com` DNS decisions remain with whoever holds Cloudflare
  access — this task has no such access and made no DNS changes.
