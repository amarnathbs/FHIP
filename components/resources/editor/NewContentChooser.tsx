'use client';

// R1.3 New Content chooser — spec §10. Deliberately shows only the three
// R1.3 content types (Video/Glossary/FAQ/Money Update creation is R1.4+
// scope, spec §4/§10: "Do not show Video, Glossary, FAQ or Money Update
// creation yet").

import Link from 'next/link';
import type { EditableContentType } from '@/lib/resources/editor/types';

// PO review F3 (06/10/2026): choosing a type only OPENS the editor
// (/admin/resources/content/new?type=…). Nothing is written to the database
// until the author presses Save inside the editor, so abandoning the page
// leaves no empty "Untitled" draft behind.

const CARDS: { type: EditableContentType; title: string; description: string }[] = [
  { type: 'article', title: 'Article', description: 'General financial education, explanations, commentary and evergreen educational content.' },
  { type: 'guide', title: 'Guide', description: 'Step-by-step or practical instructional content.' },
  { type: 'fhip_explainer', title: 'FHIP Explainer', description: 'Content explaining an FHIP metric, score, methodology, feature or financial-health concept.' },
];

export function NewContentChooser({ canCreate }: { canCreate: boolean }) {
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

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {CARDS.map((card) => (
          <Link
            key={card.type}
            href={`/admin/resources/content/new?type=${card.type}`}
            className="block rounded-card border border-line bg-white p-5 text-left hover:border-trust hover:shadow-sm"
          >
            <h2 className="text-base font-semibold text-ink">{card.title}</h2>
            <p className="mt-2 text-sm text-muted">{card.description}</p>
            <p className="mt-4 text-sm font-semibold text-trust">{`Create ${card.title}`}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
