// Spec §48-49/§96: authoritative Sources display. Every URL is re-validated
// here (isSafeSourceUrl, the same R1.4 check the editor uses at creation
// time) before ever being placed in an href — defense in depth for public
// rendering, spec §96: "unsafe scheme (javascript:) must never render as an
// executable public link." A source whose URL fails the check still shows
// its citation text, just without a clickable link.

import { formatPublicDate } from '@/lib/resources/public/metadata';
import { isSafeSourceUrl } from '@/lib/resources/sources/validation';
import type { PublicSource } from '@/lib/resources/public/queries';

export function SourceList({ sources }: { sources: PublicSource[] }) {
  if (sources.length === 0) return null;

  return (
    <section aria-labelledby="sources-heading" className="space-y-3">
      <h2 id="sources-heading" className="text-xl font-semibold text-ink">
        Authoritative Sources
      </h2>
      <ul className="space-y-2 text-sm">
        {sources.map((s) => {
          const label = s.document_title || s.source_name;
          const dateLabel = formatPublicDate(s.publication_date);
          const safe = s.url ? isSafeSourceUrl(s.url) : false;
          return (
            <li key={s.id} className="rounded-card border border-line bg-white p-3">
              <div className="font-medium text-ink">
                {safe && s.url ? (
                  <a href={s.url} target="_blank" rel="noopener noreferrer nofollow" className="text-trust hover:underline">
                    {label}
                  </a>
                ) : (
                  label
                )}
              </div>
              <div className="text-xs text-muted">
                {s.source_name}
                {dateLabel && ` · ${dateLabel}`}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
