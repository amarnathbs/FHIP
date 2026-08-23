/**
 * FDH-3 — repeatable schema-verification test, mirroring
 * tests/unit/fdh1SchemaContract.test.ts / fdh2SchemaContract.test.ts's
 * method: parse migration 0058 from disk and assert structural facts rather
 * than trust prose. The real against-a-database proof is
 * scripts/fdh3_rls_certification.mjs (PGlite) and, for real Storage,
 * scripts/fdh3_dev_certification.mjs (live DEV).
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  FDH_ALLOWED_UPLOAD_MIME_TYPES,
  FDH_DOCUMENT_AUDIT_ACTOR_TYPES,
  FDH_DOCUMENT_AUDIT_EVENT_TYPES,
  FDH_UPLOAD_SESSION_FAILURE_CODES,
  FDH_UPLOAD_SESSION_STATUSES,
} from '@/lib/financial-data-hub/constants/enums';
import {
  FDH3_SERVICE_ROLE_INSERT_ONLY_TABLES,
  FDH3_USER_OWNED_TABLES_ADDED,
} from '@/lib/financial-data-hub/constants/tables';

const MIGRATION_DIR = path.resolve(__dirname, '../../supabase/migrations');
const FILE = '0058_fdh3_document_lifecycle_upload_storage.sql';
const RAW = fs.readFileSync(path.join(MIGRATION_DIR, FILE), 'utf8');
const SQL = RAW.split('\n')
  .map((line) => {
    const i = line.indexOf('--');
    return i === -1 ? line : line.slice(0, i);
  })
  .join('\n');

function tableBody(table: string): string {
  const start = SQL.indexOf(`create table ${table} (`);
  expect(start, `create table ${table} not found`).toBeGreaterThan(-1);
  const end = SQL.indexOf('\n);', start);
  expect(end, `unterminated create table ${table}`).toBeGreaterThan(start);
  return SQL.slice(start, end);
}

function checkValues(body: string, column: string): string[] {
  const columnIndex = body.indexOf(`\n  ${column} `);
  expect(columnIndex, `column ${column} not found`).toBeGreaterThan(-1);
  const slice = body.slice(columnIndex);
  const match = slice.match(/in \(([^)]*)\)/);
  expect(match, `no check(... in (...)) on ${column}`).not.toBeNull();
  return [...match![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe('FDH-3 migration 0058 exists and creates exactly the declared tables', () => {
  it('the file exists', () => {
    expect(fs.existsSync(path.join(MIGRATION_DIR, FILE))).toBe(true);
  });

  it('creates fdh_upload_sessions and fdh_document_audit_events, and nothing else new', () => {
    const created = [...SQL.matchAll(/create table (?:if not exists )?([a-z_]+)/g)].map((m) => m[1]);
    expect(created.sort()).toEqual([...FDH3_USER_OWNED_TABLES_ADDED, ...FDH3_SERVICE_ROLE_INSERT_ONLY_TABLES].sort());
  });

  it('is purely additive to fdh_statement_uploads — no drop table, no drop column, no delete, no destructive update', () => {
    expect(/drop table/i.test(SQL)).toBe(false);
    expect(/drop column/i.test(SQL)).toBe(false);
    expect(/delete from/i.test(SQL)).toBe(false);
    // The one sanctioned exception: dropping the FDH-1 hard-uniqueness INDEX
    // (not a table, not a column) in favour of a soft duplicate pointer —
    // see the migration's own "DUPLICATE DETECTION" comment.
    const drops = [...SQL.matchAll(/drop (\w+)/gi)].map((m) => m[1].toLowerCase());
    for (const d of drops) expect(['index', 'constraint']).toContain(d);
  });
});

describe('FDH-3 check constraints match the TypeScript vocabularies', () => {
  it('fdh_upload_sessions.upload_status', () => {
    expect(checkValues(tableBody('fdh_upload_sessions'), 'upload_status').sort()).toEqual(
      [...FDH_UPLOAD_SESSION_STATUSES].sort(),
    );
  });

  it('fdh_upload_sessions.allowed_mime_type', () => {
    expect(checkValues(tableBody('fdh_upload_sessions'), 'allowed_mime_type').sort()).toEqual(
      [...FDH_ALLOWED_UPLOAD_MIME_TYPES].sort(),
    );
  });

  it('fdh_upload_sessions.failure_code', () => {
    expect(checkValues(tableBody('fdh_upload_sessions'), 'failure_code').sort()).toEqual(
      [...FDH_UPLOAD_SESSION_FAILURE_CODES].sort(),
    );
  });

  it('fdh_document_audit_events.event_type', () => {
    expect(checkValues(tableBody('fdh_document_audit_events'), 'event_type').sort()).toEqual(
      [...FDH_DOCUMENT_AUDIT_EVENT_TYPES].sort(),
    );
  });

  it('fdh_document_audit_events.actor_type', () => {
    expect(checkValues(tableBody('fdh_document_audit_events'), 'actor_type').sort()).toEqual(
      [...FDH_DOCUMENT_AUDIT_ACTOR_TYPES].sort(),
    );
  });
});

describe('FDH-3 RLS is enabled with an owner-scoped policy on both new tables', () => {
  it('fdh_upload_sessions: RLS enabled, owner-scoped for-all policy', () => {
    expect(/alter table fdh_upload_sessions enable row level security/.test(SQL)).toBe(true);
    expect(/create policy "own rows - fdh_upload_sessions" on fdh_upload_sessions\s+for all using \(auth\.uid\(\) = user_id\) with check \(auth\.uid\(\) = user_id\)/.test(SQL)).toBe(true);
  });

  it('fdh_document_audit_events: RLS enabled, owner READ-ONLY (no insert/update/delete policy)', () => {
    expect(/alter table fdh_document_audit_events enable row level security/.test(SQL)).toBe(true);
    expect(/create policy "read own fdh_document_audit_events" on fdh_document_audit_events\s+for select using \(auth\.uid\(\) = user_id\)/.test(SQL)).toBe(true);
    // Only ONE policy exists on this table — a select-only policy, no "for all".
    const policyCount = [...SQL.matchAll(/create policy [^\n]*on fdh_document_audit_events/g)].length;
    expect(policyCount).toBe(1);
  });
});

describe('FDH-3 storage: private bucket policy, SELECT only, no public/broad access', () => {
  it('defines a storage.objects SELECT policy scoped to the owner folder', () => {
    expect(/create policy "own fdh source document objects" on storage\.objects/.test(SQL)).toBe(true);
    expect(/bucket_id = 'fdh-source-documents'/.test(SQL)).toBe(true);
    expect(/\(storage\.foldername\(name\)\)\[1\] = auth\.uid\(\)::text/.test(SQL)).toBe(true);
  });

  it('grants no insert, update or delete storage policy to the authenticated role', () => {
    const storagePolicies = [...SQL.matchAll(/create policy "[^"]*" on storage\.objects\s+for (\w+)/g)].map((m) => m[1]);
    expect(storagePolicies).toEqual(['select']);
  });

  it('never marks the bucket public and never grants "using (true)" on storage.objects', () => {
    expect(/public\s*=\s*true/i.test(SQL)).toBe(false);
    expect(/on storage\.objects[\s\S]{0,80}using \(true\)/.test(SQL)).toBe(false);
  });
});

describe('FDH-3 FDH1-F1 focused hardening: tenant-referential-integrity triggers', () => {
  it('defines an owner-assertion trigger on fdh_upload_sessions', () => {
    expect(/create trigger trg_fdh_upload_sessions_owner/.test(SQL)).toBe(true);
    expect(/before insert or update of user_id, document_id on fdh_upload_sessions/.test(SQL)).toBe(true);
  });

  it('defines an owner-assertion trigger on fdh_ingestion_jobs (an existing FDH-1 table FDH-3 newly exercises)', () => {
    expect(/create trigger trg_fdh_ingestion_jobs_owner/.test(SQL)).toBe(true);
    expect(/before insert or update of user_id, statement_upload_id on fdh_ingestion_jobs/.test(SQL)).toBe(true);
  });

  it('both trigger functions actually compare owner user_id, not just check existence', () => {
    expect(/doc_owner <> new\.user_id/.test(SQL)).toBe(true);
    expect(/cross-tenant reference/.test(SQL)).toBe(true);
  });
});

describe('FDH-3 duplicate-detection widening (spec section 21 — soft flag, not a hard block)', () => {
  it('drops the FDH-1 hard uniqueness index on (user_id, file_hash)', () => {
    expect(/drop index if exists uq_fdh_uploads_user_file_hash/.test(SQL)).toBe(true);
  });

  it('adds a non-unique lookup index and a self-referencing duplicate pointer column', () => {
    expect(/create index idx_fdh_uploads_user_file_hash on fdh_statement_uploads\(user_id, file_hash\)/.test(SQL)).toBe(true);
    expect(/add column duplicate_of_document_id uuid references fdh_statement_uploads\(id\)/.test(SQL)).toBe(true);
    expect(/duplicate_of_document_id <> id/.test(SQL)).toBe(true);
  });
});
