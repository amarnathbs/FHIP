/**
 * A tiny in-memory Supabase stand-in for the Premium Upload Entitlement route tests.
 *
 * It answers `from(table).select(...).eq(col, val)...maybeSingle()/single()` from a per-table row list, answers the
 * `user_entitlements` read from a configurable row (or a configurable read ERROR, to prove fail-closed), and RECORDS
 * every read table and every write (insert / update / upsert / delete / rpc / storage upload) so a test can assert that
 * a refused request caused none of them.
 */

export type Row = Record<string, unknown>;

export interface FakeState {
  /** The caller's own entitlement row; `null` = no row. */
  entitlement: Row | null;
  /** When set, the entitlement read fails with this message (an outage). */
  entitlementError: string | null;
  /** Rows by table, for position lookups (fdh_statement_uploads, ii_source_documents, aie_document_intake...). */
  tables: Record<string, Row[]>;
  readTables: string[];
  writes: string[];
}

export function newFakeState(): FakeState {
  return { entitlement: null, entitlementError: null, tables: {}, readTables: [], writes: [] };
}

export function makeFakeSupabase(state: FakeState) {
  function from(table: string) {
    state.readTables.push(table);
    let rows: Row[] = table === 'user_entitlements' ? (state.entitlement ? [state.entitlement] : []) : [...(state.tables[table] ?? [])];
    const builder = {
      select() {
        return builder;
      },
      eq(col: string, val: unknown) {
        if (table !== 'user_entitlements') rows = rows.filter((r) => r[col] === val);
        return builder;
      },
      in() {
        return builder;
      },
      order() {
        return builder;
      },
      limit() {
        return builder;
      },
      maybeSingle: async () => {
        if (table === 'user_entitlements' && state.entitlementError) return { data: null, error: { message: state.entitlementError } };
        return { data: rows[0] ?? null, error: null };
      },
      single: async () => ({ data: rows[0] ?? null, error: rows[0] ? null : { message: 'no rows' } }),
      then(resolve: (v: { data: Row[]; error: null }) => unknown) {
        return Promise.resolve({ data: rows, error: null }).then(resolve);
      },
      insert() {
        state.writes.push(`insert:${table}`);
        return builder;
      },
      update() {
        state.writes.push(`update:${table}`);
        return builder;
      },
      upsert() {
        state.writes.push(`upsert:${table}`);
        return builder;
      },
      delete() {
        state.writes.push(`delete:${table}`);
        return builder;
      },
    };
    return builder;
  }
  return {
    from,
    rpc: async (name: string) => {
      state.writes.push(`rpc:${name}`);
      return { data: null, error: null };
    },
    storage: {
      from: () => ({
        upload: async () => {
          state.writes.push('storage:upload');
          return { data: null, error: null };
        },
        createSignedUploadUrl: async () => {
          state.writes.push('storage:signed_upload');
          return { data: null, error: null };
        },
        createSignedUrl: async () => ({ data: { signedUrl: 'https://example.test/x' }, error: null }),
      }),
    },
    auth: { getUser: async () => ({ data: { user: { id: 'u-test' } }, error: null }) },
  };
}
