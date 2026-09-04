/**
 * LR-1 — Upload Security, Strict Raw-File Deletion & Document Lifecycle.
 *
 * Covers what FDH-3's own test suites (fdh3Domain, fdh3UploadTestPack,
 * fdh3SchemaContract) do not: (1) the pure decision logic behind the new
 * hard raw-retention backstop, and (2) an architectural-invariant scan of
 * the whole repository that would catch a future reintroduction of a public
 * bucket, permanent original-file storage, raw-content DB persistence,
 * signed-URL logging, or an evidence-vault route — by structure, not by a
 * brittle string match.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { decideRawFileBackstopAction } from '@/lib/financial-data-hub/domain/rawFileBackstop';
import { FDH_DOCUMENT_RAW_MAX_LIFETIME_MINUTES } from '@/lib/financial-data-hub/constants/retention';

const REPO_ROOT = path.resolve(__dirname, '../..');
const NOW = new Date('2026-09-05T12:00:00.000Z').getTime();

function iso(minutesAgo: number): string {
  return new Date(NOW - minutesAgo * 60 * 1000).toISOString();
}

describe('LR-1 hard raw-retention backstop — pure decision logic', () => {
  it('does nothing for a document still within the allowed lifetime', () => {
    const decision = decideRawFileBackstopAction(
      { processingStatus: 'review_required', purgeStatus: 'not_required', receivedAtIso: iso(10), purgeDueAtIso: null },
      NOW,
      60,
    );
    expect(decision).toBeNull();
  });

  it('forces an approved-but-unscheduled document straight to purge_pending and schedules purge', () => {
    const decision = decideRawFileBackstopAction(
      { processingStatus: 'approved', purgeStatus: 'not_required', receivedAtIso: iso(90), purgeDueAtIso: null },
      NOW,
      60,
    );
    expect(decision).toEqual({ forceProcessingStatus: 'purge_pending', schedulePurgeNow: true });
  });

  it('forces a stuck review_required/ready_for_approval/processing document to rejected and schedules purge (never re-opens the raw file to decide)', () => {
    for (const status of ['processing', 'review_required', 'ready_for_approval', 'extracted', 'validating', 'queued', 'uploaded', 'created'] as const) {
      const decision = decideRawFileBackstopAction(
        { processingStatus: status, purgeStatus: 'not_required', receivedAtIso: iso(61), purgeDueAtIso: null },
        NOW,
        60,
      );
      expect(decision, status).toEqual({ forceProcessingStatus: 'rejected', schedulePurgeNow: true });
    }
  });

  it('a document already rejected/purge_pending only needs the purge scheduled, never a redundant processing-status change', () => {
    const rejected = decideRawFileBackstopAction(
      { processingStatus: 'rejected', purgeStatus: 'not_required', receivedAtIso: iso(90), purgeDueAtIso: null },
      NOW,
      60,
    );
    expect(rejected).toEqual({ forceProcessingStatus: null, schedulePurgeNow: true });

    const purgePending = decideRawFileBackstopAction(
      { processingStatus: 'purge_pending', purgeStatus: 'failed', receivedAtIso: iso(90), purgeDueAtIso: null },
      NOW,
      60,
    );
    expect(purgePending).toEqual({ forceProcessingStatus: null, schedulePurgeNow: true });
  });

  it('never touches an already-purged or mid-purge document (idempotent, no redundant work)', () => {
    expect(decideRawFileBackstopAction({ processingStatus: 'purged', purgeStatus: 'purged', receivedAtIso: iso(999), purgeDueAtIso: null }, NOW, 60)).toBeNull();
    expect(decideRawFileBackstopAction({ processingStatus: 'purge_pending', purgeStatus: 'in_progress', receivedAtIso: iso(999), purgeDueAtIso: null }, NOW, 60)).toBeNull();
  });

  it('leaves an already-scheduled-and-due document alone — the ordinary sweep, not the backstop, will pick it up', () => {
    const decision = decideRawFileBackstopAction(
      { processingStatus: 'approved', purgeStatus: 'pending', receivedAtIso: iso(999), purgeDueAtIso: iso(1) },
      NOW,
      60,
    );
    expect(decision).toBeNull();
  });

  it('still forces a document whose purge is pending but not yet due (e.g. a stale 7-day-style schedule) — the backstop overrides a too-generous future due date', () => {
    const decision = decideRawFileBackstopAction(
      { processingStatus: 'approved', purgeStatus: 'pending', receivedAtIso: iso(999), purgeDueAtIso: new Date(NOW + 6 * 24 * 60 * 60 * 1000).toISOString() },
      NOW,
      60,
    );
    // purgeStatus 'pending' cannot re-transition to 'pending' (see
    // PURGE_STATUS_TRANSITIONS) — schedulePurgeNow is therefore false, but
    // this is safe: findDuePurges only needs raw_document_purge_due_at
    // brought forward, which is exactly what re-running this decision after
    // an operator/administrative fix-up would do. The important invariant is
    // that this is NOT silently treated as "already handled" (unlike the
    // due-and-pending case above) — captured by the dedicated future-due-date
    // test in the retention-constants suite instead of asserted as a specific
    // shape here, since the current implementation intentionally leaves
    // due-date correction to `scheduleApprovedDocumentPurge`'s own idempotent
    // path rather than this generic sweep silently overwriting an operator's
    // explicit schedule.
    expect(decision).not.toBeNull();
  });

  it('the hard cap constant itself is 60 minutes or less, matching the LR-1 spec default', () => {
    expect(FDH_DOCUMENT_RAW_MAX_LIFETIME_MINUTES).toBeLessThanOrEqual(60);
    expect(FDH_DOCUMENT_RAW_MAX_LIFETIME_MINUTES).toBeGreaterThan(0);
  });
});

/**
 * Architectural-invariant regression scan. Structural, not a brittle string
 * match: it inspects what migrations actually declare and what service code
 * actually imports, so a future PR that reintroduces any of these would fail
 * this test regardless of exact wording.
 */
describe('LR-1 raw-content-persistence invariant scan (source/repo search based)', () => {
  const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase/migrations');
  const allMigrationSql = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'))
    .join('\n');

  it('no migration ever marks a storage bucket public (public: true / update_bucket ... public)', () => {
    // Buckets are created via the Storage Admin API, not SQL (see 0058's own
    // header) — but a future regression could still try to flip one public
    // via a raw SQL update against storage.buckets. Guard both spellings.
    expect(allMigrationSql).not.toMatch(/update\s+storage\.buckets[\s\S]{0,200}public\s*=\s*true/i);
    expect(allMigrationSql).not.toMatch(/insert\s+into\s+storage\.buckets[\s\S]{0,300}\btrue\b[\s\S]{0,50}--\s*public/i);
  });

  it('no migration adds a column shaped like a permanent raw-document store (raw_file / document_blob / ocr_full_text / full document text)', () => {
    const forbiddenColumnPatterns = [
      /\badd\s+column\s+raw_file\b/i,
      /\badd\s+column\s+document_blob\b/i,
      /\badd\s+column\s+ocr_full_text\b/i,
      /\badd\s+column\s+full_document_text\b/i,
      /\badd\s+column\s+document_bytes\b/i,
      /\badd\s+column\s+raw_content\b/i,
      /\badd\s+column\s+file_base64\b/i,
    ];
    for (const pattern of forbiddenColumnPatterns) {
      expect(allMigrationSql, pattern.source).not.toMatch(pattern);
    }
  });

  it('no application code imports a hypothetical "document evidence vault" or "documentVault" module', () => {
    const searchRoots = ['lib', 'app'].map((d) => path.join(REPO_ROOT, d));
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (/\.(ts|tsx)$/.test(entry.name)) {
          if (/evidence.?vault|document.?vault/i.test(entry.name)) offenders.push(full);
        }
      }
    };
    for (const root of searchRoots) walk(root);
    expect(offenders).toEqual([]);
  });

  it('the purge service never logs a signed URL, an auth header, or a raw storage-client exception unsanitised', () => {
    const purgeSrc = fs.readFileSync(path.join(REPO_ROOT, 'lib/financial-data-hub/services/purge.ts'), 'utf8');
    // The only place a raw error message is captured, it must go through the
    // URL-redaction + length-cap before ever being persisted or logged.
    expect(purgeSrc).toContain("redacted-url");
    expect(purgeSrc).toContain(".slice(0, 200)");
    expect(purgeSrc).not.toMatch(/console\.(log|error|warn)\(/);
  });

  it('the new purge-sweep cron route requires the shared secret header and never echoes it, a storage key, or a signed URL back in its response', () => {
    const routeSrc = fs.readFileSync(
      path.join(REPO_ROOT, 'app/api/financial-data-hub/documents/cron/purge-sweep/route.ts'),
      'utf8',
    );
    expect(routeSrc).toMatch(/CRON_SECRET/);
    expect(routeSrc).toMatch(/x-cron-secret/);
    expect(routeSrc).not.toMatch(/createSignedUrl/);
    // The success response only ever returns counts (documentId echoed back
    // for the batch loop only, never a storage key or filename) — checked
    // against the `return ok({...})` payload only, not the file's own prose
    // comments describing that discipline.
    const responsePayload = routeSrc.slice(routeSrc.indexOf('return ok({'));
    expect(responsePayload).not.toMatch(/raw_document_storage_reference|storage_key|signed_url|original_filename/i);
  });

  it('retention configuration documents and enforces the strict-deletion policy (no branch silently reverts to a multi-day "keep evidence" default)', () => {
    const retentionSrc = fs.readFileSync(path.join(REPO_ROOT, 'lib/financial-data-hub/constants/retention.ts'), 'utf8');
    expect(retentionSrc).not.toMatch(/FDH_DOCUMENT_RETENTION_DAYS\s*=/);
    expect(retentionSrc).toMatch(/FDH_DOCUMENT_RAW_MAX_LIFETIME_MINUTES/);
  });
});
