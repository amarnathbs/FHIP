/**
 * SYNTHETIC bank CSV builders for the column-mapping tests (28-10-2026).
 *
 * `buildPoShapedCsv` has the SHAPE of the Product Owner's real export that production could not read: eleven columns (an account number, a
 * transaction type, two date columns written like "12:00am Tue 30 June, 2026", a reference, separate Debit amount and Credit amount
 * columns holding plain numbers, a running balance, a short and a long description and a cheque number), a byte-order mark, 342 data
 * rows. Every value is INVENTED here: the account number, the merchants, the amounts. Nothing is copied from the real file.
 */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const PO_SHAPED_HEADER = [
  'Account number',
  'Transaction type',
  'Effective date',
  'Create date',
  'Reference no',
  'Debit amount',
  'Credit amount',
  'Balance after transfer',
  'Description',
  'Long description',
  'Cheque number',
] as const;

/** "12:00am Tue 30 June, 2026" for a UTC day. */
export function poShapedDate(day: Date): string {
  return `12:00am ${WEEKDAYS[day.getUTCDay()]} ${day.getUTCDate()} ${MONTHS[day.getUTCMonth()]}, ${day.getUTCFullYear()}`;
}

export interface SyntheticRow {
  date: Date;
  description: string;
  longDescription: string;
  reference: string;
  /** Positive = money out. */
  debit: number;
  /** Positive = money in. */
  credit: number;
  balance: number;
}

/** `count` rows of invented activity, one or two a day from `start`, with a running balance that adds up. Deterministic per `seed`. */
export function syntheticRows(count: number, start = new Date(Date.UTC(2025, 6, 1)), seed = 1): SyntheticRow[] {
  const rows: SyntheticRow[] = [];
  let balance = 5000 + seed;
  for (let i = 0; i < count; i += 1) {
    const day = new Date(start.getTime() + Math.floor(i / 2) * 86_400_000);
    const isCredit = i % 7 === 3;
    const amount = isCredit ? 100 + ((i * 37 + seed) % 900) : 5 + ((i * 53 + seed) % 400) + (i % 4) * 0.25;
    balance = Math.round((balance + (isCredit ? amount : -amount)) * 100) / 100;
    rows.push({
      date: day,
      description: isCredit ? `SYNTH PAYER ${String(i).padStart(3, '0')}` : `SYNTH MERCHANT ${String(i).padStart(3, '0')}`,
      longDescription: `${isCredit ? 'Transfer in from' : 'Card purchase at'} Synthetic Merchant ${String(i).padStart(3, '0')} AUS`,
      reference: `SYN${String(seed).padStart(2, '0')}${String(i).padStart(6, '0')}`,
      debit: isCredit ? 0 : amount,
      credit: isCredit ? amount : 0,
      balance,
    });
  }
  return rows;
}

function quote(cell: string): string {
  return /[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

/**
 * The PO-shaped file, with a byte-order mark. `omit` drops columns by heading (to model a variant of the layout); `renames` changes a
 * heading. Both make the header a different one, so the importer no longer recognises it.
 */
export function buildPoShapedCsv(count = 342, seed = 1, opts: { omit?: string[]; renames?: Record<string, string> } = {}): { bytes: Uint8Array; text: string; rows: SyntheticRow[]; header: string[] } {
  const rows = syntheticRows(count, undefined, seed);
  const keep = PO_SHAPED_HEADER.map((h, i) => ({ h, i })).filter(({ h }) => !(opts.omit ?? []).includes(h));
  const header = keep.map(({ h }) => opts.renames?.[h] ?? h);
  const lines = [header.join(',')];
  for (const r of rows) {
    const cells = [
      '000000001234',
      r.credit > 0 ? 'Credit' : 'Debit',
      poShapedDate(r.date),
      poShapedDate(new Date(r.date.getTime() + 86_400_000)),
      r.reference,
      String(r.debit),
      String(r.credit),
      r.balance.toFixed(2),
      r.description,
      r.longDescription,
      '',
    ];
    lines.push(keep.map(({ i }) => quote(cells[i])).join(','));
  }
  const text = `${lines.join('\r\n')}\r\n`;
  return { bytes: new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from(text, 'utf-8')]), text, rows, header };
}

/** A header the importer does not recognise: the PO-shaped file without its "Transaction type" column (a variant of the layout). */
export const UNRECOGNISED_VARIANT: { omit: string[] } = { omit: ['Transaction type'] };

/** dd/mm/yyyy for a UTC day. */
const ddmmyyyy = (d: Date) => `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;

export type ShapeKind = 'debit_credit' | 'single_signed' | 'indicator';

/**
 * A file with ANY header names and column order, for the "any bank" tests: the named date, description, amount columns plus `extraColumns`
 * unrelated columns before, between and after them (so 25+ columns are possible). Dates are dd/mm/yyyy.
 */
export function buildCustomCsv(opts: {
  count: number;
  shape: ShapeKind;
  names: { date: string; description: string; amount?: string; debit?: string; credit?: string; indicator?: string; balance?: string };
  extraColumns?: number;
  reverse?: boolean;
}): { bytes: Uint8Array; rows: SyntheticRow[]; header: string[] } {
  const rows = syntheticRows(opts.count, undefined, 3);
  const core: string[] = [opts.names.date, opts.names.description];
  if (opts.shape === 'debit_credit') core.push(opts.names.debit as string, opts.names.credit as string);
  else if (opts.shape === 'single_signed') core.push(opts.names.amount as string);
  else core.push(opts.names.amount as string, opts.names.indicator as string);
  if (opts.names.balance) core.push(opts.names.balance);
  const extras = Array.from({ length: opts.extraColumns ?? 0 }, (_, i) => `Extra field ${i + 1}`);
  let header = [...extras.slice(0, Math.floor(extras.length / 2)), ...core, ...extras.slice(Math.floor(extras.length / 2))];
  if (opts.reverse) header = [...header].reverse();
  const valueFor = (name: string, r: SyntheticRow, i: number): string => {
    if (name === opts.names.date) return ddmmyyyy(r.date);
    if (name === opts.names.description) return r.description;
    if (name === opts.names.debit) return r.debit > 0 ? String(r.debit) : '';
    if (name === opts.names.credit) return r.credit > 0 ? String(r.credit) : '';
    if (name === opts.names.amount) return opts.shape === 'single_signed' ? String(r.credit > 0 ? r.credit : -r.debit) : String(r.credit > 0 ? r.credit : r.debit);
    if (name === opts.names.indicator) return r.credit > 0 ? 'CR' : 'DR';
    if (name === opts.names.balance) return r.balance.toFixed(2);
    return `x${i}`;
  };
  const lines = [header.join(',')];
  rows.forEach((r, i) => lines.push(header.map((h) => quote(valueFor(h, r, i))).join(',')));
  return { bytes: new Uint8Array(Buffer.from(`${lines.join('\n')}\n`, 'utf-8')), rows, header };
}
