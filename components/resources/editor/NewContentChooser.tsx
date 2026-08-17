'use client';

// R1.3 New Content chooser — spec §10. Deliberately shows only the three
// R1.3 content types (Video/Glossary/FAQ/Money Update creation is R1.4+
// scope, spec §4/§10: "Do not show Video, Glossary, FAQ or Money Update
// creation yet").

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { EditableContentType } from '@/lib/resources/editor/types';

const CARDS: { type: EditableContentType; title: string; description: string }[] = [
  { type: 'article', title: 'Article', description: 'General financial education, explanations, commentary and evergreen educational content.' },
  { type: 'guide', title: 'Guide', description: 'Step-by-step or practical instructional content.' },
  { type: 'fhip_explainer', title: 'FHIP Explainer', description: 'Content explaining an FHIP metric, score, methodology, feature or financial-health concept.' },
];

export function NewContentChooser({ canCreate }: { canCreate: boolean }) {
  const router = useRouter();
  const [creating, setCreating] = useState<EditableContentType | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function create(type: EditableContentType) {
    setCreating(type);
    setError(null);
    try {
      const res = await fetch('/api/admin/resources/content', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contentType: type }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not create the new draft.');
      router.push(`/admin/resources/content/${json.data.id}/edit`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
      setCreating(null);
    }
  }

  if (!canCreate) {
    return (
      <div className="rounded-card border border-line bg-white p-6 text-center">
        <p className="text-sm font-semibold text-ink">You don&apos;t have permission to create Resources content.</p>
        <p className="mt-1 text-sm text-muted">Draft creation is available to Authors, Editors, Resource Administrators and Super Admins.</p>
        <Link href="/admin/resources" className="mt-4 inline-block text-sm font-semibold text-trust hover:underline">
          Back to Resources
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
        &gt; <span className="text-ink">Create Resource</span>
      </nav>
      <div>
        <h1 className="text-2xl font-semibold text-ink">Create Resource</h1>
        <p className="mt-1 text-sm text-muted">What type of Resource would you like to create?</p>
      </div>

      {error && (
        <p role="alert" className="rounded-compact border border-risk/30 bg-risk/5 p-3 text-sm text-risk">
          {error}
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {CARDS.map((card) => (
          <button
            key={card.type}
            type="button"
            onClick={() => create(card.type)}
            disabled={creating !== null}
            className="rounded-card border border-line bg-white p-5 text-left hover:border-trust hover:shadow-sm disabled:opacity-50"
          >
            <h2 className="text-base font-semibold text-ink">{card.title}</h2>
            <p className="mt-2 text-sm text-muted">{card.description}</p>
            <p className="mt-4 text-sm font-semibold text-trust">{creating === card.type ? 'Creating…' : `Create ${card.title}`}</p>
          </button>
        ))}
      </div>
    </div>
  );
}
