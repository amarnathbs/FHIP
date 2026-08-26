import type { Metadata } from 'next';
import Link from 'next/link';
import { FHIP_BRAND_URL, getFhipApplicationUrl } from '@/lib/seo/entity';

export const metadata: Metadata = {
  title: 'Security & Trust — FHIP',
  description:
    'How to verify you are on an official FHIP domain, FHIP’s relationship to myfhip.com and app.financialhealthplatform.com, and how to report a suspicious message or site.',
  alternates: { canonical: '/security' },
  openGraph: {
    title: 'Security & Trust — FHIP',
    description: 'Official FHIP domains, how to verify them, and how to report suspicious communications.',
    url: '/security',
  },
};

// Google Search Entity, Domain Identity & AI Overview Remediation task
// (docs/google-entity-remediation/) — Phase 13/14/24. This page did not
// exist before this task. It exists to give users AND search engines one
// authoritative page that (a) lists FHIP's real official domains,
// (b) explains how to verify a genuine FHIP site/communication, and
// (c) carries the restrained, factual phishing-disambiguation statement
// for Problem A (the false myfhip.com/MyShip association) — worded once,
// here, rather than repeated across the site (spec §20: repeating
// scam/phishing wording sitewide risks strengthening the wrong lexical
// association, so it appears on exactly this one page).
export default function SecurityTrustPage() {
  const appUrl = getFhipApplicationUrl();

  return (
    <div className="mx-auto max-w-3xl px-6 py-16 text-gray-800">
      <h1 className="text-3xl font-semibold text-trust">Security &amp; Trust</h1>
      <p className="mt-2 text-gray-600">
        How to confirm you&apos;re using a genuine FHIP domain, and how to report anything that looks like it&apos;s
        impersonating FHIP.
      </p>

      <section className="mt-8 space-y-3">
        <h2 className="text-xl font-semibold">Official FHIP domains</h2>
        <p>FHIP operates from exactly two official domains:</p>
        <ul className="list-disc space-y-1 pl-6">
          <li>
            <a href={FHIP_BRAND_URL} className="text-trust underline" rel="noopener">
              {FHIP_BRAND_URL.replace('https://', '')}
            </a>{' '}
            — FHIP&apos;s public brand domain. It redirects to the application below.
          </li>
          <li>
            <a href={appUrl} className="text-trust underline" rel="noopener">
              {appUrl.replace('https://', '')}
            </a>{' '}
            — where the FHIP application itself runs, and where you sign in and use FHIP.
          </li>
        </ul>
        <p>
          FHIP does not operate under any other domain name, and does not ask you to sign in, enter your
          password, or provide financial account credentials anywhere except the application domain above.
        </p>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-xl font-semibold">myfhip.com is not affiliated with MyShip or 7-Eleven Taiwan</h2>
        <p>
          FHIP (myfhip.com) is an independent financial-health platform and is not affiliated with MyShip,
          7-Eleven Taiwan, parcel-delivery services, or any online marketplace-delivery service. Some
          unrelated domains and social-media posts have discussed suspicious URLs containing similar text in
          connection with a Taiwan marketplace/delivery scam; those reports describe different domains, not
          myfhip.com. If you have arrived here from a search result or an AI-generated summary describing
          myfhip.com as a delivery-scam or phishing site, that description does not reflect this domain or this
          product.
        </p>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-xl font-semibold">How to verify an official FHIP communication</h2>
        <ul className="list-disc space-y-1 pl-6">
          <li>Genuine FHIP account emails (sign-up confirmation, password reset) are sent from an address on the auth.financialhealthplatform.com mail domain.</li>
          <li>FHIP will never ask you to provide your password by email, phone, or text message.</li>
          <li>If a link claims to be FHIP but does not lead to one of the two domains listed above, do not enter any information on it.</li>
        </ul>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-xl font-semibold">Account safety</h2>
        <p>
          Keep your account credentials private, use a unique password for your FHIP account, and sign out of
          shared or public devices after use. If you sign in using Google or LinkedIn, FHIP never receives or
          stores your password for those services.
        </p>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-xl font-semibold">Reporting a suspicious site or message</h2>
        <p>
          If you encounter a website, email, or message that claims to be FHIP but isn&apos;t one of the two
          domains listed above, please let us know via the{' '}
          <Link href="/contact" className="text-trust underline">
            contact form
          </Link>{' '}
          or by emailing{' '}
          <a href="mailto:support@myfhip.com" className="text-trust underline">
            support@myfhip.com
          </a>
          .
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
