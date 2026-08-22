'use client';

// R1.4 Glossary creation — spec §26: single content type, so this is a
// create-and-redirect button, same pattern as R1.3's NewContentChooser.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

export function GlossaryNewButton({ canCreate }: { canCreate: boolean }) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setCreating(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/resources/glossary', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not create this glossary definition.');
      router.push(`/admin/resources/glossary/${json.data.id}/edit`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
      setCreating(false);
    }
  }

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
      {error && (
        <p role="alert" className="rounded-compact border border-risk/30 bg-risk/5 p-3 text-sm text-risk">
          {error}
        </p>
      )}
      <button type="button" onClick={create} disabled={creating} className="rounded-full bg-trust px-4 py-2 text-sm font-semibold text-white hover:bg-trust/90 disabled:opacity-50">
        {creating ? 'Creating…' : 'Create Glossary Definition'}
      </button>
    </div>
  );
}
