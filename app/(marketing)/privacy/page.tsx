import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Privacy Policy — FHIP',
};

// Draft privacy policy — pending legal review. Intentionally left indexable
// (no noindex) — Facebook's App Review Privacy Policy URL validation checks
// for a noindex/nofollow robots tag as a signal the page isn't a genuine
// public document and rejects it on that basis, which is exactly what
// blocked this page initially. Legal/terms pages are meant to be publicly
// discoverable anyway, unlike the design-preview pages elsewhere in this
// app that legitimately needed to stay hidden. Content here is derived from
// the already-user-approved Security section copy on the landing page
// (components/marketing/LandingPage.tsx), extended into full paragraph
// form, not invented from scratch. Exists as a real, reachable page
// primarily to satisfy OAuth providers (Facebook in particular actively
// crawls and validates that a Privacy Policy URL resolves to genuine
// policy content, not just any URL) — but the underlying need (a real
// privacy policy for an app handling real users' financial data) is
// genuine regardless of that trigger. Must be replaced with
// legally-reviewed final copy before public launch.
export default function PrivacyPolicyPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16 text-gray-800">
      <div className="mb-8 rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <strong>Draft — pending legal review.</strong> This page describes FHIP&apos;s current data practices in
        good faith but has not yet been reviewed by legal counsel and is not a final, binding privacy policy.
      </div>

      <h1 className="text-3xl font-semibold text-trust">Privacy Policy</h1>
      <p className="mt-2 text-sm text-gray-500">Last updated: {new Date().toISOString().slice(0, 10)}</p>

      <section className="mt-8 space-y-3">
        <h2 className="text-xl font-semibold">What we collect</h2>
        <p>
          FHIP collects the financial information you choose to add — income, expenses, assets, liabilities,
          investments, insurance, goals, and household details — along with basic account information (email
          address, authentication method) needed to operate your account.
        </p>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-xl font-semibold">How we use it</h2>
        <p>
          Your information is used to calculate your financial health results, generate reports and
          recommendations, and operate the features you use within FHIP. We do not use your financial data to
          build an advertising profile, and we do not sell your personal information to third parties.
        </p>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-xl font-semibold">Third-party sign-in</h2>
        <p>
          If you sign in using Google, Facebook, or LinkedIn, we receive the basic profile information
          (typically your name and email address) that provider shares with us to create and authenticate your
          account. We do not receive your password for those services, and we do not post to those accounts on
          your behalf.
        </p>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-xl font-semibold">Financial document uploads</h2>
        <p>
          If you choose to upload a financial document (for example a bank, credit card, loan, payslip,
          investment or superannuation/EPF/NPS statement) so FHIP can prepare structured financial
          information for your review, that document is stored privately and is not available for routine
          admin viewing. FHIP&apos;s administrators can see operational information about a document — its
          type, source institution, and processing status — but cannot open, view or download the document
          itself as a matter of routine access.
        </p>
        <p>
          Once you have reviewed and approved the information extracted from a document, the underlying raw
          file is scheduled for deletion according to FHIP&apos;s retention policy — it is not kept
          indefinitely. We retain only the structured financial data, and the minimal provenance details
          needed for your financial profile and for audit purposes, after the raw document has been deleted.
          If a document upload fails or is rejected (for example because the file type isn&apos;t supported),
          it is deleted promptly rather than retained. This deletion follows a short processing/retry window
          rather than happening the instant you click approve.
        </p>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-xl font-semibold">Data control</h2>
        <p>
          You can review, update, or remove information in your account at any time. Connected data sources
          show their origin and last-refresh status so you always know how current a figure is.
        </p>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-xl font-semibold">Security</h2>
        <p>
          Accounts are protected using industry-standard authentication controls. Data is stored with our
          infrastructure providers using encryption in transit and at rest.
        </p>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-xl font-semibold">Contact</h2>
        <p>
          Questions about this policy or your data can be sent to{' '}
          <a href="mailto:amarnath.bekal@gmail.com" className="text-trust underline">
            amarnath.bekal@gmail.com
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
