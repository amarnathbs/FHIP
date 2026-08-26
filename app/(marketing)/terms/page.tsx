import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Terms of Service — FHIP',
  alternates: { canonical: '/terms' },
};

// Draft terms of service — pending legal review. Intentionally left
// indexable (no noindex) — see privacy/page.tsx for why.
export default function TermsPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16 text-gray-800">
      <div className="mb-8 rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <strong>Draft — pending legal review.</strong> This page has not yet been reviewed by legal counsel and
        is not a final, binding terms of service.
      </div>

      <h1 className="text-3xl font-semibold text-trust">Terms of Service</h1>
      <p className="mt-2 text-sm text-gray-500">Last updated: {new Date().toISOString().slice(0, 10)}</p>

      <section className="mt-8 space-y-3">
        <h2 className="text-xl font-semibold">What FHIP is</h2>
        <p>
          FHIP is a financial intelligence and planning tool. It provides financial-health information,
          explanations, and deterministic projections based on the information you provide. It is not
          personalised financial, tax, or legal advice, and forecasts are estimates, not guarantees.
        </p>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-xl font-semibold">Your account</h2>
        <p>
          You&apos;re responsible for keeping your account credentials secure and for the accuracy of the
          information you provide. You can close your account and request deletion of your data at any time.
        </p>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-xl font-semibold">Acceptable use</h2>
        <p>
          Use FHIP only for its intended purpose of managing your own (or your household&apos;s) financial
          information. Do not attempt to access other users&apos; data or disrupt the service.
        </p>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-xl font-semibold">Changes</h2>
        <p>These terms may be updated as FHIP evolves. Material changes will be communicated to users.</p>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-xl font-semibold">Contact</h2>
        <p>
          Questions about these terms can be sent to{' '}
          <a href="mailto:compliance@myfhip.com" className="text-trust underline">
            compliance@myfhip.com
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
