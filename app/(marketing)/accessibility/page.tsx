import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Accessibility — FHIP',
  alternates: { canonical: '/accessibility' },
};

// LR-9 WP-05 — the marketing footer has carried an "Accessibility" link
// (href="#", a dead placeholder) since before this phase; this is the first
// page it actually points to. Describes FHIP's actual, ongoing accessibility
// practice (keyboard operability, labelled form controls, focus management)
// rather than claiming a formal conformance certification this product has
// not undergone.
export default function AccessibilityPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16 text-gray-800">
      <h1 className="text-3xl font-semibold text-trust">Accessibility</h1>
      <p className="mt-2 text-sm text-gray-500">Last updated: {new Date().toISOString().slice(0, 10)}</p>

      <section className="mt-8 space-y-3">
        <h2 className="text-xl font-semibold">Our commitment</h2>
        <p>
          FHIP aims to be usable by as many people as possible, including people who use a keyboard rather than a
          mouse, people using a screen reader, and people using a narrow mobile screen. Accessibility is an
          ongoing practice we apply as we build and review each feature, not a one-time checklist.
        </p>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-xl font-semibold">What we design for</h2>
        <ul className="list-disc space-y-2 pl-5">
          <li>Every interactive control should be reachable and operable using a keyboard alone.</li>
          <li>Form fields carry a visible, associated label — not placeholder text as the only label.</li>
          <li>Validation errors are associated with the field they describe.</li>
          <li>Opening and closing a form or dialog returns keyboard focus to a predictable place.</li>
          <li>Core screens and controls remain usable on a narrow mobile viewport.</li>
        </ul>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-xl font-semibold">Known limitations</h2>
        <p>
          FHIP has not undergone a formal, independent accessibility conformance audit (for example against
          WCAG), and we do not claim full conformance. Some areas — particularly dense data tables and
          chart-heavy report pages — may not yet meet the standard above as consistently as our simpler forms
          do. We treat a report of an accessibility problem as a real defect, not a feature request.
        </p>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-xl font-semibold">Contact</h2>
        <p>
          If you encounter an accessibility barrier using FHIP, please tell us — including the page and what
          happened — at{' '}
          <a href="mailto:accessibility@myfhip.com" className="text-trust underline">
            accessibility@myfhip.com
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
