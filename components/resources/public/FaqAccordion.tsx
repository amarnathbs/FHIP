// Spec §50-52: reusable FAQ display, accessible accordion, native
// disclosure (spec §52: "Use native disclosure or an established accessible
// accordion... do not build a div-only custom accordion" — <details>/
// <summary> is exactly that, keyboard-activatable and readable when
// collapsed with zero extra JS). Spec §51: respects sort_order (the caller
// already sorted; this just renders in the given order). Only active FAQs
// ever reach this component — getPublicFaqsForPost() already filters
// is_active at the query layer.

import { BlockRenderer } from '@/components/resources/blocks/BlockRenderer';
import type { PublicFaq } from '@/lib/resources/public/queries';
import type { AnyBlock } from '@/lib/resources/editor/blocks';

export function FaqAccordion({ faqs }: { faqs: PublicFaq[] }) {
  if (faqs.length === 0) return null;

  return (
    <section aria-labelledby="faq-heading" className="space-y-3">
      <h2 id="faq-heading" className="text-xl font-semibold text-ink">
        Frequently Asked Questions
      </h2>
      <div className="divide-y divide-line rounded-card border border-line bg-white">
        {faqs.map((faq) => (
          <details key={faq.id} className="group p-4">
            <summary className="cursor-pointer list-none font-medium text-ink marker:content-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-trust">
              <span className="flex items-center justify-between gap-3">
                {faq.question}
                <span aria-hidden="true" className="shrink-0 text-muted transition group-open:rotate-180">
                  &#9662;
                </span>
              </span>
            </summary>
            <div className="mt-3 space-y-3 text-sm leading-relaxed text-ink">
              {faq.short_answer && <p>{faq.short_answer}</p>}
              {faq.answer_blocks.length > 0 && <BlockRenderer blocks={faq.answer_blocks as AnyBlock[]} />}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}
