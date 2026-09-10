import { createClient } from '@/lib/supabase/server';

// Tables whose (user_id, master_item_key) uniqueness is enforced by a
// PARTIAL index scoped to source_type = 'manual' (migration 0042's II-R3
// FHIP publishing bridge -- lets a manual row and an Investment-
// Intelligence-published row coexist under the same master_item_key
// without colliding), rather than a plain table-wide unique constraint.
// PostgREST's upsert `on_conflict` parameter has no way to express a
// partial index's WHERE predicate -- Postgres only matches an ON CONFLICT
// target against a partial index when the statement itself repeats that
// exact predicate, which a generic REST upsert call can't do -- so a native
// upsert against these tables fails 100% of the time with 42P10 ("no
// unique or exclusion constraint matching the ON CONFLICT specification").
// Confirmed live 2026-09-10 during LR-2 certification: every attempt to
// add a catalogue-item Investment failed with exactly this error. `assets`
// and `retirement_accounts` got the same new source_type column in the
// same migration but deliberately KEPT their original table-wide
// constraint (that migration's own §3 comment: "No R3 production write
// path targets these tables' new columns") -- only `investments` is
// affected. See docs/live-recovery/LR2_INVESTMENTS_UPSERT_PARTIAL_INDEX_FIX.md.
const PARTIAL_MASTER_KEY_INDEX_TABLES = new Set(['investments']);

export function makeRegistry(table: string) {
  return {
    async list(userId: string) {
      const supabase = await createClient();
      return supabase
        .from(table)
        .select('*')
        .eq('user_id', userId)
        .eq('is_active', true)
        .order('created_at', { ascending: false });
    },
    async create(userId: string, row: Record<string, unknown>) {
      const supabase = await createClient();
      return supabase
        .from(table)
        .insert({ ...row, user_id: userId })
        .select()
        .single();
    },
    // Grid rows tied to a master item are saved via upsert keyed on
    // (user_id, master_item_key): re-checking a previously unchecked/archived
    // master row resurrects it instead of creating a duplicate. Custom rows
    // (master_item_key omitted) always insert — Postgres never matches NULL
    // to NULL, so the unique constraint can't collide them.
    async save(userId: string, row: Record<string, unknown>) {
      const supabase = await createClient();
      if (row.master_item_key) {
        if (PARTIAL_MASTER_KEY_INDEX_TABLES.has(table)) {
          // Mirror the partial index's own scope (source_type='manual')
          // explicitly, since a native upsert can't target it — see this
          // file's own header comment for the full defect this fixes.
          const { data: existing, error: findError } = await supabase
            .from(table)
            .select('id')
            .eq('user_id', userId)
            .eq('master_item_key', row.master_item_key as string)
            .eq('source_type', 'manual')
            .maybeSingle();
          if (findError) return { data: null, error: findError };
          if (existing) {
            return supabase
              .from(table)
              .update({ ...row, is_active: true, updated_at: new Date().toISOString() })
              .eq('id', existing.id)
              .eq('user_id', userId)
              .select()
              .single();
          }
          return supabase
            .from(table)
            .insert({ ...row, user_id: userId, is_active: true, source_type: 'manual' })
            .select()
            .single();
        }
        return supabase
          .from(table)
          .upsert({ ...row, user_id: userId, is_active: true }, { onConflict: 'user_id,master_item_key' })
          .select()
          .single();
      }
      return supabase
        .from(table)
        .insert({ ...row, user_id: userId })
        .select()
        .single();
    },
    async update(userId: string, id: string, patch: Record<string, unknown>) {
      const supabase = await createClient();
      return supabase
        .from(table)
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', id)
        .eq('user_id', userId)
        .select()
        .single();
    },
    async archive(userId: string, id: string) {
      const supabase = await createClient();
      return supabase.from(table).update({ is_active: false }).eq('id', id).eq('user_id', userId).select().single();
    },
  };
}
