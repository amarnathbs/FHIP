/**
 * What the shared grid keeps while a number is typed, and what a save sends for each configured field (PO report 17-10-2026, "there is no
 * way to edit the net salary").
 *
 * THE DEFECT. The grid's number inputs stored `Number(e.target.value)`, and `Number('') === 0`. Emptying the Net Amount (take-home) box
 * therefore left the draft at 0, the box showed "0", and Save sent `net_amount: 0` - an ENTERED take-home of nil. Emptying Tax per period
 * saved an entered tax of 0, which lib/engines/incomeNetBasis.ts reads as "no tax" (not as "unknown"). The user could change the figure but
 * never take it back to "blank", which is the only way to fall back to "gross minus tax" or to the assumed gross.
 *
 * THE RULE. A field declared `clearable` (lib/grid/types.ts) keeps '' while it is empty. On save:
 *   - a value is sent as typed;
 *   - an EMPTIED field, on a saved row where the field HAD a value, is sent as an explicit null (the column is nullable);
 *   - a field that was never filled is omitted (as before), so a save never names a column the database may not have yet.
 * Every other field keeps the previous behaviour exactly: `''`, null and undefined are omitted, a number input that is emptied becomes 0.
 *
 * Pure and client-safe so the grid and the tests share it.
 */
import type { GridConfig, GridFieldDef } from './types';

/** The draft value for a field after the user typed `raw`. */
export function gridInputValue(field: Pick<GridFieldDef, 'type' | 'clearable'>, raw: string): string | number {
  if (field.type !== 'number') return raw;
  if (raw === '' && field.clearable) return '';
  return Number(raw);
}

const isEmpty = (v: unknown): boolean => v === '' || v === null || v === undefined;

/**
 * The configured fields of a row as the request body carries them. `original` is the row as last saved (undefined for a row that was never
 * saved); `applicable` says whether a field applies to this row at all (a field hidden for the row is never sent).
 */
export function gridFieldBody(
  config: Pick<GridConfig, 'fields'>,
  row: Record<string, unknown>,
  ctx: { original: Record<string, unknown> | undefined; applicable: (fieldName: string) => boolean },
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const f of config.fields) {
    const value = row[f.name];
    if (!ctx.applicable(f.name)) {
      body[f.name] = undefined;
    } else if (f.clearable && value === '' && ctx.original && !isEmpty(ctx.original[f.name])) {
      body[f.name] = null;
    } else {
      body[f.name] = isEmpty(value) ? undefined : value;
    }
  }
  return body;
}
