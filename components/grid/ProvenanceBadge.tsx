'use client';

/**
 * WP-07 -- the generic "Imported from ..." badge for an Input Data row.
 * All meaning lives in lib/grid/provenance.ts; this only renders it. A
 * manual row renders nothing. The history link is shown only when the
 * domain's history page exists (see HISTORY_ROUTE_BUILDER there).
 */
import { provenanceBadgeFor, type ProvenanceRow } from '@/lib/grid/provenance';

export function ProvenanceBadge({ row, showLink = true, className = '' }: { row: ProvenanceRow; showLink?: boolean; className?: string }) {
  const badge = provenanceBadgeFor(row);
  if (!badge) return null;
  return (
    <span className={`inline-flex flex-wrap items-center gap-1 ${className}`} data-provenance={badge.sourceType}>
      <span title={badge.title} className="inline-block rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-medium text-blue-700">
        {badge.label}
      </span>
      {showLink && badge.historyHref && (
        <a href={badge.historyHref} className="text-[11px] text-trust underline">
          {badge.historyLabel}
        </a>
      )}
    </span>
  );
}
