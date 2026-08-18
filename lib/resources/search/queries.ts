// R1.6 Public Search query layer — spec Part A.
//
// Deliberately takes the plain request-scoped anon/authenticated Supabase
// client, exactly like every function in lib/resources/public/queries.ts
// (spec §25/§137: "no service-role search"). The heavy lifting — ranking,
// pagination, the visibility predicate — happens inside
// public.search_resource_posts() (migration 0040), which itself runs
// SECURITY INVOKER under this same caller's RLS, so there are two
// independent layers keeping non-public content out: the RPC's own WHERE
// clause (mirroring applyPublicPostVisibility exactly) and the caller's RLS
// underneath it.
//
// The RPC returns only the ranked id + rank_score + total_count — full card
// data (category, video thumbnail) is then fetched through the exact same
// CARD_COLUMNS/normalizeCard path every other public listing uses (spec
// §73), then re-sorted into the RPC's rank order (a plain `id in (...)`
// fetch does not preserve order).

import type { SupabaseClient } from '@supabase/supabase-js';
import { CARD_COLUMNS, normalizeCard, type PublicResourceCard, type PaginatedResult, type RawCardRow } from '@/lib/resources/public/queries';
import { normalizeSearchQuery, type SearchContentTypeFilter, type SearchJurisdictionFilter } from './validation';

export interface SearchFilters {
  q: string;
  contentType: SearchContentTypeFilter;
  jurisdiction: SearchJurisdictionFilter;
  page: number;
  pageSize?: number;
}

interface SearchRpcRow {
  id: string;
  rank_score: number;
  total_count: number;
}

export async function searchPublicResources(supabase: SupabaseClient, filters: SearchFilters): Promise<PaginatedResult<PublicResourceCard>> {
  const q = normalizeSearchQuery(filters.q);
  const pageSize = filters.pageSize ?? 12; // spec §23
  const page = Math.max(1, filters.page);

  // spec §21: "Do not execute an expensive empty database search" — an
  // empty normalised query never reaches the RPC at all.
  if (!q) return { items: [], total: 0, page: 1, pageSize, totalPages: 1 };

  const { data: rpcRows, error: rpcError } = await supabase.rpc('search_resource_posts', {
    p_query: q,
    p_content_type: filters.contentType === 'all' ? null : filters.contentType,
    p_jurisdiction: filters.jurisdiction === 'all' ? null : filters.jurisdiction,
    p_limit: pageSize,
    p_offset: (page - 1) * pageSize,
  });
  if (rpcError) throw rpcError;

  const rows = (rpcRows ?? []) as SearchRpcRow[];
  if (rows.length === 0) return { items: [], total: 0, page, pageSize, totalPages: 1 };

  const total = rows[0].total_count ?? rows.length;
  const orderedIds = rows.map((r) => r.id);

  const { data: cardRows, error: cardError } = await supabase.from('resource_posts').select(CARD_COLUMNS).in('id', orderedIds);
  if (cardError) throw cardError;

  const cardsById = new Map(((cardRows ?? []) as unknown as RawCardRow[]).map((row) => [row.id, normalizeCard(row)]));
  const items = orderedIds.map((id) => cardsById.get(id)).filter((c): c is PublicResourceCard => !!c);

  return { items, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}
