/**
 * Financial Data Hub — repository boundary.
 *
 * WHY A REPOSITORY LAYER AT ALL. The existing platform reaches Supabase
 * directly from `lib/services/**`, and `makeRegistry(table)` is the one
 * generic CRUD wrapper (lib/services/registry.ts). FDH keeps the same shape —
 * thin, typed, no ORM — but adds two properties the registry does not need:
 *
 *   1. Every query is scoped to one table from `FDH_TABLES`, so an FDH query
 *      cannot name an existing FHIP table by accident. This is enforced by the
 *      type, not by discipline.
 *   2. Every user-owned write injects `user_id` from the authenticated session
 *      and every read filters on it. RLS already guarantees isolation; this is
 *      defence in depth, and it means a query that somehow ran with the
 *      service-role client would still be scoped.
 *
 * DELIBERATELY ABSENT. There is no `adminClient()` / service-role usage
 * anywhere in this module. Product Owner Decision 3 forbids standing admin
 * access to user financial documents, and the simplest way to guarantee that
 * is for FDH to own no code path that can bypass RLS.
 * `tests/unit/fdh1Isolation.test.ts` greps the whole FDH tree and fails if a
 * service-role import ever appears.
 *
 * NO PREMATURE ABSTRACTION. These repositories do exactly what FDH-1 needs to
 * be a coherent module boundary: they do not implement query builders,
 * caching, unit-of-work or a generic specification pattern.
 */

import { createClient } from '@/lib/supabase/server';
import type { FdhMasterDataTable, FdhUserOwnedTable } from '../constants/tables';

/**
 * A repository over one user-owned FDH table.
 *
 * `TRow` is the domain interface for the table; `TInsert` is the validated
 * input shape (never carrying `user_id` — the repository supplies it).
 */
export function makeUserOwnedRepository<TRow, TInsert extends Record<string, unknown>>(
  table: FdhUserOwnedTable,
) {
  return {
    table,

    async listForUser(userId: string, limit = 200) {
      const supabase = await createClient();
      return supabase
        .from(table)
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limit)
        .returns<TRow[]>();
    },

    async getForUser(userId: string, id: string) {
      const supabase = await createClient();
      return supabase
        .from(table)
        .select('*')
        .eq('id', id)
        .eq('user_id', userId)
        .maybeSingle<TRow>();
    },

    /**
     * `user_id` is set from the session, never taken from the payload. Even if
     * a caller passed one it would be overwritten here, and RLS `with check`
     * would reject it at the database if it were not.
     */
    async create(userId: string, row: TInsert) {
      const supabase = await createClient();
      return supabase
        .from(table)
        .insert({ ...row, user_id: userId })
        .select()
        .single<TRow>();
    },

    async update(userId: string, id: string, patch: Partial<TInsert>) {
      const supabase = await createClient();
      // `user_id` is never patchable: re-parenting a row to another user is
      // exactly the tenant-spoofing move RLS `with check` exists to stop, and
      // it must not be reachable from application code either.
      const { user_id: _ignored, ...safePatch } = patch as Record<string, unknown>;
      void _ignored;
      return supabase
        .from(table)
        .update({ ...safePatch, updated_at: new Date().toISOString() })
        .eq('id', id)
        .eq('user_id', userId)
        .select()
        .single<TRow>();
    },

    async remove(userId: string, id: string) {
      const supabase = await createClient();
      return supabase.from(table).delete().eq('id', id).eq('user_id', userId);
    },
  };
}

/**
 * A read-only repository over one shared FDH master-data table.
 *
 * There is no write method here at all. Master-data writes are an
 * admin/service-role concern and belong to FDH-2/FDH-13; exposing a `create`
 * on this boundary would invite a future caller to reach for it from a user
 * request path.
 *
 * Applies only to master tables that have both a uuid `id` and an `active`
 * flag. Two do not — `fdh_source_types` (keyed on `source_type_key`) and
 * `fdh_parser_versions` (availability is a four-state `status`) — and they get
 * bespoke readers in `./index.ts` rather than being bent into this shape.
 */
export function makeMasterDataRepository<TRow>(table: FdhMasterDataTable) {
  return {
    table,

    async listActive(limit = 1000) {
      const supabase = await createClient();
      return supabase
        .from(table)
        .select('*')
        .eq('active', true)
        .limit(limit)
        .returns<TRow[]>();
    },

    async getById(id: string) {
      const supabase = await createClient();
      return supabase.from(table).select('*').eq('id', id).maybeSingle<TRow>();
    },
  };
}
