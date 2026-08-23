// Resources Admin content-list filter parsing/validation — spec §67-69.
//
// Every value that reaches a Supabase query builder here comes from this
// whitelist parser first. Unknown/garbage query-string values (e.g.
// `?status=HACK`) fall back to a safe default rather than being passed
// through — there is no raw column-name interpolation anywhere in this
// file, so there is no SQL-injection surface to begin with, but a bad enum
// value could still produce a confusing "0 results" query if it leaked
// through unchecked, which this prevents.

import { CONTENT_TYPE_VALUES, JURISDICTION_VALUES, COMPLIANCE_VALUES, STATUS_VALUES } from './labels';
import type { ResourceContentType, ResourceJurisdiction, ComplianceClassification, ResourceStatus } from '@/lib/resources/types';

export type ContentSort = 'updated_desc' | 'updated_asc' | 'title_asc' | 'published_desc' | 'review_asc';
const SORT_VALUES: ContentSort[] = ['updated_desc', 'updated_asc', 'title_asc', 'published_desc', 'review_asc'];

export interface ContentListFilters {
  search: string;
  status: ResourceStatus | 'all';
  contentType: ResourceContentType | 'all';
  jurisdiction: ResourceJurisdiction | 'all';
  compliance: ComplianceClassification | 'all';
  categoryId: string | 'all';
  sort: ContentSort;
  page: number;
  pageSize: number;
}

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100; // spec §68 hard clamp — never let a query param request millions of rows.
const MAX_PAGE = 100000;

// A UUID-shaped string check for categoryId — not a full RFC validator, just
// enough to reject obviously-wrong input before it reaches `.eq('category_id', ...)`.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseContentListFilters(searchParams: URLSearchParams): ContentListFilters {
  const status = searchParams.get('status') ?? 'all';
  const contentType = searchParams.get('type') ?? 'all';
  const jurisdiction = searchParams.get('jurisdiction') ?? 'all';
  const compliance = searchParams.get('compliance') ?? 'all';
  const categoryId = searchParams.get('category') ?? 'all';
  const sort = searchParams.get('sort') ?? 'updated_desc';
  const search = (searchParams.get('q') ?? '').trim().slice(0, 200); // sensible cap on search-string length

  const pageRaw = Number.parseInt(searchParams.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.min(pageRaw, MAX_PAGE) : 1;

  const pageSizeRaw = Number.parseInt(searchParams.get('pageSize') ?? String(DEFAULT_PAGE_SIZE), 10);
  const pageSize = Number.isFinite(pageSizeRaw) && pageSizeRaw >= 1 ? Math.min(pageSizeRaw, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;

  return {
    search,
    status: (STATUS_VALUES as string[]).includes(status) ? (status as ResourceStatus) : 'all',
    contentType: (CONTENT_TYPE_VALUES as string[]).includes(contentType) ? (contentType as ResourceContentType) : 'all',
    jurisdiction: (JURISDICTION_VALUES as string[]).includes(jurisdiction) ? (jurisdiction as ResourceJurisdiction) : 'all',
    compliance: (COMPLIANCE_VALUES as string[]).includes(compliance) ? (compliance as ComplianceClassification) : 'all',
    categoryId: categoryId === 'all' || UUID_RE.test(categoryId) ? categoryId : 'all',
    sort: (SORT_VALUES as string[]).includes(sort) ? (sort as ContentSort) : 'updated_desc',
    page,
    pageSize,
  };
}

// Route-based workflow-queue presets (spec §35) — each queue is the same
// underlying list query with a different fixed status filter, not a
// duplicated page/query implementation.
export type QueuePreset = 'drafts' | 'review' | 'scheduled' | 'published' | 'review-due' | 'archived';

export const QUEUE_STATUS_GROUPS: Record<QueuePreset, ResourceStatus[]> = {
  drafts: ['idea', 'draft'],
  review: ['editorial_review', 'compliance_review', 'approved'],
  scheduled: ['scheduled'],
  published: ['published'],
  'review-due': ['review_due'],
  archived: ['archived'],
};

export const QUEUE_TITLES: Record<QueuePreset, string> = {
  drafts: 'Drafts',
  review: 'Review Queue',
  scheduled: 'Scheduled',
  published: 'Published',
  'review-due': 'Review Due',
  archived: 'Archived',
};
