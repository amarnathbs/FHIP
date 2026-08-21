// R1.7D-FINAL §48 — idempotency proof. Captures the exact DB-side facts the
// spec asks about (content changes, updated_at churn, new revisions, new
// audit rows, duplicate related links) around a second loader run.
import { writeFileSync, readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { assertDevProject } from '../lib/env';
import { EXPECTED_84 } from './r17d-expected84';
import { reviewContentHash } from './r17d-final-snapshot';

async function capture() {
  const creds = assertDevProject();
  const svc = createClient(creds.url, creds.serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: posts } = await svc.from('resource_posts').select('*').in('content_id', EXPECTED_84);
  const ids = (posts ?? []).map((p) => p.id as string);
  const { count: versions } = await svc.from('resource_post_versions').select('*', { count: 'exact', head: true }).in('post_id', ids);
  const { count: audit } = await svc.from('resource_audit_log').select('*', { count: 'exact', head: true }).eq('entity_type', 'resource_post').in('entity_id', ids);
  const { count: related } = await svc.from('resource_related_content').select('*', { count: 'exact', head: true });
  const { data: rel } = await svc.from('resource_related_content').select('source_post_id,related_post_id,relationship_type');
  const dupKeys = (rel ?? []).map((r) => `${r.source_post_id}|${r.related_post_id}|${r.relationship_type}`);
  return {
    content_hashes: Object.fromEntries((posts ?? []).sort((a, b) => String(a.content_id).localeCompare(String(b.content_id))).map((p) => [p.content_id as string, reviewContentHash(p as never)])),
    updated_at: Object.fromEntries((posts ?? []).map((p) => [p.content_id as string, p.updated_at as string])),
    revision_count: versions ?? 0,
    audit_count: audit ?? 0,
    related_count: related ?? 0,
    duplicate_related_links: dupKeys.length - new Set(dupKeys).size,
  };
}

async function main() {
  const label = process.argv[2] ?? 'before';
  const snap = await capture();
  writeFileSync(`artifacts/resources/r1-7d/idempotency-${label}.json`, JSON.stringify(snap, null, 2));
  console.log(`[idempotency:${label}] revisions=${snap.revision_count} audit=${snap.audit_count} related=${snap.related_count} dup_related=${snap.duplicate_related_links}`);

  if (label === 'after') {
    const before = JSON.parse(readFileSync('artifacts/resources/r1-7d/idempotency-before.json', 'utf8'));
    const hashDrift = Object.keys(snap.content_hashes).filter((k) => snap.content_hashes[k] !== before.content_hashes[k]);
    const tsDrift = Object.keys(snap.updated_at).filter((k) => snap.updated_at[k] !== before.updated_at[k]);
    const result = {
      content_changes: hashDrift.length,
      content_changed_ids: hashDrift,
      updated_at_churn: tsDrift.length,
      updated_at_churn_ids: tsDrift,
      new_revisions: snap.revision_count - before.revision_count,
      new_audit_rows: snap.audit_count - before.audit_count,
      new_related_links: snap.related_count - before.related_count,
      duplicate_related_links: snap.duplicate_related_links,
    };
    writeFileSync('artifacts/resources/r1-7d/idempotency-result.json', JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    const clean = result.content_changes === 0 && result.updated_at_churn === 0 && result.new_revisions === 0 && result.new_audit_rows === 0 && result.new_related_links === 0 && result.duplicate_related_links === 0;
    console.log(clean ? 'IDEMPOTENCY PASS' : 'IDEMPOTENCY FAIL');
    if (!clean) process.exit(2);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
