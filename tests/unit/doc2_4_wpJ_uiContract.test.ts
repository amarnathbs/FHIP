/**
 * Document2 (4) WP-J -- UI wiring contract of the screens that follow a statement job (UNIT-TESTED against the source; this repository's unit
 * baseline has no DOM, so the behaviour of the loop itself is covered by the pure driver tests in doc2_4_wpJ_unit.test.ts, and the screens'
 * click-through is NOT PERFORMED here).
 *
 * What is pinned:
 *   - Statements & data follows the job the process request admitted (202), resumes unfinished jobs after a reload, shows progress, and
 *     groups the list: statements needing action prominently, everything else under "Processed statements (N)" with Upload replacement copy
 *     still reachable there,
 *   - the replacement control no longer waits on one long request: it follows the reprocess job and says honestly where it is,
 *   - the Review centre follows the reprocess started by a resolution,
 *   - the password is held in memory only: never in storage, a URL or a log, and sent only while the job is at the step that opens the file.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const client = read('components/investment-intelligence/InvestmentIntelligenceClient.tsx');
const follower = read('components/investment-intelligence/StatementJobFollower.tsx');
const replacement = read('components/investment-intelligence/ReplacementCopyControl.tsx');
const review = read('components/investment-intelligence/ReviewCentreClient.tsx');
const driver = read('components/investment-intelligence/statementJobDriver.ts');

describe('Statements & data follows the job', () => {
  it('a 202 from the process request starts following the job instead of waiting for an answer that may never come', () => {
    expect(client).toMatch(/res\.status === 202 && json\?\.data\?\.job_id/);
    expect(client).toContain('<StatementJobFollower');
    expect(client).toContain('data-testid="statement-job-follower"');
  });

  it('unfinished jobs are read again on load, so a reload mid-job does not restart or abandon the work', () => {
    expect(client).toContain("fetch('/api/investment-intelligence/statement-jobs')");
    expect(client).toMatch(/status === 'queued' \|\| j\.status === 'processing'/);
  });

  it('Re-evaluate all positions is a followed job too, and its end is reported in plain words', () => {
    expect(client).toMatch(/kind: 'reevaluate'/);
    expect(client).toContain('Re-evaluated ${e?.evaluated ?? 0} position');
  });

  it('the list shows only statements that need action; everything else is one quiet disclosure with the count, and Upload replacement copy stays reachable in it', () => {
    expect(client).toContain('partitionSourceDocumentsByProcessedState(documents ?? [], new Set(Object.keys(followed)))');
    expect(client).toMatch(/Processed statements \(\{previouslyProcessedDocuments\.length\}\)/);
    // the SAME row renderer draws both lists, and that renderer holds the replacement control
    expect((client.match(/\.map\(\(doc\) => renderDocumentRow\(doc\)\)/g) ?? []).length).toBe(2);
    const row = client.slice(client.indexOf('function renderDocumentRow'), client.indexOf('const { active: activeDocuments'));
    expect(row).toContain('Upload replacement copy');
    expect(row).toContain('<ReplacementCopyControl');
    expect(row).toMatch(/ready to publish/);
  });
});

describe('the replacement copy control follows the reprocess job', () => {
  it('no longer shows a spinner for the whole processing; it follows the job', () => {
    expect(replacement).toContain('<StatementJobFollower');
    expect(replacement).toMatch(/res\.status === 202 && body\?\.data\?\.job_id/);
    expect(replacement).not.toContain('Uploading and processing…');
  });
});

describe('the Review centre follows the reprocess a resolution started', () => {
  it('shows the job and refreshes the list when it ends', () => {
    expect(review).toContain('json.data?.reprocessJobId');
    expect(review).toContain('data-testid="review-reprocess-job"');
    expect(review).toMatch(/onFinished=\{async \(\) => \{[\s\S]{0,200}review\/refresh/);
  });
});

describe('the follower is honest and never leaves a bare spinner', () => {
  it('always renders a status line (queued, working with a bar, or the plain end message)', () => {
    expect(follower).toContain('role="status"');
    expect(follower).toContain('Queued. Starting in a moment. You can leave this page; it continues.');
    expect(follower).toContain('data-testid="statement-job-ended"');
  });
});

describe('the password is held in memory only', () => {
  it('is never put in storage, a URL, a cookie or a log by any of the screens or the driver', () => {
    for (const [name, src] of [['follower', follower], ['replacement', replacement], ['driver', driver]] as const) {
      expect(src, name).not.toMatch(/localStorage|sessionStorage|document\.cookie|indexedDB/);
      expect(src, name).not.toMatch(/console\.(log|info|warn|error)\([^)]*password/i);
    }
    expect(follower).not.toMatch(/\?password=|&password=|searchParams/);
  });

  it('travels in the request body only, and only for the slice that opens the file', () => {
    expect(follower).toContain("body: JSON.stringify(password ? { password } : {})");
    expect(follower).toContain('advanceOverHttp(id, o.sendPassword ? passwordRef.current : undefined)');
    expect(driver).toContain('sendPassword: last ? last.password_step : true');
  });

  it('is dropped as soon as the job leaves that step and when it ends', () => {
    expect(client).toMatch(/if \(!v\.password_step && followed\[doc\.id\]\?\.password\)/);
    expect(client).toMatch(/setPasswordInputs\(\(prev\) => \(\{ \.\.\.prev, \[documentId\]: '' \}\)\)/);
    expect(replacement).toMatch(/if \(!v\.password_step && job\.password\)/);
  });
});
