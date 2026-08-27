import { createClient } from '@/lib/supabase/server';

export function makeRegistry(table: string, opts?: { manualScopedUpsert?: boolean }) {
  // `investments` is the one table (migration 0042) where
  // unique(user_id, master_item_key) was relaxed to a PARTIAL unique index
  // scoped to `where source_type = 'manual'` — Investment Intelligence
  // publishes multiple non-manual rows that can legitimately share a
  // master_item_key, so the old table-wide constraint had to go. PostgREST's
  // upsert `onConflict` option only ever targets a plain column list — it
  // cannot express a WHERE-scoped index — so a plain onConflict upsert
  // against such a table 400s with Postgres error 42P10 ("no unique or
  // exclusion constraint matching the ON CONFLICT specification") for every
  // row, not just the ones a partial-index migration meant to affect. Pass
  // manualScopedUpsert: true for any registry table with this exact
  // partial-index shape to route save() through the manual select+
  // insert/update fallback below instead of a plain upsert.
  const manualScopedUpsert = opts?.manualScopedUpsert ?? false;
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
        if (manualScopedUpsert) {
          // No single atomic upsert can target the partial index, so resolve
          // it ourselves: find the existing MANUAL row for this
          // master_item_key (source_type filter means this can never match,
          // and therefore never silently overwrite, an
          // investment_intelligence_published row sharing the same key —
          // exactly the coexistence 0042 introduced the partial index to
          // allow) and update it in place; otherwise insert a new manual row.
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
              .update({ ...row, user_id: userId, is_active: true, source_type: 'manual' })
              .eq('id', existing.id)
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
