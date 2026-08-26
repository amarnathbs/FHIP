# 11 — Before / After Certification (Phase 35)

| Signal | Before | After | Evidence |
|---|---|---|---|
| FHIP brand identity in default/root metadata | Root layout title was the bare expanded name `'Financial Health Intelligence Platform'` — no "FHIP" token at all | `FHIP_PRODUCT_PRESENTATION` (`'FHIP \| Financial Health'`) | `app/layout.tsx`; `tests/unit/seoEntity.test.ts` ("product presentation always starts with brand name") |
| Expanded product identity | Present on homepage only (title/OG), absent from root default and from every other public page | Present at root default, plus explicit About-page narrative: *"Financial Health Intelligence Platform" is the expanded name of the specific branded product FHIP* | `app/layout.tsx`, `app/(marketing)/about/page.tsx` |
| myfhip.com relationship to the product | Zero code representation anywhere except one historical comment | `Organization.url` / `WebSite.url` = `https://myfhip.com`, plus About/Security page prose naming it as an official domain | `lib/seo/entity.ts`, `04-structured-data-design.md`, `app/(marketing)/about/page.tsx`, `app/(marketing)/security/page.tsx` |
| financialhealthplatform.com relationship to the product | No structured statement anywhere; bare root domain has no DNS record at all | `WebApplication.url` = `app.financialhealthplatform.com`, tied via `publisher`/`isPartOf` to the same Organization/WebSite as `myfhip.com`; About page explicitly disambiguates the expanded-name-as-generic-phrase problem | `lib/seo/entity.ts`; `01-domain-inventory.md` (DNS finding, unchanged — flagged, not a code fix) |
| app domain relationship | Implicit only (it's just "the site") | Explicit `WebApplication` node, `publisher`/`isPartOf` to `WebSite`/`Organization` | `lib/seo/entity.ts` |
| WebSite schema | None existed | New `WebSite` node, stable `@id`, `alternateName` covering both the expanded name and the short presentation | `lib/seo/entity.ts` |
| Organization schema | None existed | New `Organization` node, stable `@id`, `url`, `alternateName`, real `logo` asset, narrow `sameAs` | `lib/seo/entity.ts` |
| Application schema | None existed | New `WebApplication` node, `applicationCategory: 'FinanceApplication'`, no regulated-institution claim | `lib/seo/entity.ts` |
| Site name (og:site_name, HTML title, nav/footer) | Homepage already correct; every other page had no og:site_name at all (nothing to inherit — root had none) | Root layout now sets a default `openGraph.siteName` ('FHIP') inherited by every page that doesn't override it; footer/nav already said "FHIP" (pre-existing, unchanged) | `app/layout.tsx`; live-verified pre-implementation absence in `02-seo-entity-audit.md` |
| Canonicals | Zero canonical tags existed anywhere pre-implementation (live-verified) | Explicit `alternates.canonical` on `/`, `/about`, `/security`, `/contact`, `/privacy`, `/terms`; Resources canonicals unchanged (already correct) | `03-canonical-matrix.md` |
| Sitemap | Only 4 Resources index URLs; homepage/legal/about/security absent | 6 marketing URLs added (`''`, `/about`, `/security`, `/contact`, `/privacy`, `/terms`) alongside the unchanged Resources entries | `app/sitemap.ts`; `tests/unit/seoEntity.test.ts` |
| Robots | No `robots.ts` existed; live `robots.txt` returned Next's default 404 page | New allowlist-based `app/robots.ts`: disallow `/` by default, allow only the genuinely public marketing paths + homepage | `app/robots.ts`; `02-seo-entity-audit.md` (before), live-verified 404 |
| About page | Did not exist; footer link was a dead `href="#"` | New page at `/about`, footer link fixed | `app/(marketing)/about/page.tsx`, `components/marketing/LandingPage.tsx` |
| Security/Trust page | Did not exist | New page at `/security`: official domains, verification guidance, phishing disambiguation, reporting route | `app/(marketing)/security/page.tsx` |
| Scam/phishing disambiguation (Problem A) | No statement existed anywhere on the site | Restrained factual statement on `/security`, plus `myfhip.com` declared as the Organization/WebSite `url` in structured data | `app/(marketing)/security/page.tsx`; `lib/seo/entity.ts` |
| Generic-category disambiguation (Problem B) | No statement existed anywhere on the site | About page states the FHIP/expanded-name relationship explicitly; `WebSite.alternateName` includes the expanded name in machine-readable form | `app/(marketing)/about/page.tsx`; `lib/seo/entity.ts` |

All "After" claims above are backed either by a file in this branch (cited) or a passing
regression test (`tests/unit/seoEntity.test.ts`) — none are asserted without evidence in this
table.
