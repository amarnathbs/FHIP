// R1.4 shared specialist-editor mutation primitive — spec §12/§104.
//
// Glossary and Money Update each add a small number of resource_posts
// columns beyond what R1.3's updateResourceDraft() writes (migration 0038:
// aliases; event_date/affected_audience). Rather than fork
// updateResourceDraft() (an approved, tested R1.3 file — spec §1: "Treat the
// following as approved and stable") or grow its fixed column list with
// content-type-specific fields it should never need to know about, every
// specialist save calls updateResourceDraft() first for the common fields,
// then this function once for its own extra columns.
//
// Non-atomicity note: this mirrors the exact accepted-risk shape R1.3's own
// mutations.ts already documents for content_blocks vs. taxonomy-link writes
// (see that file's header) — two sequential Supabase calls, not one
// transaction/RPC (spec §105: "Do not introduce a generic 'update anything'
// RPC"). If the first call succeeds and this one fails, the post's common
// fields are saved and correct; only the specialist columns may be stale
// until the next successful save. Never a security or constraint issue.

import type { SupabaseClient } from '@supabase/supabase-js';

// Deliberately does NOT touch `updated_at` — updateResourceDraft() (called
// immediately before this, in every caller) already bumped it once and
// returned that exact value to the caller as the save response's
// `post.updated_at`, which the editor UI then stores as its next
// optimistic-concurrency baseline (spec §57/§98). If this second call bumped
// `updated_at` again, the value the client just received would already be
// stale, and its very next save would be rejected as a false conflict.
// Leaving it untouched here keeps the single `updated_at` bump from step one
// as the one true "last saved" timestamp for the whole logical save.
export async function updateResourcePostExtraColumns(supabase: SupabaseClient, postId: string, columns: Record<string, unknown>): Promise<void> {
  if (Object.keys(columns).length === 0) return;
  const { error } = await supabase.from('resource_posts').update(columns).eq('id', postId);
  if (error) throw error;
}
