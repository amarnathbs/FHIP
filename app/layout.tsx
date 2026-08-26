import type { Metadata } from 'next';
import './globals.css';
import { QueryProvider } from '@/components/providers/QueryProvider';
import {
  FHIP_PRODUCT_PRESENTATION,
  FHIP_EXPANDED_NAME,
  buildFhipEntityJsonLd,
  getFhipApplicationUrl,
} from '@/lib/seo/entity';

// Google Search Entity, Domain Identity & AI Overview Remediation task
// (docs/google-entity-remediation/) — Phase 3/4/16: the site-wide default
// title/description must never present the expanded name
// ("Financial Health Intelligence Platform") without the FHIP brand token.
// The previous default here was the bare expanded name with no brand at
// all. Individual routes (e.g. app/(marketing)/page.tsx) already set their
// own brand-first titles and are unaffected by this change — this is only
// the fallback used by routes that don't set their own <title>.
//
// metadataBase is new: previously unset, which meant relative OG/Twitter
// image URLs anywhere in the app could not resolve to absolute URLs
// (Next.js requirement/warning). Set to the real application host — the
// domain that actually serves this markup — not the marketing brand
// domain, which never serves a page of its own (see lib/seo/entity.ts).
export const metadata: Metadata = {
  metadataBase: new URL(getFhipApplicationUrl()),
  title: FHIP_PRODUCT_PRESENTATION,
  description: `${FHIP_EXPANDED_NAME} — understand and improve your financial health.`,
  openGraph: {
    siteName: FHIP_PRODUCT_PRESENTATION.split(' | ')[0], // 'FHIP' — inherited by any page that doesn't set its own openGraph.siteName
    locale: 'en_AU',
    type: 'website',
  },
  icons: {
    icon: [
      { url: '/images/fhip-icon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/images/fhip-icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: '/images/fhip-icon-180.png',
  },
};

// Phase 5-8: one FHIP entity graph (Organization -> WebSite -> WebApplication)
// emitted site-wide from the root layout so every page — not just the
// homepage — carries the same structured-data evidence tying the FHIP
// brand, myfhip.com and the application domain together. See
// lib/seo/entity.ts for the full relationship rationale and
// docs/google-entity-remediation/04-structured-data-design.md for the
// Phase 8 writeup.
const fhipEntityJsonLd = buildFhipEntityJsonLd();

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="font-sans text-gray-900 antialiased">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({ '@context': 'https://schema.org', '@graph': fhipEntityJsonLd }),
          }}
        />
        <QueryProvider>{children}</QueryProvider>
      </body>
    </html>
  );
}
