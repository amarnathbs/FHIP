// R1.6 public search box — spec §13/§69. A plain GET <form> (progressive
// enhancement, same philosophy as Pagination.tsx: works with zero client JS
// since the query genuinely lives in the URL — spec §11 "Search query must
// live in the URL"). `variant="compact"` is the small nav/landing-page entry
// point (spec §12/§69); `variant="full"` is the /resources/search page's own
// primary field.

import { MAX_SEARCH_QUERY_LENGTH } from '@/lib/resources/search/validation';

export function SearchBox({ defaultValue = '', variant = 'full', placeholder }: { defaultValue?: string; variant?: 'full' | 'compact'; placeholder?: string }) {
  const inputId = variant === 'compact' ? 'resources-search-compact' : 'resources-search-main';
  return (
    <form action="/resources/search" method="get" role="search" className={variant === 'compact' ? 'flex w-full max-w-sm items-center gap-2' : 'flex w-full max-w-2xl items-center gap-2'}>
      <label htmlFor={inputId} className="sr-only">
        Search Resources
      </label>
      <input
        id={inputId}
        type="search"
        name="q"
        defaultValue={defaultValue}
        maxLength={MAX_SEARCH_QUERY_LENGTH}
        placeholder={placeholder ?? 'Search financial topics, terms and guides'}
        className="w-full rounded-compact border border-line bg-white px-4 py-2.5 text-sm text-ink placeholder:text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-trust"
      />
      <button type="submit" className="shrink-0 rounded-compact bg-trust px-4 py-2.5 text-sm font-semibold text-white hover:bg-trust-700">
        Search
      </button>
    </form>
  );
}
