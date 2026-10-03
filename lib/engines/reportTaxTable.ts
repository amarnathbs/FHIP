// Tax & Cost Intelligence chapter - the disposal table the Monthly Report shows.
// Pure (no DB, no clock). One place decides what each cell says so the on-screen
// report, the print view and the tests cannot drift:
//   * Instrument: the real fund NAME, never the internal instrument key/id. A fund
//     whose name was not stored (an older saved report) reads "Fund name not recorded".
//   * Disposal date: day-first through formatDateShort. The tax engine is India's
//     (Income-tax Act capital gains), so the date style is India's dd-mm-yyyy
//     whatever the report's own reporting currency is.
//   * Taxable gain: formatted in INR. The amounts are rupee amounts; they must
//     never take the report currency's symbol (an AUD report once showed them as "$").
import { formatDateShort } from '@/lib/engines/date';
import { formatMoneyWhole } from '@/lib/engines/money';

export interface TaxDisposalLike {
  instrumentKey?: string;
  instrumentName?: string;
  disposalDate: string;
  classification: string;
  taxableGain: number;
}

export interface TaxTableRow {
  instrument: string;
  disposalDate: string;
  classification: string;
  taxableGain: string;
}

export const TAX_TABLE_MAX_ROWS = 20;
export const TAX_INSTRUMENT_NAME_MISSING = 'Fund name not recorded';

function looksLikeInternalId(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.trim());
}

export function taxTableRows(disposals: readonly TaxDisposalLike[], instrumentNames: Readonly<Record<string, string>> | null | undefined): TaxTableRow[] {
  const names = instrumentNames ?? {};
  return disposals.slice(0, TAX_TABLE_MAX_ROWS).map((d) => {
    const raw = (d.instrumentName ?? (d.instrumentKey ? names[d.instrumentKey] : undefined) ?? '').trim();
    return {
      instrument: raw && !looksLikeInternalId(raw) ? raw : TAX_INSTRUMENT_NAME_MISSING,
      disposalDate: formatDateShort(d.disposalDate, 'INR'),
      classification: String(d.classification).replace(/_/g, ' '),
      taxableGain: formatMoneyWhole(Number(d.taxableGain ?? 0), 'INR'),
    };
  });
}
