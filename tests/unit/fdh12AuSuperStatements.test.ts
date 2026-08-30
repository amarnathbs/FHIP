/**
 * FDH-12 — AU super (and India EPF) statement detection, extraction and
 * activity classification (spec sections 8-9, 21, 82-86, 143-145).
 *
 * The controls that matter most here are the FAIL-SAFE ones: an unrecognised
 * layout must resolve to MANUAL_MAPPING_REQUIRED rather than a confident wrong
 * extraction (85, 145), and a malformed field must never become zero (143, 94).
 */

import { describe, it, expect } from 'vitest';
import { detectRetirementCsvFormat } from '@/lib/financial-data-hub/retirement/detection';
import { extractRetirementStatement } from '@/lib/financial-data-hub/retirement/extraction';
import {
  classifyRetirementActivity,
  looksSummaryTotal,
  looksYearToDate,
} from '@/lib/financial-data-hub/retirement/activityClassification';
import {
  RETIREMENT_CSV_ADAPTER_REGISTRY,
  certifiedRetirementAdapterCount,
  getRetirementAdapterById,
} from '@/lib/financial-data-hub/retirement/adapters/registry';

const bytes = (text: string) => new TextEncoder().encode(text);

const TRANSACTION_CSV = [
  'Date,Description,Amount,Employer',
  '15/07/2026,Employer Superannuation Guarantee,1000.00,Acme Pty Ltd',
  '15/07/2026,Personal contribution,500.00,',
  '31/07/2026,Administration fee,-100.00,',
  '31/07/2026,Insurance premium - Death & TPD,-75.00,',
  '31/07/2026,Investment earnings,5000.00,',
  '31/07/2026,Contributions tax,-150.00,',
].join('\n');

const PERIOD = '2026-07-01 to 2026-07-31';
const SUMMARY_CSV = [
  'Item,Amount,Period',
  `Opening balance,100000.00,${PERIOD}`,
  `Employer contributions,8000.00,${PERIOD}`,
  `Personal contributions,2000.00,${PERIOD}`,
  `Investment earnings,5000.00,${PERIOD}`,
  `Fees,500.00,${PERIOD}`,
  `Contributions tax,1000.00,${PERIOD}`,
  `Closing balance,113500.00,${PERIOD}`,
].join('\n');

const HOLDINGS_CSV = [
  'Investment Option,Asset Class,Market Value',
  'High Growth,Diversified,45000.00',
  'Australian Shares,Equity,20000.00',
].join('\n');

const EPF_CSV = [
  'Date,Particulars,Amount',
  '15/07/2026,Employer Share contribution,1800.00',
  '15/07/2026,Employee Share contribution,1800.00',
  '31/03/2026,Interest credited,4500.00',
].join('\n');

function detectAndExtract(csv: string, opts: Partial<Parameters<typeof extractRetirementStatement>[1]> = {}) {
  const detection = detectRetirementCsvFormat(bytes(csv));
  return {
    detection,
    result: extractRetirementStatement(detection, {
      currencyCode: 'AUD',
      jurisdiction: 'AU',
      ...opts,
    }),
  };
}

// ===========================================================================
// Adapter registry and coverage honesty (spec section 83)
// ===========================================================================

describe('FDH-12 spec 83 — coverage honesty', () => {
  it('ships four fund-neutral certified layouts and no named-fund adapter', () => {
    expect(certifiedRetirementAdapterCount()).toBe(4);
    for (const a of RETIREMENT_CSV_ADAPTER_REGISTRY) {
      // No adapter claims to recognise a specific real super fund's export.
      expect(a.institutionCode, a.id).toBeNull();
    }
  });

  it('every registered adapter has a stable id, version and coverage state', () => {
    for (const a of RETIREMENT_CSV_ADAPTER_REGISTRY) {
      expect(a.id).toMatch(/^fdh12_/);
      expect(a.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(['certified', 'generic_supported', 'manual_mapping_required', 'ocr_required', 'unsupported']).toContain(a.coverageState);
    }
  });

  it('adapter ids are unique and resolvable', () => {
    const ids = RETIREMENT_CSV_ADAPTER_REGISTRY.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(getRetirementAdapterById(id)?.id).toBe(id);
  });

  it('returns null for an unknown adapter id rather than a default', () => {
    expect(getRetirementAdapterById('some_other_fund_v1')).toBeNull();
  });
});

// ===========================================================================
// Detection (spec sections 84-86)
// ===========================================================================

describe('FDH-12 spec 84-86 — format detection', () => {
  it('detects the transaction layout', () => {
    const d = detectRetirementCsvFormat(bytes(TRANSACTION_CSV));
    expect(d.status).toBe('detected');
    expect(d.adapter?.csvKind).toBe('transaction');
  });

  it('detects the summary layout', () => {
    const d = detectRetirementCsvFormat(bytes(SUMMARY_CSV));
    expect(d.status).toBe('detected');
    expect(d.adapter?.csvKind).toBe('summary');
  });

  it('detects the holdings layout', () => {
    const d = detectRetirementCsvFormat(bytes(HOLDINGS_CSV));
    expect(d.status).toBe('detected');
    expect(d.adapter?.csvKind).toBe('holdings');
  });

  it('spec 85/145: an unrecognised layout is MANUAL_MAPPING_REQUIRED, not a zero import', () => {
    const d = detectRetirementCsvFormat(bytes('Foo,Bar,Baz\n1,2,3\n4,5,6'));
    expect(d.status).toBe('manual_mapping_required');
    expect(d.adapter).toBeNull();
  });

  it('spec 86: detection never sees a filename — the API takes bytes only', () => {
    // A signature check on the function itself: one parameter, and it is bytes.
    expect(detectRetirementCsvFormat.length).toBe(1);
  });

  it('reports INVALID with a reason for a structurally broken file', () => {
    const d = detectRetirementCsvFormat(bytes(''));
    expect(d.status).toBe('invalid');
    expect(d.reason).toBeTruthy();
  });
});

// ===========================================================================
// Header variation (spec section 144)
// ===========================================================================

describe('FDH-12 spec 144 — header and layout variation', () => {
  it('reads CRLF exactly as LF', () => {
    const lf = detectAndExtract(TRANSACTION_CSV);
    const crlf = detectAndExtract(TRANSACTION_CSV.replace(/\n/g, '\r\n'));
    expect(crlf.result.ok).toBe(true);
    expect(lf.result.ok).toBe(true);
    if (lf.result.ok && crlf.result.ok) {
      expect(crlf.result.extraction.activities.length).toBe(lf.result.extraction.activities.length);
      expect(crlf.result.extraction.activities[0].amount).toBe(lf.result.extraction.activities[0].amount);
    }
  });

  it('tolerates leading blank rows before the header', () => {
    const { result } = detectAndExtract(`\n\n${TRANSACTION_CSV}`);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.extraction.activities.length).toBe(6);
  });

  it('tolerates blank rows in the middle of the data', () => {
    const lines = TRANSACTION_CSV.split('\n');
    const withGap = [...lines.slice(0, 3), '', '', ...lines.slice(3)].join('\n');
    const { result } = detectAndExtract(withGap);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.extraction.activities.length).toBe(6);
  });

  it('tolerates a different column ORDER', () => {
    const reordered = [
      'Employer,Amount,Description,Date',
      'Acme Pty Ltd,1000.00,Employer Superannuation Guarantee,15/07/2026',
    ].join('\n');
    const { result } = detectAndExtract(reordered);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.extraction.activities[0].activityType).toBe('EMPLOYER_CONTRIBUTION');
      expect(result.extraction.activities[0].amount).toBe('1000.00');
    }
  });

  it('tolerates absent OPTIONAL columns', () => {
    const minimal = ['Date,Description,Amount', '15/07/2026,Employer contribution,1000.00'].join('\n');
    const { result } = detectAndExtract(minimal);
    expect(result.ok).toBe(true);
  });

  it('is case- and whitespace-insensitive on header names', () => {
    const shouty = ['  DATE , DESCRIPTION , AMOUNT ', '15/07/2026,Employer contribution,1000.00'].join('\n');
    const { result } = detectAndExtract(shouty);
    expect(result.ok).toBe(true);
  });
});

// ===========================================================================
// Extraction correctness
// ===========================================================================

describe('FDH-12 — transaction extraction', () => {
  it('reads every activity with the right type and a positive magnitude', () => {
    const { result } = detectAndExtract(TRANSACTION_CSV);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byType = Object.fromEntries(
      result.extraction.activities.map((a) => [a.activityType, a.amount]),
    );
    expect(byType.EMPLOYER_CONTRIBUTION).toBe('1000.00');
    expect(byType.PERSONAL_CONTRIBUTION).toBe('500.00');
    // A statement printing "-100.00" for a fee still stores a POSITIVE
    // magnitude; direction comes from the activity type.
    expect(byType.FEE).toBe('100.00');
    expect(byType.INSURANCE_PREMIUM).toBe('75.00');
    expect(byType.INVESTMENT_EARNINGS).toBe('5000.00');
    expect(byType.TAX).toBe('150.00');
  });

  it('records the parser identity and version', () => {
    const { result } = detectAndExtract(TRANSACTION_CSV);
    if (!result.ok) throw new Error('expected success');
    expect(result.extraction.parserName).toBe('fdh12_generic_retirement_transaction_csv_v1');
    expect(result.extraction.parserVersion).toBe('1.0.0');
    expect(result.extraction.extractionConfidence).toBeGreaterThan(0);
    expect(result.extraction.extractionConfidence).toBeLessThanOrEqual(1);
  });

  it('preserves the employer for contribution rows', () => {
    const { result } = detectAndExtract(TRANSACTION_CSV);
    if (!result.ok) throw new Error('expected success');
    const employer = result.extraction.activities.find((a) => a.activityType === 'EMPLOYER_CONTRIBUTION');
    expect(employer?.employerNameRaw).toBe('Acme Pty Ltd');
  });

  it('reads dates day-first, as both AU and India write them (spec section 50)', () => {
    const { result } = detectAndExtract(TRANSACTION_CSV);
    if (!result.ok) throw new Error('expected success');
    expect(result.extraction.activities[0].activityDate).toBe('2026-07-15');
  });

  it('carries the statement period through unchanged (spec section 50)', () => {
    const { result } = detectAndExtract(TRANSACTION_CSV, {
      statementStartDate: '2026-07-01',
      statementEndDate: '2026-07-31',
      statementDate: '2026-08-05',
    });
    if (!result.ok) throw new Error('expected success');
    expect(result.extraction.statementStartDate).toBe('2026-07-01');
    expect(result.extraction.statementEndDate).toBe('2026-07-31');
    expect(result.extraction.statementDate).toBe('2026-08-05');
  });
});

describe('FDH-12 — summary extraction', () => {
  it('reads opening, closing and every movement total', () => {
    const detection = detectRetirementCsvFormat(bytes(SUMMARY_CSV));
    const result = extractRetirementStatement(detection, { currencyCode: 'AUD', jurisdiction: 'AU' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ex = result.extraction;
    expect(ex.openingBalance).toBe('100000.00');
    expect(ex.closingBalance).toBe('113500.00');
    expect(ex.employerContributions).toBe('8000.00');
    expect(ex.personalContributions).toBe('2000.00');
    expect(ex.investmentEarnings).toBe('5000.00');
    expect(ex.fees).toBe('500.00');
    expect(ex.tax).toBe('1000.00');
  });

  it('spec 49/94: an absent figure is UNDEFINED, never "0"', () => {
    const partial = ['Item,Amount,Period', `Closing balance,113500.00,${PERIOD}`].join('\n');
    const detection = detectRetirementCsvFormat(bytes(partial));
    const result = extractRetirementStatement(detection, { currencyCode: 'AUD', jurisdiction: 'AU' });
    if (!result.ok) throw new Error('expected success');
    expect(result.extraction.closingBalance).toBe('113500.00');
    expect(result.extraction.openingBalance).toBeUndefined();
    expect(result.extraction.openingBalance).not.toBe('0.00');
  });

  it('routes a YTD line to the ytd_* field, never the period one', () => {
    const withYtd = [
      'Item,Amount,Period',
      `Employer contributions,1000.00,${PERIOD}`,
      'Employer contributions,8000.00,Year to date',
      `Closing balance,113500.00,${PERIOD}`,
    ].join('\n');
    const detection = detectRetirementCsvFormat(bytes(withYtd));
    const result = extractRetirementStatement(detection, { currencyCode: 'AUD', jurisdiction: 'AU' });
    if (!result.ok) throw new Error('expected success');
    expect(result.extraction.employerContributions).toBe('1000.00');
    expect(result.extraction.ytdEmployerContributions).toBe('8000.00');
    // The forbidden $9,000 never appears.
    expect(result.extraction.employerContributions).not.toBe('9000.00');
  });
});

describe('FDH-12 — holdings extraction is evidence only', () => {
  it('reads investment options with their market values', () => {
    const detection = detectRetirementCsvFormat(bytes(HOLDINGS_CSV));
    const result = extractRetirementStatement(detection, { currencyCode: 'AUD', jurisdiction: 'AU' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extraction.positions).toHaveLength(2);
    expect(result.extraction.positions[0].optionNameRaw).toBe('High Growth');
    expect(result.extraction.positions[0].marketValue).toBe('45000.00');
    // No activity is created from a holdings file — holdings are not events.
    expect(result.extraction.activities).toHaveLength(0);
  });
});

// ===========================================================================
// Fail-safe parsing (spec sections 94, 143, 145)
// ===========================================================================

describe('FDH-12 spec 143 — parser negative controls', () => {
  it('SKIPS a row with a malformed amount rather than storing 0.00', () => {
    const csv = [
      'Date,Description,Amount',
      '15/07/2026,Employer contribution,1000.00',
      '15/07/2026,Broken row,not-a-number',
    ].join('\n');
    const { result } = detectAndExtract(csv);
    if (!result.ok) throw new Error('expected success');
    expect(result.extraction.activities).toHaveLength(1);
    expect(result.extraction.activities.some((a) => a.amount === '0.00')).toBe(false);
    expect(result.extraction.warnings.some((w) => w.startsWith('unreadable_amount_rows_skipped'))).toBe(true);
  });

  it('keeps a row with a malformed DATE but leaves the date null', () => {
    const csv = [
      'Date,Description,Amount',
      '15/07/2026,Employer contribution,1000.00',
      '99/99/9999,Personal contribution,500.00',
    ].join('\n');
    const { result } = detectAndExtract(csv);
    if (!result.ok) throw new Error('expected success');
    const personal = result.extraction.activities.find((a) => a.activityType === 'PERSONAL_CONTRIBUTION');
    expect(personal).toBeDefined();
    expect(personal!.amount).toBe('500.00');
    expect(personal!.activityDate).toBeUndefined();
  });

  it('spec 145: a file where NOTHING parses is a FAILURE, not an empty success', () => {
    const csv = ['Date,Description,Amount', '15/07/2026,Broken,not-a-number'].join('\n');
    const { result } = detectAndExtract(csv);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('layout_unsupported');
  });

  it('a MANUAL_MAPPING_REQUIRED detection never reaches extraction', () => {
    const detection = detectRetirementCsvFormat(bytes('Foo,Bar,Baz\n1,2,3\n4,5,6'));
    const result = extractRetirementStatement(detection, { currencyCode: 'AUD', jurisdiction: 'AU' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('manual_mapping_required');
  });

  it('lowers extraction confidence when rows could not be read', () => {
    const clean = detectAndExtract(TRANSACTION_CSV);
    const dirty = detectAndExtract([
      TRANSACTION_CSV,
      '15/07/2026,Broken,not-a-number,',
      '15/07/2026,Also broken,also-not-a-number,',
    ].join('\n'));
    if (!clean.result.ok || !dirty.result.ok) throw new Error('expected success');
    expect(dirty.result.extraction.extractionConfidence)
      .toBeLessThan(clean.result.extraction.extractionConfidence);
  });
});

// ===========================================================================
// Activity classification (spec section 21)
// ===========================================================================

describe('FDH-12 spec 21 — activity classification', () => {
  const cases: [string, string][] = [
    ['Employer Superannuation Guarantee', 'EMPLOYER_CONTRIBUTION'],
    ['SG contribution', 'EMPLOYER_CONTRIBUTION'],
    ['Employer contribution', 'EMPLOYER_CONTRIBUTION'],
    ['Salary sacrifice contribution', 'SALARY_SACRIFICE'],
    ['Government co-contribution', 'GOVERNMENT_CONTRIBUTION'],
    ['Low Income Super Tax Offset', 'GOVERNMENT_CONTRIBUTION'],
    ['Personal contribution', 'PERSONAL_CONTRIBUTION'],
    ['Member contribution', 'PERSONAL_CONTRIBUTION'],
    ['Non-concessional contribution', 'PERSONAL_CONTRIBUTION'],
    ['Rollover in from AustralianSuper', 'ROLLOVER_IN'],
    ['Transfer in', 'ROLLOVER_IN'],
    ['Rollover out to Hostplus', 'ROLLOVER_OUT'],
    ['Transfer to another fund', 'ROLLOVER_OUT'],
    ['Investment earnings', 'INVESTMENT_EARNINGS'],
    ['Interest credited', 'INTEREST'],
    ['Distribution', 'DISTRIBUTION'],
    ['Administration fee', 'FEE'],
    ['Investment fee', 'FEE'],
    ['Insurance premium - Death & TPD', 'INSURANCE_PREMIUM'],
    ['Income protection premium', 'INSURANCE_PREMIUM'],
    ['Contributions tax', 'TAX'],
    ['No-TFN tax', 'TAX'],
    ['Pension payment', 'PENSION_PAYMENT'],
    ['Lump sum withdrawal', 'WITHDRAWAL'],
    ['Adjustment', 'ADJUSTMENT'],
  ];

  for (const [label, expected] of cases) {
    it(`classifies "${label}" as ${expected}`, () => {
      expect(classifyRetirementActivity(label)).toBe(expected);
    });
  }

  it('an INSURANCE premium is never classified as an ordinary fee', () => {
    // Ordering control: "insurance premium" contains no "fee", but "insurance
    // fee" does, and must still be INSURANCE_PREMIUM.
    expect(classifyRetirementActivity('Insurance fee')).toBe('INSURANCE_PREMIUM');
  });

  it('"contributions tax" is TAX, not a contribution and not a fee', () => {
    expect(classifyRetirementActivity('Contributions tax')).toBe('TAX');
  });

  it('"government co-contribution" is not a personal contribution', () => {
    expect(classifyRetirementActivity('Government co-contribution')).toBe('GOVERNMENT_CONTRIBUTION');
  });

  it('"employer contribution" is never read as a personal one', () => {
    expect(classifyRetirementActivity('Employer contribution')).not.toBe('PERSONAL_CONTRIBUTION');
  });

  it('spec 33: a DIRECTIONLESS "rollover" is UNKNOWN, never guessed', () => {
    // Guessing the direction of a $100,000 movement is the failure the spec is
    // about. UNKNOWN makes the statement report INSUFFICIENT_DATA instead.
    expect(classifyRetirementActivity('Rollover')).toBe('UNKNOWN');
  });

  it('an unrecognised label is UNKNOWN, not a closest guess', () => {
    expect(classifyRetirementActivity('Zorblatt reticulation charge')).toBe('UNKNOWN');
    expect(classifyRetirementActivity('')).toBe('UNKNOWN');
  });

  it('recognises India EPF/NPS wording only under the IN jurisdiction', () => {
    expect(classifyRetirementActivity('Employer Share', 'IN')).toBe('EMPLOYER_CONTRIBUTION');
    expect(classifyRetirementActivity('Employer PF', 'IN')).toBe('EMPLOYER_CONTRIBUTION');
    expect(classifyRetirementActivity('Employer NPS', 'IN')).toBe('EMPLOYER_CONTRIBUTION');
    // The India-only rule does not fire for AU.
    expect(classifyRetirementActivity('Employer Share', 'AU')).toBe('UNKNOWN');
  });

  it('flags printed subtotals', () => {
    expect(looksSummaryTotal('Total employer contributions')).toBe(true);
    expect(looksSummaryTotal('Subtotal')).toBe(true);
    expect(looksSummaryTotal('Employer contribution')).toBe(false);
  });

  it('flags year-to-date lines', () => {
    expect(looksYearToDate('Employer contributions YTD')).toBe(true);
    expect(looksYearToDate('Employer contributions year to date')).toBe(true);
    expect(looksYearToDate('Cumulative employer contributions')).toBe(true);
    expect(looksYearToDate('Employer contribution')).toBe(false);
  });
});

// ===========================================================================
// India (spec section 9)
// ===========================================================================

describe('FDH-12 spec 9 — India EPF statement evidence', () => {
  it('detects and reads an EPF passbook export', () => {
    const detection = detectRetirementCsvFormat(bytes(EPF_CSV));
    expect(detection.status).toBe('detected');
    expect(detection.adapter?.jurisdiction).toBe('IN');
    const result = extractRetirementStatement(detection, { currencyCode: 'INR', jurisdiction: 'IN' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extraction.accountType).toBe('epf');
    expect(result.extraction.currencyCode).toBe('INR');
    const types = result.extraction.activities.map((a) => a.activityType);
    expect(types).toContain('EMPLOYER_CONTRIBUTION');
    expect(types).toContain('PERSONAL_CONTRIBUTION');
    expect(types).toContain('INTEREST');
  });

  it('builds NO India-specific calculation — it is the same evidence shape', () => {
    const detection = detectRetirementCsvFormat(bytes(EPF_CSV));
    const result = extractRetirementStatement(detection, { currencyCode: 'INR', jurisdiction: 'IN' });
    if (!result.ok) throw new Error('expected success');
    // The extraction type is identical to the AU one — there is no second
    // India engine, only an adapter (spec sections 7, 9).
    expect(Object.keys(result.extraction).sort()).toEqual(
      Object.keys(
        (() => {
          const au = detectAndExtract(TRANSACTION_CSV);
          if (!au.result.ok) throw new Error('expected success');
          return au.result.extraction;
        })(),
      ).sort(),
    );
  });
});
