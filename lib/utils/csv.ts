// Minimal RFC4180-ish CSV parser: handles quoted fields, escaped quotes
// ("" inside a quoted field), commas and newlines inside quotes. Used both
// by the one-off data-import script and the admin CSV-upload API route, so
// the two paths can never silently disagree on how a file is read.
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/^﻿/, ''); // strip BOM if present

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\r') {
      // skip — \n (or end of input) below closes the row
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const nonEmptyRows = rows.filter((r) => !(r.length === 1 && r[0] === ''));
  if (nonEmptyRows.length === 0) return [];
  const header = nonEmptyRows[0];
  return nonEmptyRows.slice(1).map((cells) => {
    const obj: Record<string, string> = {};
    header.forEach((h, i) => {
      obj[h.trim()] = cells[i] ?? '';
    });
    return obj;
  });
}

export function splitList(value: string | undefined | null): string[] {
  if (!value || value.trim() === '') return [];
  return value
    .split(';')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}
