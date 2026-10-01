// BENCH-1 Phase 2 -- formula-injection-safe error CSV, templates and help text.
import { describe, it, expect } from 'vitest';
import {
  buildValidationErrorCsv,
  neutraliseCsvCell,
  parseCsvText,
  BENCHMARK_UPLOAD_TEMPLATES,
  UPLOAD_HELP_SECTIONS,
  DEFAULT_LIMITS,
  type ValidationIssue,
} from '@/lib/services/investment-intelligence/benchmarkData/fileIngest';

const issue = (o: Partial<ValidationIssue>): ValidationIssue => ({ rowNumber: 2, code: 'X', severity: 'error', message: 'm', ...o });

describe('neutraliseCsvCell', () => {
  it.each([
    ['=HYPERLINK("http://evil","click")', "'=HYPERLINK(\"http://evil\",\"click\")"],
    ['+1', "'+1"],
    ['-2', "'-2"],
    ['@SUM(A1:A2)', "'@SUM(A1:A2)"],
    ['\t=1', "'\t=1"],
    ['\tabc', "'\tabc"],
    ['\r=1', "'\r=1"],
    ['  =1+1', "'  =1+1"],
    ['\n=cmd|calc', "'\n=cmd|calc"],
    [' =1', "' =1"],
    ['﻿@x', "'﻿@x"],
  ])('prefixes a quote to %j', (input, expected) => {
    expect(neutraliseCsvCell(input)).toBe(expected);
  });

  it.each(['plain text', '12', '3.5', 'a=b', 'x+y', 'a-b', 'email@x.com', '', ' ok', "'already quoted"])('leaves %j untouched', (input) => {
    expect(neutraliseCsvCell(input)).toBe(input);
  });

  it('caps a cell at 500 characters, prefix included', () => {
    const long = 'a'.repeat(2000);
    expect(neutraliseCsvCell(long).length).toBeLessThanOrEqual(500);
    expect(neutraliseCsvCell('='.repeat(2000)).length).toBeLessThanOrEqual(500);
    expect(neutraliseCsvCell('='.repeat(2000)).startsWith("'=")).toBe(true);
  });
});

describe('buildValidationErrorCsv', () => {
  it('has the documented columns, CRLF line endings and a trailing CRLF', () => {
    const csv = buildValidationErrorCsv([issue({ rowNumber: 7, column: 'value', code: 'VALUE_EMPTY', message: 'The value is empty.', rawExcerpt: '' })]);
    expect(csv).toBe('row_number,severity,code,column,message,raw_excerpt\r\n7,error,VALUE_EMPTY,value,The value is empty.,\r\n');
    expect(csv.split('\r\n').every((l) => !l.includes('\n'))).toBe(true);
  });

  it('writes a blank row_number for file-level issues', () => {
    expect(buildValidationErrorCsv([issue({ rowNumber: null })]).split('\r\n')[1].startsWith(',error,')).toBe(true);
  });

  it('quotes cells containing commas, quotes and newlines (RFC 4180) so the file re-parses to the same values', () => {
    const msg = 'has, comma and "quotes"\nand a newline';
    const csv = buildValidationErrorCsv([issue({ message: msg, rawExcerpt: 'a,b' })]);
    const parsed = parseCsvText(csv, { delimiter: ',' });
    expect(parsed.problems).toEqual([]);
    expect(parsed.rows[1][4]).toBe(msg);
    expect(parsed.rows[1][5]).toBe('a,b');
  });

  it('NEUTRALISES formula-injection payloads in EVERY text column, including quote-wrapped ones', () => {
    const payloads = ['=HYPERLINK("http://evil.example","x")', '+1+1', '-2', '@SUM(A1)', '\t=1', '\r=1', '  =cmd|calc'];
    const csv = buildValidationErrorCsv(
      payloads.map((p) => issue({ code: p, column: p, message: p, rawExcerpt: p })),
    );
    const parsed = parseCsvText(csv, { delimiter: ',' });
    expect(parsed.problems).toEqual([]);
    expect(parsed.rows).toHaveLength(payloads.length + 1);
    for (const row of parsed.rows.slice(1)) {
      for (const idx of [2, 3, 4, 5]) {
        const cell = row[idx];
        expect(cell.startsWith("'"), JSON.stringify(cell)).toBe(true);
        // after neutralising, no cell begins (modulo whitespace) with a formula trigger
        expect(/^[\s\x00-\x20]*[=+\-@]/.test(cell)).toBe(false);
      }
    }
    // the raw payload never appears at the start of a cell in the file text
    const lines = csv.split('\r\n');
    expect(lines.some((l) => l.split(',').some((c) => /^"?[=+\-@]/.test(c)))).toBe(false);
  });

  it('truncates by maxRows and says so (the notice itself is safe)', () => {
    const issues = Array.from({ length: 10 }, (_, i) => issue({ rowNumber: i + 2 }));
    const csv = buildValidationErrorCsv(issues, { maxRows: 3 });
    const lines = csv.trimEnd().split('\r\n');
    expect(lines).toHaveLength(1 + 3 + 1);
    expect(lines[4]).toContain('ERROR_CSV_TRUNCATED');
    expect(lines[4]).toContain('7 further issue(s)');
    expect(buildValidationErrorCsv(issues).trimEnd().split('\r\n')).toHaveLength(11);
  });

  it('never emits a cell longer than 500 characters', () => {
    const csv = buildValidationErrorCsv([issue({ message: 'm'.repeat(5000), rawExcerpt: 'r'.repeat(5000) })]);
    const parsed = parseCsvText(csv, { delimiter: ',' });
    for (const cell of parsed.rows[1]) expect(cell.length).toBeLessThanOrEqual(500);
  });
});

describe('templates', () => {
  it('provides the three documented templates as plain CSV with no comment lines', () => {
    expect(Object.keys(BENCHMARK_UPLOAD_TEMPLATES).sort()).toEqual(['multi_key_date_value', 'provider_nse_tri_export', 'single_date_value']);
    expect(BENCHMARK_UPLOAD_TEMPLATES.single_date_value.csv.split('\r\n')[0]).toBe('date,value');
    expect(BENCHMARK_UPLOAD_TEMPLATES.multi_key_date_value.csv.split('\r\n')[0]).toBe('benchmark_key,date,value');
    expect(BENCHMARK_UPLOAD_TEMPLATES.provider_nse_tri_export.csv.split('\r\n')[0]).toBe('Date,Total Returns Index');
    for (const t of Object.values(BENCHMARK_UPLOAD_TEMPLATES)) {
      expect(t.fileName.endsWith('.csv')).toBe(true);
      const parsed = parseCsvText(t.csv, { delimiter: ',' });
      expect(parsed.problems).toEqual([]);
      expect(parsed.rows.length).toBeGreaterThanOrEqual(3);
      expect(t.csv).not.toMatch(/^\s*(#|\/\/)/m);
    }
  });

  it('uses obviously illustrative values (not real market data)', () => {
    expect(BENCHMARK_UPLOAD_TEMPLATES.single_date_value.csv).toContain('1000.00');
    expect(BENCHMARK_UPLOAD_TEMPLATES.multi_key_date_value.csv).toContain('REPLACE_ME');
  });
});

describe('help text', () => {
  const all = UPLOAD_HELP_SECTIONS.map((s) => `${s.title}\n${s.body}`).join('\n\n');

  it('covers every topic the governance rules require', () => {
    for (const needle of [
      'LEVEL',
      'percentage return',
      'Price, total return and net total return',
      'Currency and dates',
      'does not give you permission',
      'entitlement',
      'PDF',
      'xlsm',
      'sheet',
      'formula',
      'Hidden rows',
      'weekend',
      'Saturday or Sunday',
      'correction',
      'separate correction permission',
    ]) {
      expect(all.toLowerCase(), needle).toContain(needle.toLowerCase());
    }
  });

  it('states the actual limits from DEFAULT_LIMITS', () => {
    expect(all).toContain('5 MB');
    expect(all).toContain(DEFAULT_LIMITS.maxRows.toLocaleString('en-US'));
  });

  it('has a title and a body for every section', () => {
    expect(UPLOAD_HELP_SECTIONS.length).toBeGreaterThanOrEqual(8);
    for (const s of UPLOAD_HELP_SECTIONS) {
      expect(s.title.length).toBeGreaterThan(5);
      expect(s.body.length).toBeGreaterThan(40);
    }
  });
});
