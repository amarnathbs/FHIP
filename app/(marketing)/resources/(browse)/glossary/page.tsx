import type { Metadata } from 'next';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { getPublicGlossaryTerms } from '@/lib/resources/public/queries';
import { getPublicSiteBaseUrl } from '@/lib/resources/public/metadata';
import { Breadcrumbs } from '@/components/resources/public/Breadcrumbs';
import { GlossaryAlphabetNav } from '@/components/resources/public/GlossaryAlphabetNav';
import { PublicEmptyState } from '@/components/resources/public/PublicStates';

export const metadata: Metadata = {
  title: 'Financial Glossary | FHIP Resources',
  description: 'Clear, concise definitions of financial terms.',
  alternates: { canonical: `${getPublicSiteBaseUrl()}/resources/glossary` },
};

function letterOf(title: string): string {
  const ch = title.trim().charAt(0).toUpperCase();
  return /[A-Z]/.test(ch) ? ch : '#';
}

export default async function GlossaryIndexPage() {
  const supabase = await createClient();
  const terms = await getPublicGlossaryTerms(supabase);

  const grouped = new Map<string, typeof terms>();
  for (const term of terms) {
    const letter = letterOf(term.title);
    if (!grouped.has(letter)) grouped.set(letter, []);
    grouped.get(letter)!.push(term);
  }
  const availableLetters = new Set(Array.from(grouped.keys()).filter((l) => l !== '#'));
  const sortedLetters = Array.from(grouped.keys()).sort((a, b) => (a === '#' ? 1 : b === '#' ? -1 : a.localeCompare(b)));

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 py-8 sm:px-6">
      <Breadcrumbs items={[{ label: 'Home', href: '/' }, { label: 'Resources', href: '/resources' }, { label: 'Glossary' }]} />
      <div>
        <h1 className="text-3xl font-bold text-ink">Financial Glossary</h1>
        <p className="mt-2 max-w-2xl text-muted">Clear, concise definitions of financial terms used across FHIP.</p>
      </div>

      {terms.length === 0 ? (
        <PublicEmptyState title="The glossary is being built." message="Check back soon for financial term definitions." />
      ) : (
        <>
          <GlossaryAlphabetNav availableLetters={availableLetters} />
          <div className="space-y-8">
            {sortedLetters.map((letter) => (
              <section key={letter} id={`letter-${letter}`} aria-labelledby={`letter-${letter}-heading`} className="scroll-mt-20">
                <h2 id={`letter-${letter}-heading`} className="border-b border-line pb-1 text-lg font-semibold text-ink">
                  {letter}
                </h2>
                <dl className="mt-3 space-y-3">
                  {grouped.get(letter)!.map((term) =>
                    term.slug ? (
                      <div key={term.id}>
                        <dt>
                          <Link href={`/resources/${term.slug}`} className="font-semibold text-trust hover:underline">
                            {term.title}
                          </Link>
                        </dt>
                        {term.excerpt && <dd className="mt-0.5 text-sm text-muted">{term.excerpt}</dd>}
                      </div>
                    ) : null
                  )}
                </dl>
              </section>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
