'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  JOINT_CHOICE,
  MAX_JOINT_OWNERS,
  apiErrorMessage,
  describeOwnerChange,
  equalSplitRows,
  evaluateJointDraft,
  formatPercent,
  nextOwnershipView,
  ownerKeyOf,
  selectionFromChoice,
  type JointRowDraft,
  type OwnerOptionsPayload,
  type OwnerSelectionBody,
} from './ownerChange';

// Investment Intelligence -- change an account's owner (2026-10-01).
//
// One dialog, used from BOTH the Review tab (resolving an open owner exception
// or a joint-holding case) and the Resolutions tab (amending a decision that
// was already made). The caller supplies `submit`, which is the only thing
// that differs: Review PATCHes /accounts/[id]/owner, Resolutions POSTs
// /resolutions/[caseId]/amend. Both send the same `{ owner, confirm: true }`.
//
// Two steps, deliberately: (1) choose the owner -- a household member, a
// trust / HUF / company, or a joint split with percentages; (2) an explicit
// confirmation that shows current -> new owner and the consequences in plain
// words. Nothing is saved until the second step's button is pressed, and the
// server refuses a request that does not say `confirm: true`.
//
// The options and the "current owner" come from the server
// (GET /accounts/[id]/owner), which has already removed anything this user
// may not pick (an HUF unless they are confirmed in India, inactive members).
// All percentage/validation logic is in ownerChange.ts (pure, unit-tested);
// the server re-validates everything and is the authority.
//
// Accessibility follows components/ui/ConfirmDialog.tsx and
// TransactionDetailModal.tsx: role="dialog", aria-modal, focus trap,
// Escape closes, focus returns to the opener.

const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export type OwnerSubmitResult = { ok: true; message?: string } | { ok: false; error: string };

export interface OwnerChangeDialogProps {
  accountId: string;
  /** Readable account name, e.g. "12345678 · Example AMC". Never a raw uuid. */
  accountLabel: string | null;
  mode: 'review' | 'amend';
  /** A joint-holding case can only be resolved with a joint split. */
  jointOnly?: boolean;
  /** Household members the statement itself named (from the case evidence), pre-filled as an equal split the user can edit. */
  suggestedJointMemberIds?: string[];
  /** The masked holder text the statement printed, shown as a hint only. */
  holderHint?: string | null;
  submit: (owner: OwnerSelectionBody) => Promise<OwnerSubmitResult>;
  onClose: () => void;
  onDone: () => void;
  /** Test / static-render hooks. When `preloaded` is given the dialog does not fetch. */
  preloaded?: OwnerOptionsPayload;
  initialChoice?: string;
  initialJointRows?: JointRowDraft[];
  initialStep?: 'choose' | 'confirm';
}

let rowCounter = 0;
const nextRowId = () => `joint-row-${(rowCounter += 1)}`;

export function OwnerChangeDialog(props: OwnerChangeDialogProps) {
  const { accountId, accountLabel, mode, jointOnly = false, suggestedJointMemberIds = [], holderHint = null, submit, onClose, onDone } = props;
  const [payload, setPayload] = useState<OwnerOptionsPayload | null>(props.preloaded ?? null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState<'choose' | 'confirm'>(props.initialStep ?? 'choose');
  const [choice, setChoice] = useState<string>(props.initialChoice ?? (jointOnly ? JOINT_CHOICE : ''));
  // `null` until the user edits: the rows shown are then DERIVED (the statement's
  // named members split equally, else two empty lines) rather than set from an effect.
  const [editedJointRows, setEditedJointRows] = useState<JointRowDraft[] | null>(props.initialJointRows ?? null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const instanceId = useId();
  const titleId = `owner-dialog-title-${instanceId}`;

  const requestClose = useCallback(() => {
    if (!submitting) onClose();
  }, [submitting, onClose]);

  // Load the user's owner options + the account's current owner from the server.
  useEffect(() => {
    if (props.preloaded) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/investment-intelligence/accounts/${encodeURIComponent(accountId)}/owner`);
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) throw new Error(apiErrorMessage(json, 'Could not load the owner options.'));
        setPayload(json.data as OwnerOptionsPayload);
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Could not load the owner options.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, props.preloaded]);

  // Focus: first control on open, trap Tab, Escape closes, focus returns to the opener.
  useEffect(() => {
    const opener = document.activeElement;
    returnFocusRef.current = opener instanceof HTMLElement ? opener : null;
    panelRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        requestClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!panel.contains(active instanceof Node ? active : null)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const o = returnFocusRef.current;
      if (o && document.contains(o)) o.focus();
    };
  }, [requestClose]);

  const options = useMemo(() => payload?.options ?? [], [payload]);
  const members = options.filter((o) => o.kind === 'member');
  const entities = options.filter((o) => o.kind === 'entity');
  // Joint mode starts with the statement's own named members split equally
  // (K.6's default), or two empty lines. Never saved until the user confirms.
  const suggestedKey = suggestedJointMemberIds.join(',');
  const defaultJointRows = useMemo<JointRowDraft[]>(() => {
    const known = new Set(options.map(ownerKeyOf));
    const suggested = (suggestedKey ? suggestedKey.split(',') : []).map((id) => `m:${id}`).filter((k) => known.has(k));
    if (suggested.length >= 2) return equalSplitRows(suggested, 'suggested');
    return [
      { rowId: 'blank-0', ownerKey: '', percentText: '' },
      { rowId: 'blank-1', ownerKey: '', percentText: '' },
    ];
  }, [options, suggestedKey]);
  const jointRows = editedJointRows ?? defaultJointRows;
  const setJointRows = (rows: JointRowDraft[]) => setEditedJointRows(rows);
  const { selection, problems } = useMemo(() => selectionFromChoice(choice, jointRows), [choice, jointRows]);
  const jointEval = useMemo(() => evaluateJointDraft(jointRows), [jointRows]);
  const nextView = useMemo(() => nextOwnershipView(selection, options), [selection, options]);
  const description = useMemo(
    () => (payload && nextView ? describeOwnerChange({ current: payload.current, next: nextView, published: payload.published, amend: mode === 'amend' }) : null),
    [payload, nextView, mode]
  );

  const usedKeys = new Set(jointRows.map((r) => r.ownerKey).filter(Boolean));
  const total = jointEval.totalBasisPoints;

  function updateRow(rowId: string, patch: Partial<JointRowDraft>) {
    setJointRows(jointRows.map((r) => (r.rowId === rowId ? { ...r, ...patch } : r)));
  }

  async function confirm() {
    if (!selection) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await submit(selection);
      if (!result.ok) {
        setSubmitError(result.error);
        return;
      }
      onDone();
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : 'Could not save the owner change.');
    } finally {
      setSubmitting(false);
    }
  }

  const title = step === 'confirm' ? 'Confirm the owner change' : mode === 'amend' ? 'Amend the owner' : jointOnly ? 'Split ownership between owners' : 'Choose the owner';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={requestClose} aria-hidden="true" />
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} className="relative max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-card bg-white p-5 shadow-xl">
        <h2 id={titleId} className="text-lg font-semibold text-ink">
          {title}
        </h2>
        {accountLabel && <p className="mt-1 text-sm text-muted">{accountLabel}</p>}

        {!payload && !loadError && <p className="mt-4 text-sm text-muted">Loading…</p>}
        {loadError && <p className="mt-4 text-sm text-red-600">{loadError}</p>}

        {payload && step === 'choose' && (
          <div className="mt-4">
            <p className="text-sm text-ink">
              <span className="text-muted">Current owner: </span>
              <strong>{describeOwnerChange({ current: payload.current, next: payload.current, published: false, amend: false }).currentSummary}</strong>
            </p>
            {holderHint && <p className="mt-1 text-xs text-muted">The statement is printed in the name of {holderHint}.</p>}
            {jointOnly && (
              <p className="mt-2 rounded-compact bg-amber-50 p-2 text-xs text-amber-900">
                This statement prints a joint holding, so it can only be resolved by saying who owns it and what share each owner has. The shares must add up to exactly 100%.
              </p>
            )}

            <fieldset className="mt-4">
              <legend className="text-sm font-medium text-ink">{jointOnly ? 'Owners and shares' : 'Who owns this account?'}</legend>

              {!jointOnly && (
                <div className="mt-2 space-y-3">
                  <div>
                    <p className="text-xs uppercase tracking-wide text-muted">People in your household</p>
                    <ul className="mt-1 space-y-1">
                      {members.map((o) => (
                        <li key={ownerKeyOf(o)}>
                          <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-compact border border-line px-3 py-2 text-sm hover:bg-gray-50">
                            <input type="radio" name={`owner-choice-${instanceId}`} value={ownerKeyOf(o)} checked={choice === ownerKeyOf(o)} onChange={() => setChoice(ownerKeyOf(o))} />
                            <span className="text-ink">{o.label}</span>
                            <span className="text-xs text-muted">{o.detail}</span>
                          </label>
                        </li>
                      ))}
                      {members.length === 0 && <li className="text-xs text-muted">No active household members.</li>}
                    </ul>
                  </div>

                  <div>
                    <p className="text-xs uppercase tracking-wide text-muted">Trusts, HUFs and companies</p>
                    <ul className="mt-1 space-y-1">
                      {entities.map((o) => (
                        <li key={ownerKeyOf(o)}>
                          <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-compact border border-line px-3 py-2 text-sm hover:bg-gray-50">
                            <input type="radio" name={`owner-choice-${instanceId}`} value={ownerKeyOf(o)} checked={choice === ownerKeyOf(o)} onChange={() => setChoice(ownerKeyOf(o))} />
                            <span className="text-ink">{o.label}</span>
                            <span className="text-xs text-muted">{o.detail}</span>
                          </label>
                        </li>
                      ))}
                      {entities.length === 0 && (
                        <li className="text-xs text-muted">
                          You have no trust, HUF or company set up yet.{' '}
                          <Link href="/companies" className="font-medium text-primary hover:underline">
                            Add one first
                          </Link>
                          , then come back to assign this account to it.
                        </li>
                      )}
                    </ul>
                  </div>

                  {payload.jointAvailable && (
                    <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-compact border border-line px-3 py-2 text-sm hover:bg-gray-50">
                      <input type="radio" name={`owner-choice-${instanceId}`} value={JOINT_CHOICE} checked={choice === JOINT_CHOICE} onChange={() => setChoice(JOINT_CHOICE)} />
                      <span className="text-ink">Jointly owned</span>
                      <span className="text-xs text-muted">split between two or more owners, with percentages</span>
                    </label>
                  )}
                </div>
              )}

              {choice === JOINT_CHOICE && options.length < 2 && (
                <p className="mt-3 text-xs text-amber-800">
                  A joint split needs at least two owners to choose from. Add another household member, or a trust, HUF or company under{' '}
                  <Link href="/companies" className="font-medium text-primary hover:underline">
                    Companies
                  </Link>
                  .
                </p>
              )}
              {choice === JOINT_CHOICE && (
                <div className="mt-3 rounded-compact border border-line p-3" aria-live="polite">
                  <ul className="space-y-2">
                    {jointRows.map((row, i) => (
                      <li key={row.rowId} className="flex flex-wrap items-center gap-2">
                        <label className="sr-only" htmlFor={`joint-owner-${row.rowId}`}>
                          Owner {i + 1}
                        </label>
                        <select
                          id={`joint-owner-${row.rowId}`}
                          className="min-h-11 min-w-0 flex-1 rounded-compact border border-line px-2 py-1 text-sm"
                          value={row.ownerKey}
                          onChange={(e) => updateRow(row.rowId, { ownerKey: e.target.value })}
                        >
                          <option value="">Choose an owner</option>
                          {options.map((o) => (
                            <option key={ownerKeyOf(o)} value={ownerKeyOf(o)} disabled={usedKeys.has(ownerKeyOf(o)) && row.ownerKey !== ownerKeyOf(o)}>
                              {o.label} ({o.detail})
                            </option>
                          ))}
                        </select>
                        <label className="sr-only" htmlFor={`joint-pct-${row.rowId}`}>
                          Share of owner {i + 1}, percent
                        </label>
                        <div className="flex items-center gap-1">
                          <input
                            id={`joint-pct-${row.rowId}`}
                            inputMode="decimal"
                            className="min-h-11 w-24 rounded-compact border border-line px-2 py-1 text-right text-sm"
                            placeholder="0"
                            value={row.percentText}
                            onChange={(e) => updateRow(row.rowId, { percentText: e.target.value })}
                          />
                          <span className="text-sm text-muted">%</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => setJointRows(jointRows.filter((r) => r.rowId !== row.rowId))}
                          disabled={jointRows.length <= 2}
                          className="min-h-11 rounded-compact border border-line px-2 py-1 text-xs text-muted disabled:opacity-40"
                          aria-label={`Remove owner ${i + 1}`}
                        >
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setJointRows([...jointRows, { rowId: nextRowId(), ownerKey: '', percentText: '' }])}
                      disabled={jointRows.length >= Math.min(MAX_JOINT_OWNERS, options.length)}
                      className="min-h-11 rounded-compact border border-line px-3 py-1 text-xs font-medium text-primary disabled:opacity-40"
                    >
                      Add an owner
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const keys = jointRows.map((r) => r.ownerKey).filter(Boolean);
                        if (keys.length >= 2) setJointRows(equalSplitRows(keys, 'eq').map((r) => ({ ...r, rowId: nextRowId() })));
                      }}
                      disabled={jointRows.filter((r) => r.ownerKey).length < 2}
                      className="min-h-11 rounded-compact border border-line px-3 py-1 text-xs text-muted disabled:opacity-40"
                    >
                      Split equally
                    </button>
                    <p className={`ml-auto text-sm font-medium ${total === 10000 ? 'text-positive' : 'text-attention'}`} data-testid="joint-total">
                      Total: {formatPercent(total)} {total === 10000 ? '— adds up to 100%' : `— ${total < 10000 ? `${formatPercent(10000 - total)} still to assign` : `${formatPercent(total - 10000)} over`}`}
                    </p>
                  </div>
                  {jointEval.problems.length > 0 && jointRows.some((r) => r.ownerKey || r.percentText) && (
                    <ul className="mt-2 list-disc pl-5 text-xs text-red-700">
                      {jointEval.problems.map((p) => (
                        <li key={p}>{p}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </fieldset>

            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button type="button" onClick={requestClose} className="min-h-11 rounded border border-line px-3 py-2 text-sm text-ink hover:bg-gray-50">
                Cancel
              </button>
              <button
                type="button"
                onClick={() => setStep('confirm')}
                disabled={!selection || !nextView}
                title={!selection && problems.length > 0 ? problems[0] : undefined}
                className="min-h-11 rounded bg-trust px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
              >
                Review change
              </button>
            </div>
          </div>
        )}

        {payload && step === 'confirm' && description && (
          <div className="mt-4">
            <p className="text-sm font-medium text-ink">Please confirm this change</p>
            <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_auto_1fr] sm:items-stretch">
              <div className="rounded-compact border border-line p-3">
                <p className="text-xs uppercase tracking-wide text-muted">Current owner</p>
                {description.currentLines.length === 0 ? (
                  <p className="mt-1 text-sm text-ink">No owner recorded yet</p>
                ) : (
                  <ul className="mt-1 space-y-0.5 text-sm text-ink">
                    {description.currentLines.map((l) => (
                      <li key={l.label}>
                        {l.label}
                        {l.percent ? <span className="text-muted"> — {l.percent}</span> : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="hidden items-center justify-center text-muted sm:flex" aria-hidden="true">
                →
              </div>
              <div className="rounded-compact border-2 border-primary p-3">
                <p className="text-xs uppercase tracking-wide text-muted">New owner</p>
                <ul className="mt-1 space-y-0.5 text-sm text-ink">
                  {description.nextLines.map((l) => (
                    <li key={l.label}>
                      <strong>{l.label}</strong> <span className="text-xs text-muted">{l.detail}</span>
                      {l.percent ? <span className="text-muted"> — {l.percent}</span> : null}
                    </li>
                  ))}
                </ul>
                {description.nextTotal && <p className="mt-1 text-xs font-medium text-positive">Total {description.nextTotal}</p>}
              </div>
            </div>

            {description.sameAsCurrent && <p className="mt-2 text-xs text-muted">This is the same owner as today. Confirming records your decision without changing the account.</p>}

            <p className="mt-3 text-xs font-medium uppercase tracking-wide text-muted">What this means</p>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-ink">
              {description.consequences.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>

            {submitError && (
              <p role="alert" className="mt-3 text-sm text-red-600">
                {submitError}
              </p>
            )}

            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button type="button" onClick={() => setStep('choose')} disabled={submitting} className="min-h-11 rounded border border-line px-3 py-2 text-sm text-ink hover:bg-gray-50 disabled:opacity-50">
                Back
              </button>
              <button
                type="button"
                onClick={() => void confirm()}
                disabled={submitting || description.blockedUntilUnpublished}
                className="min-h-11 rounded bg-trust px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
              >
                {submitting ? 'Saving…' : 'Confirm owner change'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
