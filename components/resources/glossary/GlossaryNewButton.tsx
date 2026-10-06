'use client';

// R1.4 Glossary creation — spec §26: single content type, so this is a
// create-and-redirect button, same pattern as R1.3's NewContentChooser.

import Link from 'next/link';

// PO review F3 (06/10/2026): the New Glossary Definition page now opens the
// editor directly (nothing is created until Save). This component remains for
// the no-permission notice only.
export function GlossaryNewButton({ canCreate }: { canCreate: boolean }) {
  if (!canCreate) {
    return (
      <div className="rounded-card border border-line bg-white p-6 text-center">
        <p className="text-sm font-semibold text-ink">You don&apos;t have permission to create a glossary definition.</p>
        <Link href="/admin/resources/glossary" className="mt-4 inline-block text-sm font-semibold text-trust hover:underline">
          Back to Glossary
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <nav aria-label="Breadcrumb" className="text-sm text-muted">
        <Link href="/admin/resources" className="hover:text-trust hover:underline">
          Resources
        </Link>{' '}
        &gt;{' '}
        <Link href="/admin/resources/glossary" className="hover:text-trust hover:underline">
          Glossary
        </Link>{' '}
        &gt; <span className="text-ink">New</span>
      </nav>
      <div>
        <h1 className="text-2xl font-semibold text-ink">New Glossary Definition</h1>
        <p className="mt-1 text-sm text-muted">A concise financial definition — plain English, avoid unexplained jargon.</p>
      </div>
    </div>
  );
}
