// Spec §42-43: Glossary detail. Related Terms is the one explicitly-stored
// relationship spec §43/§59 permits R1.5 to render (resource_related_content,
// relationship_type='related') — never a generalised related-content engine.

import Link from 'next/link';
import { BlockRenderer } from '@/components/resources/blocks/BlockRenderer';
import type { AnyBlock } from '@/lib/resources/editor/blocks';
import type { PublicResourceDetail } from '@/lib/resources/public/queries';

export function GlossaryDetailBody({
  aliases,
  contentBlocks,
  relatedTerms,
}: {
  aliases: string[] | null;
  contentBlocks: unknown[];
  relatedTerms: PublicResourceDetail['relatedGlossaryTerms'];
}) {
  return (
    <div className="space-y-6">
      {aliases && aliases.length > 0 && (
        <p className="text-sm text-muted">
          <span className="font-semibold text-ink">Also known as:</span> {aliases.join(', ')}
        </p>
      )}

      <BlockRenderer blocks={contentBlocks as AnyBlock[]} />

      {relatedTerms.length > 0 && (
        <section aria-labelledby="related-terms-heading" className="border-t border-line pt-4">
          <h2 id="related-terms-heading" className="text-xl font-semibold text-ink">
            Related Terms
          </h2>
          <ul className="mt-3 flex flex-wrap gap-2">
            {relatedTerms.map((t) =>
              t.slug ? (
                <li key={t.id}>
                  <Link href={`/resources/${t.slug}`} className="rounded-full bg-gray-100 px-3 py-1 text-sm text-ink hover:bg-trust/10 hover:text-trust">
                    {t.title}
                  </Link>
                </li>
              ) : null
            )}
          </ul>
        </section>
      )}
    </div>
  );
}
