'use client';

// Responsive content table — spec §20-21, §54. A real `<table>` with proper
// `<th>` headers on desktop; below `sm` it switches to a stacked-card
// layout so no data is clipped in a too-narrow table (spec §21: "prefer
// responsive cards... rather than clipping data").

import Link from 'next/link';
import { ResourceStatusBadge, ResourceComplianceBadge, ResourceJurisdictionBadge, ResourceTypeBadge } from './ResourceBadges';
import { formatAdminDate } from '@/lib/resources/admin/labels';
import type { ContentListItem } from '@/lib/resources/admin/queries';

export function ResourceContentTable({ items }: { items: ContentListItem[] }) {
  return (
    <>
      {/* Desktop / tablet table */}
      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
              <th scope="col" className="py-2 pr-3 font-semibold">Title</th>
              <th scope="col" className="hidden py-2 pr-3 font-semibold md:table-cell">Type</th>
              <th scope="col" className="hidden py-2 pr-3 font-semibold lg:table-cell">Category</th>
              <th scope="col" className="hidden py-2 pr-3 font-semibold lg:table-cell">Jurisdiction</th>
              <th scope="col" className="py-2 pr-3 font-semibold">Status</th>
              <th scope="col" className="py-2 pr-3 font-semibold">Compliance</th>
              <th scope="col" className="hidden py-2 pr-3 font-semibold md:table-cell">Author</th>
              <th scope="col" className="hidden py-2 pr-3 font-semibold sm:table-cell">Updated</th>
              <th scope="col" className="hidden py-2 pr-3 font-semibold xl:table-cell">Review</th>
              <th scope="col" className="py-2 pl-3 font-semibold">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className="border-b border-line/60 hover:bg-gray-50">
                <td className="max-w-[280px] py-2.5 pr-3">
                  <Link href={`/admin/resources/content/${item.id}`} className="font-medium text-ink hover:text-trust hover:underline">
                    {item.title}
                  </Link>
                  {item.content_id && <p className="text-xs text-muted">{item.content_id}</p>}
                </td>
                <td className="hidden py-2.5 pr-3 md:table-cell">
                  <ResourceTypeBadge contentType={item.content_type} />
                </td>
                <td className="hidden py-2.5 pr-3 text-muted lg:table-cell">{item.primary_category?.name ?? '—'}</td>
                <td className="hidden py-2.5 pr-3 lg:table-cell">
                  <ResourceJurisdictionBadge jurisdiction={item.jurisdiction} />
                </td>
                <td className="py-2.5 pr-3">
                  <ResourceStatusBadge status={item.status} />
                </td>
                <td className="py-2.5 pr-3">
                  <ResourceComplianceBadge compliance={item.compliance_classification} />
                </td>
                <td className="hidden py-2.5 pr-3 text-muted md:table-cell">{item.author?.name ?? '—'}</td>
                <td className="hidden py-2.5 pr-3 text-muted sm:table-cell">{formatAdminDate(item.updated_at)}</td>
                <td className="hidden py-2.5 pr-3 text-muted xl:table-cell">{formatAdminDate(item.next_review_at)}</td>
                <td className="py-2.5 pl-3 text-right">
                  <Link href={`/admin/resources/content/${item.id}`} className="text-xs font-semibold text-trust hover:underline" aria-label={`View "${item.title}"`}>
                    View
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile stacked cards */}
      <ul className="space-y-2 sm:hidden">
        {items.map((item) => (
          <li key={item.id} className="rounded-card border border-line p-3">
            <Link href={`/admin/resources/content/${item.id}`} className="font-medium text-ink hover:text-trust hover:underline" aria-label={`View "${item.title}"`}>
              {item.title}
            </Link>
            {item.content_id && <p className="text-xs text-muted">{item.content_id}</p>}
            <div className="mt-2 flex flex-wrap gap-1.5">
              <ResourceStatusBadge status={item.status} />
              <ResourceComplianceBadge compliance={item.compliance_classification} />
              <ResourceTypeBadge contentType={item.content_type} />
              <ResourceJurisdictionBadge jurisdiction={item.jurisdiction} />
            </div>
            <p className="mt-2 text-xs text-muted">Updated {formatAdminDate(item.updated_at)}</p>
          </li>
        ))}
      </ul>
    </>
  );
}
