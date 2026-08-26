import type { Metadata } from 'next';
import Link from 'next/link';
import { FHIP_BRAND_NAME, FHIP_BRAND_URL, FHIP_EXPANDED_NAME, getFhipApplicationUrl } from '@/lib/seo/entity';

export const metadata: Metadata = {
  title: 'About FHIP — Financial Health Intelligence Platform',
  description:
    'FHIP (Financial Health Intelligence Platform) is a financial-health software product. Learn what FHIP is, what it does, and which domains are official FHIP properties.',
  alternates: { canonical: '/about' },
  openGraph: {
    title: 'About FHIP',
    description: 'What FHIP is, what it does, and which domains are official FHIP properties.',
    url: '/about',
  },
};

// Google Search Entity, Domain Identity & AI Overview Remediation task
// (docs/google-entity-remediation/) — Phase 12/13/15. This page did not
// exist before this task; the landing page footer's "About" link was a
// dead `href="#"` placeholder (see 02-seo-entity-audit.md). Its purpose is
// twofold: (1) give search engines an authoritative, crawlable page that
// states in plain text what FHIP is and which domains belong to it — the
// direct fix for Problem B's generic-category interpretation of
// "financialhealthplatform.com" — and (2) point readers/crawlers to the
// dedicated Security & Trust page for domain-verification and the
// phishing-disambiguation statement (Problem A), rather than duplicating
// that content here.
export default function AboutPage() {
  const appUrl = getFhipApplicationUrl();

  return (
    <div className="mx-auto max-w-3xl px-6 py-16 text-gray-800">
      <h1 className="text-3xl font-semibold text-trust">About FHIP</h1>

      <section className="mt-8 space-y-3">
        <h2 className="text-xl font-semibold">What FHIP is</h2>
        <p>
          <strong>{FHIP_BRAND_NAME}</strong> is the {FHIP_EXPANDED_NAME} — a financial-health software product
          that brings a household&apos;s income, expenses, assets, liabilities, investments, insurance and goals
          into one consolidated view, explains what is going well and what needs attention, and models how
          different choices may shape a household&apos;s financial future. &ldquo;{FHIP_EXPANDED_NAME}&rdquo; is
          the expanded name of the specific branded product FHIP — not a generic description of a category of
          software.
        </p>
        <p>
          FHIP is a financial intelligence and planning tool. It is not a bank, a financial adviser, an
          investment adviser, an insurer, a lender, a broker, or a tax adviser, and nothing on this site is
          personalised financial, tax, or legal advice.
        </p>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-xl font-semibold">Official FHIP domains</h2>
        <p>
          FHIP is reachable at the following official domains. Both belong to the same FHIP product and
          organization.
        </p>
        <ul className="list-disc space-y-1 pl-6">
          <li>
            <a href={FHIP_BRAND_URL} className="text-trust underline" rel="noopener">
              {FHIP_BRAND_URL.replace('https://', '')}
            </a>{' '}
            — FHIP&apos;s public brand domain.
          </li>
          <li>
            <a href={appUrl} className="text-trust underline" rel="noopener">
              {appUrl.replace('https://', '')}
            </a>{' '}
            — the FHIP application itself, where the product runs.
          </li>
        </ul>
        <p>
          For guidance on verifying you are on a genuine FHIP domain, and how to report a suspicious message or
          site claiming to be FHIP, see the{' '}
          <Link href="/security" className="text-trust underline">
            Security &amp; Trust
          </Link>{' '}
          page.
        </p>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-xl font-semibold">Who FHIP is for</h2>
        <p>
          FHIP is built for individuals and households who want a clear, evidence-based view of their financial
          health — across everyday cash flow, longer-term assets and debts, investments, insurance cover, and
          financial goals — without needing to piece that picture together across separate spreadsheets, apps
          and statements themselves.
        </p>
      </section>

      <p className="mt-12 text-sm text-gray-500">
        <Link href="/" className="text-trust underline">
          Back to home
        </Link>
      </p>
    </div>
  );
}
