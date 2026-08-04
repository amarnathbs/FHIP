import { createClient } from '@/lib/supabase/server';

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
