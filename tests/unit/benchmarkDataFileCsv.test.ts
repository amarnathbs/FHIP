// BENCH-1 Phase 2 -- CSV reader (pure).
import { describe, it, expect } from 'vitest';
import { parseCsvText, detectDelimiter } from '@/lib/services/investment-intelligence/benchmarkData/fileIngest';

const codes = (r: { problems: Array<{ code: string }> }) => r.problems.map((p) => p.code);

describe('RFC-4180 parsing', () => {
  it('parses a simple file and records the physical line of each record', () => {
    const r = parseCsvText('date,value\n2024-01-01,1000.00\n2024-01-02,1001.50\n');
    expect(r.rows).toEqual([['date', 'value'], ['2024-01-01', '1000.00'], ['2024-01-02', '1001.50']]);
    expect(r.lineNumbers).toEqual([1, 2, 3]);
    expect(r.delimiter).toBe(',');
    expect(r.problems).toEqual([]);
    expect(r.truncated).toBe(false);
  });

  it('handles quoted delimiters, doubled quotes and embedded newlines (line numbers stay physical)', () => {
    const r = parseCsvText('a,b\n"x, y","say ""hi"""\n"multi\nline",3\nlast,4\n');
    expect(r.rows).toEqual([['a', 'b'], ['x, y', 'say "hi"'], ['multi\nline', '3'], ['last', '4']]);
    expect(r.lineNumbers).toEqual([1, 2, 3, 5]);
    expect(r.problems).toEqual([]);
  });

  it('accepts CRLF, LF and bare CR line endings, with or without a final newline', () => {
    for (const nl of ['\r\n', '\n', '\r']) {
      for (const tail of ['', nl]) {
        const r = parseCsvText(`a,b${nl}1,2${nl}3,4${tail}`);
        expect(r.rows, JSON.stringify(nl + tail)).toEqual([['a', 'b'], ['1', '2'], ['3', '4']]);
        expect(r.problems).toEqual([]);
      }
    }
  });

  it('skips blank lines but keeps true line numbers; keeps empty fields', () => {
    const r = parseCsvText('a,b\n\n1,\n   \n,2\n');
    expect(r.rows).toEqual([['a', 'b'], ['1', ''], ['', '2']]);
    expect(r.lineNumbers).toEqual([1, 3, 5]);
  });

  it('keeps an explicitly quoted empty value as a record', () => {
    expect(parseCsvText('a\n""\n').rows).toEqual([['a'], ['']]);
  });
});

describe('delimiter detection (documented rule)', () => {
  it.each([
    [',', 'a,b\n1,2\n'],
    [';', 'a;b\n1;2\n'],
    ['\t', 'a\tb\n1\t2\n'],
    ['|', 'a|b\n1|2\n'],
  ])('detects %j', (d, text) => {
    const r = parseCsvText(text);
    expect(r.delimiter).toBe(d);
    expect(r.rows[1]).toEqual(['1', '2']);
    expect(r.problems).toEqual([]);
  });

  it('chooses ";" for a European-locale file whose values contain decimal commas', () => {
    const r = parseCsvText('Date;Value\n01/01/2024;1.234,56\n02/01/2024;1.240,10\n');
    expect(r.delimiter).toBe(';');
    expect(r.rows[1]).toEqual(['01/01/2024', '1.234,56']);
    expect(r.problems).toEqual([]);
  });

  it('ignores delimiters inside quotes when counting', () => {
    const r = parseCsvText('"a;b",c\n"1;2",3\n');
    expect(r.delimiter).toBe(',');
    expect(r.rows[1]).toEqual(['1;2', '3']);
  });

  it('reports AMBIGUOUS_DELIMITER when two candidates tie, and does not guess silently', () => {
    const r = parseCsvText('a,b;c\n1,2;3\n');
    expect(codes(r)).toContain('AMBIGUOUS_DELIMITER');
    expect(detectDelimiter('a,b;c\n1,2;3\n').problems[0].code).toBe('AMBIGUOUS_DELIMITER');
  });

  it('prefers the candidate with more occurrences when both are consistent but counts differ', () => {
    const r = parseCsvText('a,b,c;d\n1,2,3;4\n');
    expect(r.delimiter).toBe(',');
    expect(codes(r)).not.toContain('AMBIGUOUS_DELIMITER');
  });

  it('falls back with DELIMITER_INCONSISTENT when no candidate is consistent', () => {
    const r = parseCsvText('a,b\n1,2,3\n');
    expect(r.delimiter).toBe(',');
    expect(codes(r)).toContain('DELIMITER_INCONSISTENT');
  });

  it('treats a single-column file as comma-delimited without a problem', () => {
    const r = parseCsvText('value\n1\n2\n');
    expect(r.delimiter).toBe(',');
    expect(r.problems).toEqual([]);
  });

  it('an explicit delimiter overrides detection', () => {
    const r = parseCsvText('a;b,c\n1;2,3\n', { delimiter: ';' });
    expect(r.rows[0]).toEqual(['a', 'b,c']);
    expect(r.problems).toEqual([]);
  });
});

describe('malformed input is reported, never thrown', () => {
  it('reports an unterminated quote with its row', () => {
    const r = parseCsvText('a,b\n1,"never closed\n2,3\n');
    expect(codes(r)).toContain('UNTERMINATED_QUOTE');
    expect(r.problems.find((p) => p.code === 'UNTERMINATED_QUOTE')?.rowNumber).toBe(2);
  });

  it('reports stray quotes and text after a closing quote', () => {
    expect(codes(parseCsvText('a,b\nx"y,2\n'))).toContain('STRAY_QUOTE');
    expect(codes(parseCsvText('a,b\n"x"y,2\n'))).toContain('BAD_QUOTE');
  });

  it('caps rows with TOO_MANY_ROWS and marks the result truncated', () => {
    const text = 'a\n' + Array.from({ length: 50 }, (_, i) => String(i)).join('\n') + '\n';
    const r = parseCsvText(text, { maxRows: 10 });
    expect(r.rows).toHaveLength(10);
    expect(r.truncated).toBe(true);
    expect(codes(r)).toContain('TOO_MANY_ROWS');
    const ok = parseCsvText(text, { maxRows: 51 });
    expect(ok.truncated).toBe(false);
    expect(ok.rows).toHaveLength(51);
  });

  it('reports ragged rows with the row number the operator sees', () => {
    const r = parseCsvText('a,b\n1,2\n3\n4,5,6\n7,8\n');
    const ragged = r.problems.filter((p) => p.code === 'RAGGED_ROW');
    expect(ragged.map((p) => p.rowNumber)).toEqual([3, 4]);
    expect(ragged[0].message).toContain('Row 3');
  });

  it('exempts preamble rows before an explicit header row from the ragged check', () => {
    const text = 'Report title\nGenerated,today,by me\nDate,Value\n2024-01-01,1\n2024-01-02\n';
    const r = parseCsvText(text, { headerRow: 3, delimiter: ',' });
    expect(r.problems.filter((p) => p.code === 'RAGGED_ROW').map((p) => p.rowNumber)).toEqual([5]);
  });

  it('is linear on hostile long inputs (no catastrophic backtracking)', () => {
    const t0 = Date.now();
    parseCsvText('"'.repeat(400_000));
    parseCsvText('a,'.repeat(300_000) + '\n' + 'b,'.repeat(300_000));
    parseCsvText('"a""'.repeat(200_000));
    expect(Date.now() - t0).toBeLessThan(8000);
  });
});
