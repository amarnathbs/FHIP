/**
 * Compact row builder for the registry files. Pure; imports only types.
 *
 *   rows('bank_csv', 'ts_interface', 'fdh:bank-csv/normalize.ts#NormalizedTransactionCandidate', [
 *     ['amountOriginal', B, 'fdh_transactions.amount_original', 'Category review'],
 *     ['postedDate', C, 'evidence:fdh_transactions.posting_date', null, gap('EXP-G14', 'P2', 'WP-08')],
 *   ])
 *
 * A row with a gap is `open_gap`; `notActive` marks a flow with no user path.
 */
import type { AdapterId, Disposition, FieldDispositionEntry, Severity, SourceKind } from './types';

export const A: Disposition = 'A_STATE';
export const B: Disposition = 'B_EVENT';
export const C: Disposition = 'C_EVIDENCE';
export const D: Disposition = 'D_METADATA';
export const E: Disposition = 'E_UNSUPPORTED';

export interface GapRef {
  gapId: string;
  severity: Severity;
  ownerWp: string;
}

export function gap(gapId: string, severity: Severity, ownerWp: string): GapRef {
  return { gapId, severity, ownerWp };
}

export type Row = [field: string, disposition: Disposition, destination: string, userVisibleAt?: string | null, gapRef?: GapRef | null, economicMeaning?: string];

export function rows(
  adapter: AdapterId,
  sourceKind: SourceKind,
  sourceRef: string,
  list: readonly Row[],
  options: { notActive?: boolean } = {},
): FieldDispositionEntry[] {
  return list.map(([field, disposition, destination, userVisibleAt = null, gapRef = null, economicMeaning]) => ({
    adapter,
    sourceKind,
    sourceRef,
    field,
    disposition,
    destination,
    userVisibleAt: userVisibleAt ?? null,
    ...(economicMeaning ? { economicMeaning } : {}),
    status: options.notActive ? 'not_active' : gapRef ? 'open_gap' : 'compliant',
    ...(gapRef ? { gapId: gapRef.gapId, severity: gapRef.severity, ownerWp: gapRef.ownerWp } : {}),
  }));
}

/** Technical metadata columns shared by every evidence table. */
export function technical(fields: readonly string[], destinationPrefix: string): Row[] {
  return fields.map((f) => [f, D, `${destinationPrefix}.${f}`] as Row);
}
