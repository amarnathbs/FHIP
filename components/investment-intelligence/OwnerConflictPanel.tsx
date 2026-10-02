'use client';

/**
 * Owner-before-upload (PO-OBU-05): folios of a CAS that are ALREADY filed under a
 * different owner than the one chosen at upload.
 *
 * This is deliberately NOT one indivisible "change all" action. Each affected folio
 * is listed with its own checkbox (all UNCHECKED by default), an optional "Select
 * all", the owner it has now and the explicit target owner, and nothing changes until
 * the user confirms the specific folios they ticked. The system never assumes every
 * folio on a statement shares the uploaded owner. Folios left unticked stay exactly
 * as they were.
 */

import { useState } from 'react';

export interface OwnerConflictRow {
  accountId: string;
  folioNumber: string | null;
  institutionName: string | null;
  existingOwner: string;
  selectedOwner: string;
}

export interface OwnerConflictPanelProps {
  conflicts: OwnerConflictRow[];
  /** The owner chosen at upload, as the user sees it. */
  targetLabel: string;
  busy: boolean;
  /** Called with ONLY the ticked folios after the explicit confirmation. */
  onConfirm: (accountIds: string[]) => void;
}

export function OwnerConflictPanel({ conflicts, targetLabel, busy, onConfirm }: OwnerConflictPanelProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const ticked = conflicts.filter((c) => selected.has(c.accountId));
  const allSelected = conflicts.length > 0 && ticked.length === conflicts.length;

  function toggle(id: string, on: boolean) {
    setConfirming(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  return (
    <div role="alert" className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="owner-conflicts">
      <p className="font-medium">
        {conflicts.length === 1 ? 'A folio on this statement is already filed under a different owner.' : `${conflicts.length} folios on this statement are already filed under a different owner.`}{' '}
        They were left exactly as they were. Choose which folios, if any, should move to {targetLabel}.
      </p>
      <div className="mt-1">
        <button
          type="button"
          className="underline"
          onClick={() => {
            setConfirming(false);
            setSelected(allSelected ? new Set() : new Set(conflicts.map((c) => c.accountId)));
          }}
          disabled={busy}
        >
          {allSelected ? 'Clear selection' : 'Select all'}
        </button>
      </div>
      <ul className="mt-1 space-y-1">
        {conflicts.map((c) => (
          <li key={c.accountId}>
            <label className="flex items-start gap-2">
              <input type="checkbox" checked={selected.has(c.accountId)} onChange={(e) => toggle(c.accountId, e.target.checked)} disabled={busy} />
              <span>
                {c.folioNumber ?? c.institutionName ?? 'Folio'}: now <strong>{c.existingOwner}</strong> → change to <strong>{targetLabel}</strong>
              </span>
            </label>
          </li>
        ))}
      </ul>
      {!confirming ? (
        <button
          type="button"
          disabled={busy || ticked.length === 0}
          onClick={() => setConfirming(true)}
          className="mt-2 rounded bg-gray-900 px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
        >
          {ticked.length === 0 ? 'Choose folios to change' : `Review change for ${ticked.length} folio${ticked.length === 1 ? '' : 's'}`}
        </button>
      ) : (
        <div className="mt-2 rounded border border-amber-400 bg-white px-2 py-2" data-testid="owner-conflicts-confirm">
          <p>
            You are about to change the owner of {ticked.length} folio{ticked.length === 1 ? '' : 's'} to <strong>{targetLabel}</strong>. The other {conflicts.length - ticked.length} stay as they are. Holdings and transactions are not changed — only who they are attributed to.
          </p>
          <div className="mt-1 flex gap-2">
            <button type="button" disabled={busy} onClick={() => onConfirm(ticked.map((c) => c.accountId))} className="rounded bg-gray-900 px-2 py-1 font-medium text-white disabled:opacity-50">
              {busy ? 'Changing…' : 'Confirm change'}
            </button>
            <button type="button" disabled={busy} onClick={() => setConfirming(false)} className="underline">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
