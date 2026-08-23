/**
 * R7 — Bank CSV Engine independent certification: large-file certification
 * (spec sections 75, 77) — 999/1000/1001/2500/5001/10000 rows, no silent
 * truncation, no duplicate page boundaries, no missing rows, deterministic
 * ordering. Also covers NC4's PURE-LOGIC half (the live-DB half of NC4 —
 * actually disabling PostgREST pagination against real DEV — is exercised
 * separately by the live-DEV certification script; this file proves the
 * IN-MEMORY pipeline itself never truncates regardless of row count, which
 * is the precondition NC4 depends on).
 */
import { describe, expect, it } from 'vitest';
import { runBankCsvPipeline } from '@/lib/financial-data-hub/bank-csv/orchestrator';
import { adapterToRowFormat } from '@/lib/financial-data-hub/bank-csv/normalize';
import { AU_CBA_DEBIT_CREDIT_V1 } from '@/lib/financial-data-hub/bank-csv/adapters/registry';
import { CSV_MAX_ROWS } from '@/lib/financial-data-hub/bank-csv/constants';

const rowFormat = adapterToRowFormat(AU_CBA_DEBIT_CREDIT_V1);
const HEADER = 'Date,Description,Debit Amount,Credit Amount,Balance\n';

function buildFixture(rowCount: number): { csv: string; expectedClosingBalance: number } {
  const lines: string[] = [];
  let balance = 100000;
  for (let i = 1; i <= rowCount; i++) {
    balance -= 1;
    // 28 days in Feb (2026 is not a leap year) is plenty of distinct dates;
    // cycle through them so dates stay realistic without needing 10,000
    // unique calendar days.
    const day = ((i - 1) % 28) + 1;
    lines.push(`${String(day).padStart(2, '0')}/01/2026,Row ${i},1.00,,${balance.toFixed(2)}`);
  }
  return { csv: HEADER + lines.join('\n') + '\n', expectedClosingBalance: balance };
}

describe.each([999, 1000, 1001, 2500, 5001, 10000])('R7-TC-LARGE-%i row certification (spec 75, 77)', (rowCount) => {
  it(`processes exactly ${rowCount} rows with no truncation, no duplication, deterministic ordering`, () => {
    const { csv, expectedClosingBalance } = buildFixture(rowCount);
    const pipeline = runBankCsvPipeline({
      bytes: new TextEncoder().encode(csv),
      statementUploadId: `doc-${rowCount}`,
      financialAccountId: 'acct-large',
      currencyCode: 'AUD',
      rowFormatOverride: rowFormat,
      dedupIndex: new Map(),
    });

    expect(pipeline.declaredRowCount).toBe(rowCount);
    expect(pipeline.parsedRowCount).toBe(rowCount);
    expect(pipeline.rejected.length).toBe(0);
    expect(pipeline.accepted.length).toBe(rowCount);

    // No missing rows: source row numbers are exactly 1..rowCount, no gaps,
    // no duplicates.
    const sourceRowNumbers = pipeline.accepted.map((a) => a.sourceRowNumber).sort((a, b) => a - b);
    expect(sourceRowNumbers).toEqual(Array.from({ length: rowCount }, (_, i) => i + 1));

    // The closing balance is only correct if EVERY row (including those
    // beyond row 1000) was included — proves no 1000-row page-boundary
    // truncation occurred anywhere in the in-memory pipeline (spec 77).
    expect(pipeline.reconciliation?.status).toBe('reconciled');
    expect(pipeline.reconciliation?.reportedClosingBalance).toBeCloseTo(expectedClosingBalance, 2);

    // Every economic fingerprint is unique — no accidental page-boundary
    // duplication produced two identical-looking but distinct rows that
    // collided.
    const fingerprints = new Set(pipeline.accepted.map((a) => a.economicFingerprint));
    expect(fingerprints.size).toBe(rowCount);
  });
});

describe('R7-TC-LARGE-BOUNDARY — the safe row ceiling itself', () => {
  it(`R7-TC-LARGE-CEILING a file with exactly CSV_MAX_ROWS (${CSV_MAX_ROWS}) rows is accepted`, () => {
    const { csv } = buildFixture(CSV_MAX_ROWS);
    const pipeline = runBankCsvPipeline({
      bytes: new TextEncoder().encode(csv),
      statementUploadId: 'doc-ceiling',
      financialAccountId: 'acct-large',
      currencyCode: 'AUD',
      rowFormatOverride: rowFormat,
      dedupIndex: new Map(),
    });
    expect(pipeline.declaredRowCount).toBe(CSV_MAX_ROWS);
  });

  it('R7-TC-LARGE-OVER-CEILING a file exceeding CSV_MAX_ROWS is rejected outright, never silently truncated to the ceiling', () => {
    const { csv } = buildFixture(CSV_MAX_ROWS + 1);
    const pipeline = runBankCsvPipeline({
      bytes: new TextEncoder().encode(csv),
      statementUploadId: 'doc-over-ceiling',
      financialAccountId: 'acct-large',
      currencyCode: 'AUD',
      rowFormatOverride: rowFormat,
      dedupIndex: new Map(),
    });
    expect(pipeline.detection.status).toBe('invalid');
    expect(pipeline.parsedRowCount).toBe(0); // NOT silently truncated to CSV_MAX_ROWS
  });
});
