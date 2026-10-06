/**
 * GOLDEN PAIR GP-D3 (found live on DEV, 2026-09-27): the Expenses "Import bank statement" panel and the
 * Liabilities "Import statement" panel never sent the statement PERIOD, although both upload routes
 * accept and store it. A CSV carries no printed period, so coverage fell back to the first/last approved
 * transaction dates: an approved August statement whose lines ran from the 1st to the 22nd left August
 * "partial", and every consumer (Dashboard, Score, DNA, Resilience, Twin, Forecast, Reports, the WP-15
 * averages proposal) counted $0 of its spending.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bankUploadParams, statementPeriodError } from '@/components/expenses/bankUploadParams';
import { computeCoverage } from '@/lib/read-models/core/coverage';
import { explicitWindow } from '@/lib/read-models/core/window';

const WINDOW = explicitWindow('2026-06-01', '2026-08-31', '2026-09-27', 'Australia/Sydney');
const src = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

describe('why the period matters (the documented coverage rule)', () => {
  it('a statement period of the whole month -> covered; only first/last transaction dates (1st-22nd) -> partial', () => {
    const withPeriod = computeCoverage([{ statementUploadId: 's', accountId: 'a', periodStart: '2026-08-01', periodEnd: '2026-08-31', fallbackStart: '2026-08-01', fallbackEnd: '2026-08-22' }], WINDOW);
    const without = computeCoverage([{ statementUploadId: 's', accountId: 'a', periodStart: null, periodEnd: null, fallbackStart: '2026-08-01', fallbackEnd: '2026-08-22' }], WINDOW);
    expect(withPeriod.coveredMonths).toEqual(['2026-08']);
    expect(without.coveredMonths).toEqual([]);
    expect(without.partialMonths).toEqual(['2026-08']);
  });
});

describe('the bank upload query', () => {
  const base = { country: 'AU' as const, currency: 'AUD' as const, maskedIdentifier: '4401', owner: { kind: 'member' as const, memberId: 'a1111111-1111-4111-8111-111111111111' }, filename: 'aug.csv' };

  it('sends the statement period the user entered', () => {
    const q = bankUploadParams({ ...base, periodStart: '2026-08-01', periodEnd: '2026-08-31' });
    expect(Object.fromEntries(q)).toEqual({
      country_code: 'AU', currency_code: 'AUD', masked_identifier: '4401', owner: JSON.stringify(base.owner), filename: 'aug.csv',
      statement_period_start: '2026-08-01', statement_period_end: '2026-08-31',
    });
  });

  it('no period entered -> no period sent (unchanged behaviour); half-filled or inverted -> refused with a message', () => {
    expect(bankUploadParams(base).has('statement_period_start')).toBe(false);
    expect(statementPeriodError('', '')).toBeNull();
    expect(statementPeriodError('2026-08-01', '')).toMatch(/both/);
    expect(statementPeriodError('2026-08-31', '2026-08-01')).toMatch(/ends before/);
    expect(bankUploadParams({ ...base, periodStart: '2026-08-31', periodEnd: '2026-08-01' }).has('statement_period_start')).toBe(false);
  });
});

describe('the panels collect and send it', () => {
  it('Expenses -> Import bank statement: date inputs + the shared query builder', () => {
    const panel = src('components/expenses/BankStatementImportPanel.tsx');
    expect(panel).toMatch(/bankUploadParams\(\{[^}]*periodStart[^}]*periodEnd[^}]*\}\)/);
    expect((panel.match(/<DateInput/g) ?? []).length).toBeGreaterThanOrEqual(2); // day-first typed date (PO review F13), not a native picker
    expect(panel).not.toContain('type="date"');
    expect(panel).not.toMatch(/new URLSearchParams\(\{ country_code: country, currency_code: currency \}\)/);
  });

  it('Liabilities -> Import statement: date inputs + statement_period_start/end on the upload query', () => {
    const panel = src('components/liabilities/LiabilityImportPanel.tsx');
    expect(panel).toMatch(/params\.set\('statement_period_start', periodStart\)/);
    expect(panel).toMatch(/params\.set\('statement_period_end', periodEnd\)/);
    expect(panel).toMatch(/value=\{periodStart\}/);
  });

  it('GP-D4: after a successful Apply the Liabilities panel runs the same best-effort classification as the bank import', () => {
    const panel = src('components/liabilities/LiabilityImportPanel.tsx');
    const apply = panel.slice(panel.indexOf('async function handleApply()'));
    const applyBody = apply.slice(0, apply.indexOf('\n  }\n'));
    expect(applyBody).toMatch(/fetch\('\/api\/financial-data-hub\/bank-transactions\/categorise', \{ method: 'POST' \}\)/);
  });

  it('both upload routes read the period from the query (the server side was always there)', () => {
    for (const r of ['app/api/financial-data-hub/bank-csv/upload/route.ts', 'app/api/financial-data-hub/bank-pdf/upload/route.ts', 'app/api/financial-data-hub/liability-statement/upload/route.ts']) {
      expect(src(r)).toMatch(/searchParams\.get\('statement_period_start'\)/);
      expect(src(r)).toMatch(/searchParams\.get\('statement_period_end'\)/);
    }
  });
});
