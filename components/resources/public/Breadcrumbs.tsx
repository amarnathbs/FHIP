// Spec §99: accessible breadcrumbs, e.g. "Home > Resources > Investing >
// Article Title" — never internal Admin taxonomy IDs/slugs raw.

import Link from 'next/link';

export interface BreadcrumbItem {
  label: string;
  href?: string; // omitted (or undefined) for the current page
}

export function Breadcrumbs({ items }: { items: BreadcrumbItem[] }) {
  return (
    <nav aria-label="Breadcrumb" className="text-sm text-muted">
      <ol className="flex flex-wrap items-center gap-1">
        {items.map((item, i) => (
          <li key={i} className="flex items-center gap-1">
            {i > 0 && <span aria-hidden="true">&gt;</span>}
            {item.href ? (
              <Link href={item.href} className="hover:text-trust hover:underline">
                {item.label}
              </Link>
            ) : (
              <span aria-current="page" className="text-ink">
                {item.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
