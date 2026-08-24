'use client';

// FDH-8 Transaction Explorer filter bar. Same "URL is the state" pattern as
// components/resources/public/SearchFilterBar.tsx — every control writes
// straight into the query string via router.push, and the Server Component
// page underneath (transactions/page.tsx) reads it back on every render. No
// filter state is duplicated in this component beyond the search box draft.

import { useState, type FormEvent } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { FDH_ECONOMIC_TRANSACTION_TYPES } from '@/lib/financial-data-hub/constants/enums';

function titleCase(value: string): string {
  return value
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

const REVIEW_STATUS_OPTIONS = [
  { value: '', label: 'Any review status' },
  { value: 'not_required', label: 'Not required' },
  { value: 'pending', label: 'Pending' },
  { value: 'in_review', label: 'In review' },
  { value: 'resolved', label: 'Resolved' },
];

const APPROVAL_STATUS_OPTIONS = [
  { value: '', label: 'Any approval status' },
  { value: 'approved', label: 'Approved' },
  { value: 'pending', label: 'Pending' },
];

const SORT_OPTIONS: { value: string; label: string }[] = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'highest', label: 'Highest amount' },
  { value: 'lowest', label: 'Lowest amount' },
  { value: 'merchant', label: 'Merchant' },
];

export function TransactionFilters({
  accounts,
  categories,
}: {
  accounts: { id: string; label: string }[];
  categories: { id: string; label: string }[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [searchDraft, setSearchDraft] = useState(searchParams.get('q') ?? '');

  function updateParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    router.push(`${pathname}?${params.toString()}`);
  }

  function submitSearch(e: FormEvent) {
    e.preventDefault();
    updateParam('q', searchDraft.trim());
  }

  function clearFilters() {
    const params = new URLSearchParams(searchParams.toString());
    // Preserve the shared period selector's own params — clearing filters
    // should not also silently reset which time range the user is looking at.
    const period = params.get('period');
    const from = params.get('from');
    const to = params.get('to');
    const fresh = new URLSearchParams();
    if (period) fresh.set('period', period);
    if (from) fresh.set('from', from);
    if (to) fresh.set('to', to);
    setSearchDraft('');
    router.push(`${pathname}?${fresh.toString()}`);
  }

  return (
    <div className="space-y-3 rounded-card border border-line bg-white p-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <label htmlFor="txn-account" className="block text-xs font-medium text-muted">
            Account
          </label>
          <select
            id="txn-account"
            value={searchParams.get('account_id') ?? ''}
            onChange={(e) => updateParam('account_id', e.target.value)}
            className="mt-1 w-full rounded-compact border border-line px-2 py-1.5 text-sm text-ink"
          >
            <option value="">All accounts</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="txn-category" className="block text-xs font-medium text-muted">
            Category
          </label>
          <select
            id="txn-category"
            value={searchParams.get('category_id') ?? ''}
            onChange={(e) => updateParam('category_id', e.target.value)}
            className="mt-1 w-full rounded-compact border border-line px-2 py-1.5 text-sm text-ink"
          >
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="txn-type" className="block text-xs font-medium text-muted">
            Economic type
          </label>
          <select
            id="txn-type"
            value={searchParams.get('economic_type') ?? ''}
            onChange={(e) => updateParam('economic_type', e.target.value)}
            className="mt-1 w-full rounded-compact border border-line px-2 py-1.5 text-sm text-ink"
          >
            <option value="">All types</option>
            {FDH_ECONOMIC_TRANSACTION_TYPES.map((t) => (
              <option key={t} value={t}>
                {titleCase(t)}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="txn-review" className="block text-xs font-medium text-muted">
            Review status
          </label>
          <select
            id="txn-review"
            value={searchParams.get('review_status') ?? ''}
            onChange={(e) => updateParam('review_status', e.target.value)}
            className="mt-1 w-full rounded-compact border border-line px-2 py-1.5 text-sm text-ink"
          >
            {REVIEW_STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="txn-approval" className="block text-xs font-medium text-muted">
            Approval status
          </label>
          <select
            id="txn-approval"
            value={searchParams.get('approval_status') ?? ''}
            onChange={(e) => updateParam('approval_status', e.target.value)}
            className="mt-1 w-full rounded-compact border border-line px-2 py-1.5 text-sm text-ink"
          >
            {APPROVAL_STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="txn-sort" className="block text-xs font-medium text-muted">
            Sort
          </label>
          <select
            id="txn-sort"
            value={searchParams.get('sort') ?? 'newest'}
            onChange={(e) => updateParam('sort', e.target.value)}
            className="mt-1 w-full rounded-compact border border-line px-2 py-1.5 text-sm text-ink"
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <form onSubmit={submitSearch} className="min-w-[16rem] flex-1">
          <label htmlFor="txn-search" className="block text-xs font-medium text-muted">
            Search description
          </label>
          <div className="mt-1 flex gap-2">
            <input
              id="txn-search"
              type="search"
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
              placeholder="e.g. Woolworths"
              className="w-full rounded-compact border border-line px-2 py-1.5 text-sm text-ink"
            />
            <button type="submit" className="rounded-compact border border-line px-3 py-1.5 text-sm font-medium text-ink hover:border-trust hover:text-trust">
              Search
            </button>
          </div>
        </form>
        <button type="button" onClick={clearFilters} className="rounded-compact px-3 py-1.5 text-sm font-medium text-muted hover:text-ink">
          Clear filters
        </button>
      </div>
    </div>
  );
}
