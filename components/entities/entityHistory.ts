// One chronological list for the entity "Show history" panel (DEV browser certification 26-10-2026): the two sources (how the entity is
// recorded, and changes to its lines) used to be printed as two separate blocks, so a line retired by an Undo appeared BELOW the older
// switch it undid. This merges them newest first; at the same instant the recording-mode row comes first (it explains the line changes).
export interface HistoryModeRow { id: string; action: string; net_before: number | null; net_after: number | null; created_at: string }
export interface HistoryChangeRow { id: string; table_name: string; action: string; created_at: string }
export type HistoryEntry = { kind: 'mode'; row: HistoryModeRow } | { kind: 'change'; row: HistoryChangeRow };

export function mergeEntityHistory(modes: HistoryModeRow[], changes: HistoryChangeRow[], maxChanges = 30): HistoryEntry[] {
  const entries: HistoryEntry[] = [
    ...modes.map((row) => ({ kind: 'mode' as const, row })),
    ...changes.slice(0, maxChanges).map((row) => ({ kind: 'change' as const, row })),
  ];
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      const ta = Date.parse(a.e.row.created_at);
      const tb = Date.parse(b.e.row.created_at);
      if (tb !== ta) return tb - ta;
      if (a.e.kind !== b.e.kind) return a.e.kind === 'mode' ? -1 : 1;
      return a.i - b.i;
    })
    .map((x) => x.e);
}
