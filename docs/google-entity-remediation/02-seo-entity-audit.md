# 02 — SEO Signal Audit (Phase 2) — BEFORE state

Audited: `app/layout.tsx`, `app/(marketing)/page.tsx`, `app/(marketing)/contact/page.tsx`,
`app/(marketing)/privacy/page.tsx`, `app/(marketing)/terms/page.tsx`, `app/(marketing)/resources/**`,
`lib/resources/public/metadata.ts`, `app/sitemap.ts`, live-served HTML/robots.txt/sitemap.xml from
`app.financialhealthplatform.com`.

## Root layout (`app/layout.tsx`)

- `title`: plain string `'Financial Health Intelligence Platform'` — **does not contain the FHIP
  brand token at all** as the literal fallback title. Violates Phase 3/4 (must not present the
  expanded name without the brand).
- `description`: generic, no FHIP brand.
- No `metadataBase` — any relative OG/Twitter image URL anywhere in the app would resolve
  incorrectly (Next.js warns on this in dev). No page currently sets an OG image, so this hasn't
  surfaced as a visible bug yet, but it blocks setting one correctly and blocks automatic
  `openGraph.url` resolution.
- No `alternates.canonical`, no `openGraph` block, no `twitter` block at the root — nothing
  cascades down to pages (contact/privacy/terms) that don't set their own.
- No JSON-LD anywhere in the tree — confirmed live: `curl https://app.financialhealthplatform.com/`
  contains zero `application/ld+json` script tags.
- Icons are correctly configured (32/512 PNG + apple-touch-icon), matching real files under
  `public/images/`.

## Homepage (`app/(marketing)/page.tsx`)

- `title: 'FHIP | Financial Health'` — correct, brand-first, matches Phase 16's preferred
  presentation exactly. **No change needed here.**
- `description`, `openGraph.title/description/siteName`, `twitter.card/title/description` are all
  already set and already brand-consistent (live-verified in the served HTML). **No change
  needed.**
- Missing: `alternates.canonical` (no canonical tag present in the served HTML — live-verified),
  `openGraph.url`, `openGraph.type`.
- Missing: JSON-LD (Organization/WebSite/WebApplication) — this is the single largest gap
  relative to Phase 5-8's requirements.

## Contact / Privacy / Terms pages

- Each sets only a bare `title` string (`'Contact — FHIP'`, `'Privacy Policy — FHIP'`, `'Terms of
  Service — FHIP'`) — brand-consistent, fine as-is.
- None set `alternates.canonical`, `openGraph`, or `twitter` — currently these inherit nothing
  from the root (root has none either), so these pages have **no canonical tag and no explicit
  site-name signal** at all today (live-verified: no `<link rel="canonical">` on any of these
  routes).
- Privacy and Terms pages' "Contact" sections link `mailto:amarnath.bekal@gmail.com` — the
  operator's personal email, not one of the project's own identity addresses. Not a security
  issue, but inconsistent with brand-first identity signalling for public-facing legal pages.

## Resources public pages (`lib/resources/public/metadata.ts`, R1.5 delivery)

- Already the most mature part of the codebase's SEO surface: per-post `canonical`
  (`alternates.canonical`), `openGraph.url`, `robots: {index:false}` for non-indexable posts,
  Article/VideoObject/BreadcrumbList/FAQPage JSON-LD builders that only emit when required fields
  are genuinely present (no fabrication) — this is a good existing pattern this task's new code
  reuses rather than reinvents (`getPublicSiteBaseUrl()` is imported directly rather than
  duplicated).
- Title suffix is `"{title} | FHIP Financial Knowledge & Insights"` — brand-first, consistent.
- Gap: none of these pages emit an `Organization`/`WebSite`-level entity — only content-level
  Article/Video schema. They benefit from, but don't duplicate, the site-wide entity graph added
  by this task at the root layout.

## `app/sitemap.ts`

- Live-verified (`curl https://app.financialhealthplatform.com/sitemap.xml`): contains **only**
  the four Resources index pages (`/resources`, `/resources/videos`, `/resources/glossary`,
  `/resources/money-updates`) plus dynamically-published Resource posts. It does **not** include
  the homepage, `/contact`, `/privacy`, or `/terms` — all genuinely public, indexable pages that
  Phase 20 requires be present. This is a real gap, not a design choice (no code comment explains
  omitting them; the static entries array was simply never extended past the original R1.5 scope).

## `robots.txt`

- Live-verified: `https://app.financialhealthplatform.com/robots.txt` returns Next.js's default
  **404 page**, meaning `app/robots.ts` does not exist. There is no robots configuration anywhere
  in the repository (confirmed via `find`). Every crawler currently receives no robots directives
  at all — not unsafe (nothing private is being crawled that shouldn't be, since private routes
  are behind Supabase auth and return redirects/empty shells to unauthenticated crawlers), but it
  means there's no explicit `Sitemap:` declaration either, and no defence-in-depth against a
  crawler wasting budget on `/api/*` or attempting to index an authenticated shell page.

## Structured data / schema.org

- Zero `application/ld+json` anywhere outside the Resources content-level builders described
  above. No `Organization`, no `WebSite`, no `WebApplication`/`SoftwareApplication`, no `sameAs`,
  no `isPartOf`, no `publisher` relationship exists pre-implementation. This is the direct,
  central gap this task's Phase 5-8 implementation addresses.

## Open Graph / Twitter / social identity

- Homepage: complete and correct (see above).
- Every other public page: no `openGraph`/`twitter` block at all pre-implementation (confirmed:
  contact/privacy/terms/about/security).

## Logo / icon identity

- Favicon/apple-touch-icon correctly wired at the root layout to real files
  (`public/images/fhip-icon-32.png`, `-512.png`, `-180.png`). `public/images/fhip-logo-mark.png`
  and `fhip-logo-full.png`/`fhip-logo-lockup.png` exist and are already used in the landing page
  header (`fhip-logo-lockup.png`) — real assets, not fabricated, available for `logo` fields in
  the Organization JSON-LD added by this task.

## Legacy / inconsistent brand references (Phase 25 sweep)

Searched for: `Financial Health Platform` (as a page-facing string, not the technical domain
name), `FinancialHealthPlatform`, `My FHIP` / `MyFHIP` / `myFHIP`, `FHIP App`, `Financial Health
Intelligence` (partial). Result: **no stray/inconsistent public-facing brand string was found** —
the one place the generic phrase appears is the root layout's default title
(`'Financial Health Intelligence Platform'`), which is the *correct* expanded name but is missing
the brand token as required by Phase 3/4, addressed above. No other page uses "Financial Health
Platform" (without "Intelligence") anywhere as page-facing copy.

## Known dead/placeholder link (Phase 26 — external/internal link audit)

`components/marketing/LandingPage.tsx` footer, "Company" column: `<a href="#">About</a>` — a
dead placeholder anchor (`href="#"`), not a real destination. This is fixed by this task once the
About page exists (Phase 12).
