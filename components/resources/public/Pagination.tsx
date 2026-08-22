// Server-rendered pagination (spec §26: "Use server-side pagination... do
// not retrieve all Resources at once") — plain links carrying page state in
// the URL query string, no client JS required to page through results
// (spec §77/§78: progressive enhancement).

import Link from 'next/link';

export function Pagination({ page, totalPages, buildHref }: { page: number; totalPages: number; buildHref: (page: number) => string }) {
  if (totalPages <= 1) return null;

  const prevDisabled = page <= 1;
  const nextDisabled = page >= totalPages;

  return (
    <nav aria-label="Pagination" className="flex items-center justify-center gap-4 pt-4 text-sm">
      {prevDisabled ? (
        <span className="cursor-not-allowed rounded-compact border border-line px-3 py-1.5 text-muted opacity-50">Previous</span>
      ) : (
        <Link href={buildHref(page - 1)} className="rounded-compact border border-line px-3 py-1.5 text-ink hover:border-trust hover:text-trust">
          Previous
        </Link>
      )}
      <span className="text-muted" aria-current="page">
        Page {page} of {totalPages}
      </span>
      {nextDisabled ? (
        <span className="cursor-not-allowed rounded-compact border border-line px-3 py-1.5 text-muted opacity-50">Next</span>
      ) : (
        <Link href={buildHref(page + 1)} className="rounded-compact border border-line px-3 py-1.5 text-ink hover:border-trust hover:text-trust">
          Next
        </Link>
      )}
    </nav>
  );
}
