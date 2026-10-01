'use client';

/**
 * Owner-before-upload (Phase 1) -- "Who does this document belong to?"
 *
 * One shared control for every upload form. The user answers BEFORE the file is
 * sent, so there is no after-upload ownership review. It calls
 * `onChange(selection)` only when the answer is complete and valid (a joint
 * split that adds up to exactly 100%, a real person / entity chosen), and
 * `onChange(null)` otherwise -- so a form can simply disable its Upload button
 * while the value is null.
 *
 * What it offers comes from GET /api/ownership/options, resolved server-side
 * for THIS user and flow (Self is created on first use; HUF appears only for
 * India accounts; SMSF only for Australian accounts in a flow that allows it;
 * a Company or Trust appears only if the user created one). The server
 * re-validates the choice on upload -- this component is a convenience, not a
 * gate.
 *
 * Joint: percentages are shown and edited as PERCENT; the selection carries
 * basis points. Where a flow does not use percentages (bank statements) the
 * joint choice is just "Joint".
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { OwnerOptionsPayload } from '@/lib/ownership/ownerOptions';
import { evaluateJointDraft, withEqualSplit, type JointDraftRow } from '@/lib/ownership/jointDraft';
import type { OwnerFlow, OwnerSelection } from '@/lib/ownership/ownerSelection';

const RELATIONSHIPS: Array<{ value: string; label: string }> = [
  { value: 'spouse', label: 'Spouse' },
  { value: 'partner', label: 'Partner' },
  { value: 'child', label: 'Child' },
  { value: 'parent', label: 'Parent' },
  { value: 'other_dependant', label: 'Other dependant' },
  { value: 'other', label: 'Other' },
];

/** The <select> value for a selection. */
function choiceOf(value: OwnerSelection | null): string {
  if (!value) return '';
  if (value.kind === 'member') return `member:${value.memberId}`;
  if (value.kind === 'entity') return `entity:${value.entityId}`;
  return value.kind;
}

export interface OwnerSelectorProps {
  flow: OwnerFlow;
  value: OwnerSelection | null;
  onChange: (selection: OwnerSelection | null) => void;
  disabled?: boolean;
  /** Prefix for element ids, so two selectors on a page never collide. */
  idPrefix?: string;
  /** Server-rendered previews and tests only: skip the fetch and start from
   * these options (and, optionally, an already-made joint entry). */
  preview?: { options: OwnerOptionsPayload; jointRows?: JointDraftRow[] };
}

export function OwnerSelector({ flow, value, onChange, disabled = false, idPrefix = 'owner', preview }: OwnerSelectorProps) {
  const [options, setOptions] = useState<OwnerOptionsPayload | null>(preview?.options ?? null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [choice, setChoice] = useState<string>(choiceOf(value));
  const [rows, setRows] = useState<JointDraftRow[]>(preview?.jointRows ?? []);
  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newRelationship, setNewRelationship] = useState('spouse');
  const [saving, setSaving] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/ownership/options?flow=${flow}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.message ?? json.error ?? 'Could not load the list of owners.');
      setOptions(json.data as OwnerOptionsPayload);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load the list of owners.');
    }
  }, [flow]);

  useEffect(() => {
    if (!preview) void load();
  }, [load, preview]);

  // The joint candidates: every member and entity this flow offers.
  const candidates = useMemo(() => {
    if (!options) return [] as Array<{ key: string; label: string; detail: string }>;
    return [
      ...options.members.map((m) => ({ key: `member:${m.id}`, label: m.label, detail: m.detail })),
      ...options.entities.map((e) => ({ key: `entity:${e.id}`, label: e.label, detail: e.detail })),
    ];
  }, [options]);

  // Keep the row set aligned with the candidates (keeping what the user typed).
  useEffect(() => {
    setRows((prev) => candidates.map((c) => prev.find((r) => r.key === c.key) ?? { key: c.key, checked: false, percentText: '' }));
  }, [candidates]);

  const emitJoint = useCallback(
    (next: JointDraftRow[]) => {
      const result = evaluateJointDraft(next);
      onChange(result.ok ? result.selection : null);
    },
    [onChange],
  );

  function handleChoice(next: string) {
    setChoice(next);
    if (next === '') return onChange(null);
    if (next.startsWith('member:')) return onChange({ kind: 'member', memberId: next.slice('member:'.length) });
    if (next.startsWith('entity:')) return onChange({ kind: 'entity', entityId: next.slice('entity:'.length) });
    if (next === 'smsf') return onChange({ kind: 'smsf' });
    if (next === 'joint') {
      if (options && !options.joint.requiresPercentages) return onChange({ kind: 'joint' });
      emitJoint(rows);
      return;
    }
    onChange(null);
  }

  function toggleRow(key: string, checked: boolean) {
    const toggled = rows.map((r) => (r.key === key ? { ...r, checked } : r));
    const next = withEqualSplit(toggled);
    setRows(next);
    emitJoint(next);
  }

  function editPercent(key: string, percentText: string) {
    const next = rows.map((r) => (r.key === key ? { ...r, percentText } : r));
    setRows(next);
    emitJoint(next);
  }

  async function addMember() {
    if (!newName.trim()) return;
    setSaving(true);
    setAddError(null);
    try {
      const res = await fetch('/api/household-members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ full_name: newName.trim(), relationship: newRelationship }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.message ?? json.error ?? 'Could not add this person.');
      setNewName('');
      setAddOpen(false);
      await load();
      // Select the person just added, if this flow can carry them.
      const id = json.data?.id as string | undefined;
      if (id) {
        setChoice(`member:${id}`);
        onChange({ kind: 'member', memberId: id });
      }
    } catch (e) {
      setAddError(e instanceof Error ? e.message : 'Could not add this person.');
    } finally {
      setSaving(false);
    }
  }

  // A bank statement can only be owned by a spouse/partner besides you, so
  // offering "child" there would add a person who then cannot be chosen.
  const relationships = flow === 'bank' ? RELATIONSHIPS.filter((r) => r.value === 'spouse' || r.value === 'partner') : RELATIONSHIPS;
  const jointDraft = useMemo(() => evaluateJointDraft(rows), [rows]);
  const showPercentages = choice === 'joint' && options?.joint.requiresPercentages === true;
  const selectId = `${idPrefix}-select`;
  const helpId = `${idPrefix}-help`;

  return (
    <div className="block text-sm" data-testid="owner-selector">
      <label htmlFor={selectId} className="mb-1 block text-muted">
        Who does this document belong to?
      </label>
      <select
        id={selectId}
        className="w-full rounded border border-gray-300 px-3 py-2"
        value={choice}
        disabled={disabled || !options}
        onChange={(e) => handleChoice(e.target.value)}
        aria-describedby={helpId}
        aria-required="true"
      >
        <option value="">{options ? 'Choose one' : 'Loading…'}</option>
        {options && options.members.length > 0 && (
          <optgroup label="People">
            {options.members.map((m) => (
              <option key={m.id} value={`member:${m.id}`}>
                {m.detail === 'You' ? `${m.label} (you)` : `${m.label} (${m.detail.toLowerCase()})`}
              </option>
            ))}
          </optgroup>
        )}
        {options && options.entities.length > 0 && (
          <optgroup label="Trusts, HUFs and companies">
            {options.entities.map((e) => (
              <option key={e.id} value={`entity:${e.id}`}>
                {e.label} ({e.detail.toLowerCase()})
              </option>
            ))}
          </optgroup>
        )}
        {options?.joint.available && <option value="joint">Joint — shared between owners</option>}
        {options?.smsf.available && <option value="smsf">My SMSF</option>}
      </select>

      <span id={helpId} className="mt-1 block text-xs text-muted">
        {flow === 'bank'
          ? 'Joint accounts count in full to your household. An SMSF’s transactions are kept with the fund, not your household spending.'
          : 'Every holding on this statement is filed under the owner you choose. You can adjust a single folio later.'}
        {options?.entityNotice ? ` ${options.entityNotice}` : ''}
      </span>

      {loadError && (
        <p className="mt-1 rounded bg-amber-50 px-3 py-2 text-xs text-amber-900" role="alert">
          {loadError}
        </p>
      )}

      {showPercentages && (
        <fieldset className="mt-3 rounded border border-gray-200 p-3" aria-describedby={`${idPrefix}-joint-help`}>
          <legend className="px-1 text-xs font-medium text-gray-600">Who owns it, and how much each?</legend>
          <ul className="space-y-2">
            {candidates.map((c) => {
              const row = rows.find((r) => r.key === c.key);
              return (
                <li key={c.key} className="flex flex-wrap items-center gap-3">
                  <label className="flex min-w-[10rem] items-center gap-2">
                    <input
                      type="checkbox"
                      checked={row?.checked ?? false}
                      disabled={disabled}
                      onChange={(e) => toggleRow(c.key, e.target.checked)}
                    />
                    <span>
                      {c.label} <span className="text-xs text-muted">({c.detail.toLowerCase()})</span>
                    </span>
                  </label>
                  {row?.checked && (
                    <label className="flex items-center gap-1">
                      <span className="sr-only">Share for {c.label}, percent</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        className="w-20 rounded border border-gray-300 px-2 py-1 text-right"
                        value={row.percentText}
                        disabled={disabled}
                        onChange={(e) => editPercent(c.key, e.target.value)}
                      />
                      <span aria-hidden="true">%</span>
                    </label>
                  )}
                </li>
              );
            })}
          </ul>
          <p id={`${idPrefix}-joint-help`} className={`mt-2 text-xs ${jointDraft.ok ? 'text-muted' : 'text-amber-800'}`} role={jointDraft.ok ? undefined : 'status'}>
            {jointDraft.ok
              ? 'Shares add up to 100%.'
              : jointDraft.message}
          </p>
        </fieldset>
      )}

      {choice === 'joint' && options && !options.joint.requiresPercentages && (
        <p className="mt-2 text-xs text-muted">Percentage shares are not used for bank statements — a joint account counts in full to your household.</p>
      )}

      <div className="mt-2">
        {!addOpen ? (
          <button type="button" className="text-xs text-gray-600 underline" onClick={() => setAddOpen(true)} disabled={disabled}>
            Add a household member (e.g. your spouse)
          </button>
        ) : (
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs">
              <span className="mb-1 block text-muted">Full name</span>
              <input
                type="text"
                className="rounded border border-gray-300 px-2 py-1 text-sm"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
            </label>
            <label className="text-xs">
              <span className="mb-1 block text-muted">Relationship</span>
              <select className="rounded border border-gray-300 px-2 py-1 text-sm" value={newRelationship} onChange={(e) => setNewRelationship(e.target.value)}>
                {relationships.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="rounded bg-gray-900 px-2 py-1 text-xs font-medium text-white disabled:opacity-50" onClick={addMember} disabled={!newName.trim() || saving}>
              {saving ? 'Saving…' : 'Save person'}
            </button>
            <button type="button" className="text-xs text-gray-500 underline" onClick={() => setAddOpen(false)}>
              Cancel
            </button>
            {addError && (
              <p className="w-full text-xs text-amber-900" role="alert">
                {addError}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
