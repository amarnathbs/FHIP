import type { MetadataRoute } from 'next';
import { getPublicSiteBaseUrl } from '@/lib/resources/public/metadata';
import { ROBOTS_PUBLIC_PATHS } from '@/lib/seo/entity';

// Google Search Entity, Domain Identity & AI Overview Remediation task
// (docs/google-entity-remediation/) — Phase 19. No robots.ts existed
// anywhere in the repository before this task (confirmed via a full-repo
// search) — this app/robots.ts is a first instance, following the same
// "no pre-existing system to reuse" precedent as app/sitemap.ts (see that
// file's own header comment from the R1.5 delivery).
//
// Allowlist strategy: disallow everything by default, then allow back in
// only the specific, genuinely-public marketing paths. Google resolves
// robots.txt directives by longest (most specific) path match rather than
// declaration order, so `disallow: '/'` alongside a more specific
// `allow: '/resources'` correctly permits crawling under /resources/* while
// still blocking everything else — including every authenticated
// application route (dashboard, forecast, investment-intelligence, admin,
// the financial data hub area, etc.), every /api/* route, and the
// auth/onboarding flows. This is safer than hand-enumerating every private
// route: a newly-added private feature is blocked by default rather than
// depending on someone remembering to add it to a disallow list.
export default function robots(): MetadataRoute.Robots {
  const baseUrl = getPublicSiteBaseUrl();

  return {
    rules: [
      {
        userAgent: '*',
        allow: ['/$', ...ROBOTS_PUBLIC_PATHS],
        disallow: '/',
      },
    ],
    sitemap: `${baseUrl}/sitemap.xml`,
  };
}
