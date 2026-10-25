// Document2 (4) WP-H2 -- the READ-ONLY scan-state pack against the real schema (migration ledger replayed into PGlite).
// EVIDENCE LABEL: PGLITE-VERIFIED. Not DEV-verified, not production-verified.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replayAll } from './support/promoTestHelpers';
import { hazards } from './support/sqlEditorHazards';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sql = fs.readFileSync(path.resolve(HERE, '..', '..', 'docs', 'reviews', 'po_apply_wp_h2', '01_READ_ONLY_scan_state_and_refusals.sql'), 'utf8');

describe('pack file', () => {
  it('is editor-safe and contains no data-changing statement', () => {
    expect(hazards(sql)).toEqual([]);
    const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').toLowerCase();
    for (const word of ['insert ', 'update ', 'delete ', 'drop ', 'alter ', 'truncate ', 'create ', 'grant ', 'revoke ']) expect(code).not.toContain(word);
  });
});

describe('against the real schema', () => {
  let db: PGlite;
  const U = '00000000-0000-4000-8000-0000000000d1';
  beforeAll(async () => {
    db = new PGlite();
    await replayAll(db);
    await db.exec(`set session_replication_role = replica`);
    await db.query(`insert into auth.users (id, email) values ($1, 'scan@example.test')`, [U]);
    const doc = (n: number, status: string, detail: string | null, ageDays: number) =>
      db.query(
        `insert into ii_source_documents (id, user_id, country_code, status, storage_path, original_filename, mime_type, file_size, checksum, malware_scan_status, malware_scan_object_ref, uploaded_at)
         values ($1, $2, 'IN', 'uploaded', 'p', 'secret-name.pdf', 'application/pdf', 1, $3, $4, $5, now() - ($6 || ' days')::interval)`,
        [`30000000-0000-4000-8000-${String(n).padStart(12, '0')}`, U, `c${n}`, status, detail === null ? null : JSON.stringify({ detail }), String(ageDays)],
      );
    await doc(1, 'suspicious', 'UNSUPPORTED: SKIPPED', 1);
    await doc(2, 'suspicious', 'UNSUPPORTED: SKIPPED', 2);
    await doc(3, 'clean', null, 3);
    await doc(4, 'suspicious', 'UNSUPPORTED: old', 40); // outside the 14 day window
    await db.query(`insert into ii_audit_events (user_id, event_type, subject_type, subject_id, actor_type, metadata) values ($1, 'document_processing_failed', 'ii_source_documents', $2, 'system', $3)`, [U, '30000000-0000-4000-8000-000000000001', JSON.stringify({ reason: 'malware_scan_refused', outcome: 'blocked', refusal: 'unsupported', scanStatus: 'suspicious' })]);
    await db.query(`insert into ii_audit_events (user_id, event_type, subject_type, subject_id, actor_type, metadata) values ($1, 'document_processing_failed', 'ii_source_documents', $2, 'system', $3)`, [U, '30000000-0000-4000-8000-000000000001', JSON.stringify({ reason: 'something_else' })]);
  }, 600_000);
  afterAll(async () => {
    await db?.close();
  });

  it('groups the last 14 days by recorded status and detail kind, and returns refusal reason codes only', async () => {
    const [byState, refusals] = (await db.exec(sql)) as { rows: Record<string, unknown>[] }[];
    const unsupported = byState.rows.find((r) => r.scan_status === 'suspicious');
    expect(unsupported).toMatchObject({ detail_kind: 'UNSUPPORTED' });
    expect(Number(unsupported?.statements)).toBe(2); // the 40 day old one is outside the window
    expect(Number(byState.rows.find((r) => r.scan_status === 'clean')?.statements)).toBe(1);
    expect(refusals.rows).toHaveLength(1);
    expect(refusals.rows[0]).toMatchObject({ outcome: 'blocked', refusal_code: 'unsupported', stored_scan_status: 'suspicious' });
    expect(JSON.stringify([byState.rows, refusals.rows])).not.toContain('secret-name');
  });
  it('is read only', async () => {
    const n = async () => Number((await db.query<{ n: string }>(`select (select count(*) from ii_source_documents) + (select count(*) from ii_audit_events) as n`)).rows[0].n);
    const before = await n();
    await db.exec(sql);
    expect(await n()).toBe(before);
  });
});
