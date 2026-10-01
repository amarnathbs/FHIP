// RFC-4180 CSV reader (single pass state machine, linear time, no regex).
//
// DELIMITER AUTO-DETECTION RULE (documented, deterministic):
//   Candidates are , ; TAB |. Sample up to the first 20 non-blank records,
//   counting each candidate OUTSIDE double quotes. A candidate is CONSISTENT
//   when it appears at least once on the header record and the same number of
//   times on every sampled record.
//     * exactly one consistent candidate -> chosen;
//     * several consistent, different counts -> the highest count wins;
//     * several consistent with the SAME count -> AMBIGUOUS_DELIMITER (a
//       problem; "," is returned so the caller can still show a preview, but
//       the upload must be rejected until the operator picks a delimiter);
//     * none consistent -> the candidate with the highest header count, with a
//       DELIMITER_INCONSISTENT problem; no candidate at all -> "," (a
//       single-column file).
//   ";" is the usual delimiter of files exported with an EU number locale
//   (decimal comma), which is why a comma that is NOT consistent never wins.
import type { Problem } from './types';

export type CsvDelimiter = ',' | ';' | '\t' | '|';

export interface CsvParseOptions {
  delimiter?: CsvDelimiter | 'auto';
  /** Maximum number of records (header and preamble rows included) before parsing stops. */
  maxRows?: number;
  /**
   * 1-based physical line of the header record. Records before it are
   * preamble and exempt from the ragged check; records after it must have the
   * header's column count. Defaults to the first non-blank record.
   */
  headerRow?: number;
}

export interface CsvParseResult {
  delimiter: string;
  rows: string[][];
  /** 1-based physical line on which each record starts (parallel to `rows`). */
  lineNumbers: number[];
  truncated: boolean;
  problems: Problem[];
}

const CANDIDATES: CsvDelimiter[] = [',', ';', '\t', '|'];
const SAMPLE_RECORDS = 20;
const MAX_RAGGED_REPORTED = 50;

function countOutsideQuotes(line: string, d: string): number {
  let inQ = false;
  let n = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQ = !inQ;
    else if (!inQ && c === d) n++;
  }
  return n;
}

/** Splits the leading sample of the text into logical lines (quote-aware). */
function sampleLines(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < text.length && out.length < SAMPLE_RECORDS; i++) {
    const c = text[i];
    if (c === '"') inQ = !inQ;
    if (!inQ && (c === '\n' || c === '\r')) {
      if (c === '\r' && text[i + 1] === '\n') i++;
      if (cur.trim() !== '') out.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur.trim() !== '' && out.length < SAMPLE_RECORDS) out.push(cur);
  return out;
}

export function detectDelimiter(text: string): { delimiter: CsvDelimiter; problems: Problem[] } {
  const lines = sampleLines(text);
  const problems: Problem[] = [];
  if (lines.length === 0) return { delimiter: ',', problems };
  const counts = CANDIDATES.map((d) => lines.map((l) => countOutsideQuotes(l, d)));
  const consistent: Array<{ d: CsvDelimiter; n: number }> = [];
  CANDIDATES.forEach((d, i) => {
    const c = counts[i];
    if (c[0] > 0 && c.every((x) => x === c[0])) consistent.push({ d, n: c[0] });
  });
  if (consistent.length === 1) return { delimiter: consistent[0].d, problems };
  if (consistent.length > 1) {
    const top = Math.max(...consistent.map((c) => c.n));
    const winners = consistent.filter((c) => c.n === top);
    if (winners.length === 1) return { delimiter: winners[0].d, problems };
    problems.push({
      code: 'AMBIGUOUS_DELIMITER',
      message: `Cannot tell the delimiter: ${winners.map((w) => JSON.stringify(w.d)).join(' and ')} each split every row the same number of times. Choose the delimiter explicitly.`,
    });
    return { delimiter: ',', problems };
  }
  const header = CANDIDATES.map((d, i) => ({ d, n: counts[i][0] })).filter((x) => x.n > 0);
  if (header.length === 0) return { delimiter: ',', problems };
  header.sort((a, b) => b.n - a.n);
  problems.push({
    code: 'DELIMITER_INCONSISTENT',
    message: `No delimiter splits every row the same way; using ${JSON.stringify(header[0].d)} from the header row. Check for unquoted delimiters inside values.`,
  });
  return { delimiter: header[0].d, problems };
}

export function parseCsvText(text: string, opts: CsvParseOptions = {}): CsvParseResult {
  const problems: Problem[] = [];
  const maxRows = opts.maxRows ?? Number.POSITIVE_INFINITY;
  let delimiter: string;
  if (!opts.delimiter || opts.delimiter === 'auto') {
    const det = detectDelimiter(text);
    delimiter = det.delimiter;
    problems.push(...det.problems);
  } else delimiter = opts.delimiter;

  const rows: string[][] = [];
  const lineNumbers: number[] = [];
  let truncated = false;

  let field = '';
  let rec: string[] = [];
  let inQuotes = false;
  let wasQuoted = false; // current field began with a quote
  let afterClose = false; // just closed a quoted field; only delimiter/newline may follow
  let line = 1;
  let recStartLine = 1;
  let recQuoted = false;

  const endField = () => {
    rec.push(field);
    field = '';
    wasQuoted = false;
    afterClose = false;
  };
  const endRecord = (): boolean => {
    endField();
    const blank = rec.length === 1 && rec[0].trim() === '' && !recQuoted;
    if (!blank) {
      if (rows.length >= maxRows) {
        truncated = true;
        return false;
      }
      rows.push(rec);
      lineNumbers.push(recStartLine);
    }
    rec = [];
    recQuoted = false;
    return true;
  };

  let stopped = false;
  for (let i = 0; i < text.length && !stopped; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
          afterClose = true;
        }
      } else {
        if (c === '\n') line++;
        else if (c === '\r' && text[i + 1] !== '\n') line++;
        field += c;
      }
      continue;
    }
    if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      if (!endRecord()) stopped = true;
      line++;
      recStartLine = line;
      continue;
    }
    if (c === delimiter) {
      endField();
      continue;
    }
    if (c === '"') {
      if (field === '' && !wasQuoted && !afterClose) {
        inQuotes = true;
        wasQuoted = true;
        recQuoted = true;
      } else if (afterClose) {
        problems.push({ code: 'BAD_QUOTE', message: `Line ${line}: text follows a closing quote.`, rowNumber: recStartLine });
        field += c;
      } else {
        problems.push({ code: 'STRAY_QUOTE', message: `Line ${line}: a quote appears inside an unquoted value.`, rowNumber: recStartLine });
        field += c;
      }
      continue;
    }
    if (afterClose) {
      problems.push({ code: 'BAD_QUOTE', message: `Line ${line}: text follows a closing quote.`, rowNumber: recStartLine });
      afterClose = false;
    }
    field += c;
  }
  if (!stopped) {
    if (inQuotes) {
      problems.push({
        code: 'UNTERMINATED_QUOTE',
        message: `A quoted value that starts on line ${recStartLine} is never closed.`,
        rowNumber: recStartLine,
      });
    }
    endRecord();
  }
  if (truncated) {
    problems.push({
      code: 'TOO_MANY_ROWS',
      message: `The file has more than ${maxRows} rows; reading stopped at the limit.`,
    });
  }

  // Ragged-row detection against the header record.
  if (rows.length > 0) {
    let headerIdx = 0;
    if (opts.headerRow !== undefined) {
      headerIdx = lineNumbers.findIndex((l) => l >= opts.headerRow!);
    }
    if (headerIdx >= 0) {
      const width = rows[headerIdx].length;
      let reported = 0;
      let suppressed = 0;
      for (let r = headerIdx + 1; r < rows.length; r++) {
        if (rows[r].length !== width) {
          if (reported < MAX_RAGGED_REPORTED) {
            reported++;
            problems.push({
              code: 'RAGGED_ROW',
              message: `Row ${lineNumbers[r]} has ${rows[r].length} columns; the header has ${width}.`,
              rowNumber: lineNumbers[r],
            });
          } else suppressed++;
        }
      }
      if (suppressed > 0) {
        problems.push({ code: 'RAGGED_ROW', message: `${suppressed} further rows also have the wrong number of columns.` });
      }
    }
  }
  return { delimiter, rows, lineNumbers, truncated, problems };
}
