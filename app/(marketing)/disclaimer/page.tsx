import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Disclaimer — FHIP',
  alternates: { canonical: '/disclaimer' },
};

// LR-9 WP-04 — the marketing footer has carried a "Disclaimer" link (href="#",
// a dead placeholder) since before this phase; this is the first page it
// actually points to. Content mirrors the already-approved, already-live
// disclaimer language used elsewhere in the product (the Consolidated
// Forecasting Report's own "Data Quality & Disclaimer" section,
// app/(app)/forecast/report/page.tsx, and the Terms page's "What FHIP is"
// section) rather than inventing new jurisdiction-specific legal wording —
// WP-04's own instruction. Draft-flagged for the same reason Privacy/Terms
// are: this is FHIP's own good-faith description, not legally reviewed
// final copy.
export default function DisclaimerPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16 text-gray-800">
      <div className="mb-8 rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <strong>Draft — pending legal review.</strong> This page describes FHIP&apos;s intended use in good faith
        but has not yet been reviewed by legal counsel.
      </div>

      <h1 className="text-3xl font-semibold text-trust">Disclaimer</h1>
      <p className="mt-2 text-sm text-gray-500">Last updated: {new Date().toISOString().slice(0, 10)}</p>

      <section className="mt-8 space-y-3">
        <h2 className="text-xl font-semibold">Informational tool, not advice</h2>
        <p>
          FHIP is a financial-health information and planning tool. It provides financial-health results,
          explanations, and deterministic projections based on the information you enter and the assumptions
          shown alongside each result. It does not provide personalised financial, tax, or legal advice, and
          nothing in FHIP should be treated as a recommendation to buy, sell, or hold any specific financial
          product.
        </p>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-xl font-semibold">Forecasts and projections</h2>
        <p>
          Forecasts, scenario comparisons, and required-contribution figures are estimates calculated from the
          data you have recorded and a stated set of assumptions (shown in each report&apos;s own Assumptions
          section) — they are not guarantees of future performance or outcomes. Past forecast accuracy does not
          guarantee future forecast accuracy.
        </p>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-xl font-semibold">AI-generated content</h2>
        <p>
          Where FHIP uses AI to generate an explanation or insight, that output is generated from the same
          recorded data and is intended to help you understand a result — it is not independently verified
          professional advice, and you should exercise your own judgement (or consult a licensed professional)
          before acting on it.
        </p>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-xl font-semibold">Your responsibility</h2>
        <p>
          The accuracy of any result depends on the accuracy and completeness of the information you provide.
          FHIP is not responsible for decisions made using its outputs.
        </p>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-xl font-semibold">Contact</h2>
        <p>
          Questions about this disclaimer can be sent to{' '}
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
