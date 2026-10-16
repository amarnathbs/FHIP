// Resources Bulk Upload -- history view model. Server-only.
//
// The actor column shows "You" for the caller's own runs and a name for anyone else's (only Resource Admin and
// Super Admin can see other people's runs at all, by RLS). Names come from user_profiles in ONE batched read.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { HistoryRow } from '@/components/resources/import/ImportHistoryTable';
import type { RunRecord } from './staging';

export async function toHistoryRows(admin: SupabaseClient, runs: RunRecord[], currentUserId: string): Promise<HistoryRow[]> {
  const others = Array.from(new Set(runs.map((r) => r.uploaded_by).filter((u): u is string => !!u && u !== currentUserId)));
  const names = new Map<string, string>();
  if (others.length > 0) {
    const { data } = await admin.from('user_profiles').select('user_id, full_name').in('user_id', others);
    for (const p of (data ?? []) as { user_id: string; full_name: string | null }[]) if (p.full_name?.trim()) names.set(p.user_id, p.full_name.trim());
  }
  return runs.map((r) => ({
    id: r.id,
    content_type: r.content_type,
    file_name: r.file_name,
    status: r.status,
    row_count: r.row_count,
    valid_count: r.valid_count,
    error_count: r.error_count,
    created_post_count: r.created_post_count,
    created_at: r.created_at,
    actor_label: r.uploaded_by === currentUserId ? 'You' : r.uploaded_by ? (names.get(r.uploaded_by) ?? 'A Resources team member') : 'Former team member',
  }));
}
