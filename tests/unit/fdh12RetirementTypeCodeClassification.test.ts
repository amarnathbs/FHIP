// FDH-12 -- a Type column that spells the activity code (release register
// F-16, 2026-09-25). Written to FAIL on origin/main 8b6692c: live DEV
// journey J9 classified both lines of the fdh14 smoke super CSV as UNKNOWN,
// although its Type column says EMPLOYER_CONTRIBUTION / PERSONAL_CONTRIBUTION.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { classifyRetirementActivity } from '@/lib/financial-data-hub/retirement/activityClassification';
import { detectRetirementCsvFormat } from '@/lib/financial-data-hub/retirement/detection';
import { extractRetirementStatement } from '@/lib/financial-data-hub/retirement/extraction';

describe('retirement activity codes in a Type column', () => {
  it.each([
    ['EMPLOYER_CONTRIBUTION', 'EMPLOYER_CONTRIBUTION'],
    ['PERSONAL_CONTRIBUTION', 'PERSONAL_CONTRIBUTION'],
    ['salary_sacrifice', 'SALARY_SACRIFICE'],
    ['Rollover-In', 'ROLLOVER_IN'],
    ['INSURANCE_PREMIUM', 'INSURANCE_PREMIUM'],
  ])('%s -> %s', (label, expected) => {
    expect(classifyRetirementActivity(label)).toBe(expected);
  });

  it('only an EXACT code short-circuits -- a code embedded in prose still goes through the phrase rules, and nonsense stays UNKNOWN', () => {
    expect(classifyRetirementActivity('ROLLOVER')).toBe('UNKNOWN'); // no direction: never guessed
    expect(classifyRetirementActivity('EMPLOYER_CONTRIBUTIONX')).toBe('UNKNOWN');
    expect(classifyRetirementActivity('NOT_A_CODE')).toBe('UNKNOWN');
    expect(classifyRetirementActivity('Employer contribution')).toBe('EMPLOYER_CONTRIBUTION');
  });

  it('the fdh14 smoke super CSV (J9) extracts EMPLOYER_CONTRIBUTION 500.00 and PERSONAL_CONTRIBUTION 200.00, not UNKNOWN', () => {
    const bytes = new Uint8Array(fs.readFileSync(path.join('tests', 'fixtures', 'financial-data-hub', 'fdh14-smoke-retirement.csv')));
    const detection = detectRetirementCsvFormat(bytes);
    const result = extractRetirementStatement(detection, { currencyCode: 'AUD', jurisdiction: 'AU', fundName: 'Synthetic Super Fund', maskedAccountIdentifier: 'xx0001', statementStartDate: '2026-07-01', statementEndDate: '2026-07-31' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const got = result.extraction.activities.map((a) => `${a.activityType}:${a.amount}`).sort();
    expect(got).toEqual(['EMPLOYER_CONTRIBUTION:500.00', 'PERSONAL_CONTRIBUTION:200.00']);
  });
});
