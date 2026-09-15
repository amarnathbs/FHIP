'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { PC5_DISCARD_REASONS, type Pc5DiscardReason } from '@/lib/pc5/discard';
import { PC5_TOTAL_BASIS_POINTS, defaultEqualAllocation, formatBasisPoints } from '@/lib/pc5/jointAllocation';
import type { Pc5AllocationEntry, Pc5CorrectionOverlayView, Pc5ResolutionItemView } from '@/lib/pc5/types';

/**
 * PC5 (M4) — the resolution context screen. K.9's mismatch disclosure,
 * K.5/K.6's owner choice and allocation editor, K.10's duplicate
 * confirmation, K.11's discard, K.12's correction overlay.
 *
 * ================================================================
 * THE ONE THING THIS SCREEN MUST NOT DO
 * ================================================================
 * It must not offer to show the user their "original" masked value.
 *
 * That is not a design preference. The Product Owner decided on 2026-09-15
 * in favour of global invariant D.6 — keyed one-way HMAC pseudonyms, never
 * reversible — and Phase 4 implemented it by DELETING the reversible token
 * map rather than disabling it: `lib/aie/masking/tokenMapCrypto.ts` is gone
 * from the repository, `persistMaskTokenMap` is gone, and
 * `aie_mask_token_map` has had no writer since. Even with full database
 * access and every flag on, recovering an original would mean breaking
 * HMAC-SHA256.
 *
 * So the masked form is shown, and the screen SAYS PLAINLY that it cannot
 * be turned back. A "reveal" control would be worse than useless here: it
 * would always fail, and its presence would imply the capability exists and
 * is merely switched off.
 *
 * NO FREE-TEXT FINANCIAL INPUT ANYWHERE. K.9 forbids letting a user type a
 * balancing number into canonical truth, so the only numeric input on this
 * screen is an ownership PERCENTAGE — which is not a financial value at
 * all: it attributes a figure that already exists and can never change it.
 * Every other answer is a selection from a server-supplied closed set.
 */

interface ItemContextResponse {
  item: Pc5ResolutionItemView;
  overlay: Pc5CorrectionOverlayView[];
  runStatus: string | null;
  amendment: { path: string; guidance: string };
  links: { passwordUnlock: string; aieRunReview: string };
}

function newIdempotencyKey(itemId: string, action: string, version: number): string {
  // Stable for a given (item, action, version) so a double-click or a retry
  // after a dropped response lands on the SAME `aie_review_decision` unique
  // key and is absorbed as an idempotent replay rather than creating a
  // second decision. Deliberately NOT random per click (CONC-03).
  return `pc5:${itemId}:${action}:${version}`;
}

export function ResolutionDetailClient({ itemId }: { itemId: string }) {
  const [data, setData] = useState<ItemContextResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [chosenValue, setChosenValue] = useState<string>('');
  const [allocation, setAllocation] = useState<Pc5AllocationEntry[]>([]);
  const [iiAccountId, setIiAccountId] = useState<string>('');
  const [discardReason, setDiscardReason] = useState<Pc5DiscardReason>('wrong_person');
  const [showDiscard, setShowDiscard] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/pc5/resolutions/${encodeURIComponent(itemId)}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not load this question');
      setData(json.data as ItemContextResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load this question');
    } finally {
      setLoading(false);
    }
  }, [itemId]);

  useEffect(() => {
    void load();
  }, [load]);

  const choiceField = data?.item.choiceField ?? null;
  const selectedOption = useMemo(() => choiceField?.options.find((o) => o.value === chosenValue) ?? null, [choiceField, chosenValue]);
  const allocationRequired = selectedOption?.requiresAllocation === true;

  // Pre-fill K.6's equal default the moment a joint option is chosen, from
  // the SAME pure function the server validates against — so what the user
  // sees pre-filled and what the server would accept cannot diverge.
  useEffect(() => {
    if (!allocationRequired || !choiceField) {
      setAllocation([]);
      return;
    }
    const owners = choiceField.options.filter((o) => !o.requiresAllocation).slice(0, 2).map((o) => ({ ownerMemberId: o.value }));
    setAllocation(defaultEqualAllocation(owners));
  }, [allocationRequired, choiceField]);

  const allocationTotal = allocation.reduce((sum, e) => sum + (Number.isFinite(e.basisPoints) ? e.basisPoints : 0), 0);

  async function submitDecision(action: 'choose_value' | 'acknowledge' | 'dismiss') {
    if (!data) return;
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/pc5/resolutions/${encodeURIComponent(itemId)}/decide`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action,
          itemVersion: data.item.itemVersion,
          idempotencyKey: newIdempotencyKey(itemId, action, data.item.itemVersion),
          chosenValue: action === 'choose_value' ? chosenValue : undefined,
          allocation: allocationRequired ? allocation : undefined,
          iiAccountId: allocationRequired ? iiAccountId || undefined : undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not record your answer');

      const rr = json.data.reReconciliation;
      if (action !== 'choose_value') {
        // K.13, in the confirmation copy as well as in the data model.
        setNotice('Recorded that you have seen this. It still needs a decision before the statement can be imported.');
      } else if (rr?.ran && rr.openBlockingItemCount === 0) {
        setNotice('Answer recorded and the statement re-checked — nothing else is outstanding on it.');
      } else if (rr?.ran) {
        setNotice(`Answer recorded and the statement re-checked. ${rr.openBlockingItemCount} question(s) still outstanding.`);
      } else {
        // Honest about the difference: the decision landed, the re-check
        // did not. Saying "resolved" here would be the exact masquerade
        // K.13 prohibits.
        setNotice('Answer recorded. We could not re-check the statement just now, so this stays open until we can.');
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not record your answer');
    } finally {
      setSubmitting(false);
    }
  }

  async function submitDiscard() {
    if (!data) return;
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/pc5/runs/${encodeURIComponent(data.item.runId)}/discard`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: discardReason }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not discard this statement');
      setNotice(
        json.data.binary === 'deleted'
          ? 'Statement discarded and the original file deleted. Nothing from it was added to your portfolio.'
          : 'Statement discarded. The original file is queued for deletion and will be removed shortly.',
      );
      setShowDiscard(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not discard this statement');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading && !data) return <p className="text-sm text-muted">Loading…</p>;
  if (error && !data) {
    return (
      <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-900">
        {error}
      </div>
    );
  }
  if (!data) return null;

  const { item, overlay } = data;
  const canChoose = item.permittedPc5Actions.includes('choose_value');
  const canAcknowledge = item.permittedPc5Actions.includes('acknowledge');
  const canDismiss = item.permittedPc5Actions.includes('dismiss');

  return (
    <div className="space-y-6">
      <section className="rounded-md border border-slate-200 bg-white p-5">
        <h2 className="text-lg font-semibold text-ink">{item.humanQuestion}</h2>
        <p className="mt-2 text-sm text-muted">{item.explanation}</p>

        {item.displayCandidate ? (
          <div className="mt-4 rounded-md bg-slate-50 p-3">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">On the statement</p>
            <p className="mt-1 font-mono text-sm text-ink">{item.displayCandidate}</p>
            {/* The hard UX constraint from Phase 4, stated rather than
                implied. No reveal control exists because no reveal path
                exists. */}
            <p className="mt-2 text-xs text-muted">
              This value is shown in a masked form. Masking here is one-way, so the original cannot be shown again — not by you and not by us.
            </p>
          </div>
        ) : null}
      </section>

      {error ? (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-900">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div role="status" className="rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
          {notice}
        </div>
      ) : null}

      {/* ---------- K.5 / K.6 / K.9 / K.10 — the decision itself ---------- */}
      {choiceField ? (
        <section className="rounded-md border border-slate-200 bg-white p-5">
          <h3 className="text-base font-semibold text-ink">{choiceField.label}</h3>
          {choiceField.unresolvableReason ? (
            <p className="mt-2 text-sm text-muted">{choiceField.unresolvableReason}</p>
          ) : (
            <>
              <fieldset className="mt-3 space-y-2">
                <legend className="sr-only">{choiceField.label}</legend>
                {choiceField.options.map((opt) => (
                  <label key={opt.value} className="flex cursor-pointer items-start gap-3 rounded-md border border-slate-200 p-3 hover:bg-slate-50">
                    <input
                      type="radio"
                      name="pc5-choice"
                      value={opt.value}
                      checked={chosenValue === opt.value}
                      onChange={() => setChosenValue(opt.value)}
                      className="mt-1"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-ink">{opt.label}</span>
                      {opt.detail ? <span className="mt-0.5 block text-xs text-muted">{opt.detail}</span> : null}
                    </span>
                  </label>
                ))}
              </fieldset>

              {allocationRequired ? (
                <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-4">
                  <h4 className="text-sm font-semibold text-ink">Who owns which share?</h4>
                  <p className="mt-1 text-xs text-muted">
                    These holdings are still counted once in your net worth. This only records who owns which share of them, so reports attribute the position
                    correctly. The shares must add up to 100%.
                  </p>
                  <div className="mt-3 space-y-2">
                    {allocation.map((entry, idx) => {
                      const label = choiceField.options.find((o) => o.value === (entry.ownerMemberId ?? entry.ownerBusinessEntityId))?.label ?? 'Owner';
                      return (
                        <div key={entry.ownerMemberId ?? entry.ownerBusinessEntityId ?? idx} className="flex items-center gap-3">
                          <span className="min-w-0 flex-1 truncate text-sm text-ink">{label}</span>
                          <label className="flex items-center gap-2 text-sm">
                            <span className="sr-only">{`${label} share, percent`}</span>
                            <input
                              type="number"
                              min={0.01}
                              max={100}
                              step={0.01}
                              value={(entry.basisPoints / 100).toFixed(2)}
                              onChange={(e) => {
                                const pct = Number(e.target.value);
                                const bp = Math.round(pct * 100);
                                setAllocation((prev) => prev.map((p, i) => (i === idx ? { ...p, basisPoints: bp } : p)));
                              }}
                              className="w-24 rounded border border-slate-300 px-2 py-1 text-right"
                            />
                            <span className="text-muted">%</span>
                          </label>
                        </div>
                      );
                    })}
                  </div>
                  <p className={`mt-3 text-xs ${allocationTotal === PC5_TOTAL_BASIS_POINTS ? 'text-muted' : 'text-red-700'}`}>
                    Total: {formatBasisPoints(allocationTotal)}
                    {allocationTotal === PC5_TOTAL_BASIS_POINTS ? '' : ' — the shares must add up to exactly 100%.'}
                  </p>
                  <label className="mt-3 block text-sm">
                    <span className="block text-xs font-medium text-ink">Account this applies to</span>
                    <input
                      type="text"
                      value={iiAccountId}
                      onChange={(e) => setIiAccountId(e.target.value)}
                      placeholder="Account id"
                      className="mt-1 w-full rounded border border-slate-300 px-2 py-1 font-mono text-xs"
                    />
                  </label>
                </div>
              ) : null}

              <div className="mt-4 flex flex-wrap gap-3">
                <button
                  type="button"
                  disabled={!canChoose || submitting || !chosenValue || (allocationRequired && allocationTotal !== PC5_TOTAL_BASIS_POINTS)}
                  onClick={() => void submitDecision('choose_value')}
                  className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                  {submitting ? 'Saving…' : 'Save this answer'}
                </button>
              </div>
            </>
          )}
        </section>
      ) : null}

      {/* ---------- K.13 — acknowledge / dismiss, clearly NOT resolution --- */}
      <section className="rounded-md border border-slate-200 bg-white p-5">
        <h3 className="text-base font-semibold text-ink">Not ready to decide?</h3>
        <p className="mt-1 text-sm text-muted">
          You can note that you have seen this. That does not fix it — the statement still cannot be imported until the question is answered.
        </p>
        <div className="mt-3 flex flex-wrap gap-3">
          <button
            type="button"
            disabled={!canAcknowledge || submitting}
            onClick={() => void submitDecision('acknowledge')}
            className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-ink disabled:opacity-50"
          >
            I have seen this
          </button>
          {canDismiss ? (
            <button
              type="button"
              disabled={submitting}
              onClick={() => void submitDecision('dismiss')}
              className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-ink disabled:opacity-50"
            >
              Hide this from my list
            </button>
          ) : (
            <p className="self-center text-xs text-muted">This one cannot be hidden — it blocks importing the statement.</p>
          )}
        </div>
      </section>

      {/* ---------- K.11 — wrong statement --------------------------------- */}
      <section className="rounded-md border border-slate-200 bg-white p-5">
        <h3 className="text-base font-semibold text-ink">This statement is not mine</h3>
        <p className="mt-1 text-sm text-muted">
          Discarding deletes the original file and records that a statement was discarded. Nothing already in your portfolio is affected.
        </p>
        {showDiscard ? (
          <div className="mt-3 space-y-3">
            <label className="block text-sm">
              <span className="block text-xs font-medium text-ink">Why are you discarding it?</span>
              <select
                value={discardReason}
                onChange={(e) => setDiscardReason(e.target.value as Pc5DiscardReason)}
                className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm"
              >
                {PC5_DISCARD_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {DISCARD_REASON_LABEL[r]}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex gap-3">
              <button
                type="button"
                disabled={submitting}
                onClick={() => void submitDiscard()}
                className="rounded-md bg-red-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                Discard this statement
              </button>
              <button type="button" onClick={() => setShowDiscard(false)} className="rounded-md border border-slate-300 px-4 py-2 text-sm text-ink">
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button type="button" onClick={() => setShowDiscard(true)} className="mt-3 rounded-md border border-red-300 px-4 py-2 text-sm font-medium text-red-800">
            Discard this statement…
          </button>
        )}
      </section>

      {/* ---------- K.18 — what can and cannot be changed now -------------- */}
      <section className="rounded-md border border-slate-200 bg-slate-50 p-5">
        <h3 className="text-base font-semibold text-ink">Changing your mind later</h3>
        <p className="mt-1 text-sm text-muted">{data.amendment.guidance}</p>
      </section>

      {/* ---------- K.12 — the correction overlay -------------------------- */}
      {overlay.length > 0 ? (
        <section className="rounded-md border border-slate-200 bg-white p-5">
          <h3 className="text-base font-semibold text-ink">What has been decided on this so far</h3>
          <ul className="mt-3 space-y-3">
            {overlay.map((o, i) => (
              <li key={`${o.decidedAt}-${i}`} className="border-l-2 border-slate-200 pl-3 text-sm">
                <p className="text-ink">
                  <strong>{DECISION_LABEL[o.decisionType] ?? o.decisionType}</strong>
                  {o.userValue ? <> — {o.userValue}</> : null}
                </p>
                <p className="mt-0.5 text-xs text-muted">
                  {new Date(o.decidedAt).toLocaleString()}
                  {o.parserVersionAtDecision ? ` · reader version ${o.parserVersionAtDecision}` : ''}
                  {o.resultingReconciliationAt ? ' · statement re-checked afterwards' : ' · statement not re-checked'}
                </p>
                {o.originalValueMasked ? (
                  <p className="mt-0.5 text-xs text-muted">
                    Replaced: <span className="font-mono">{o.originalValueMasked}</span> (masked; cannot be shown unmasked)
                  </p>
                ) : null}
                {o.reason ? <p className="mt-0.5 text-xs text-muted">Reason given: {o.reason}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="text-sm">
        <Link href={data.links.aieRunReview} className="text-brand underline">
          See everything we read from this statement
        </Link>
      </p>
    </div>
  );
}

const DISCARD_REASON_LABEL: Record<Pc5DiscardReason, string> = {
  wrong_person: 'It belongs to someone outside my household',
  wrong_household: 'It belongs to a different household',
  wrong_account: 'It is for an account that is not mine',
  uploaded_in_error: 'I uploaded it by mistake',
  other: 'Another reason',
};

const DECISION_LABEL: Record<string, string> = {
  pc5_choose_value: 'You chose',
  pc5_acknowledge: 'You noted you had seen this',
  pc5_dismiss: 'You hid this from your list',
  correct: 'You corrected a value',
  not_present: 'You said this is not on the document',
  defer: 'You deferred this',
  auto_resolved_by_revalidation: 'Re-checked automatically — no longer an issue',
  superseded_by_revalidation: 'Replaced after a re-check',
};
