'use client';

import { useId, useState } from 'react';

// Document2 (4) WP-B (F5/F6/F14): the one control that replaces every dead "enter the password and reprocess the stored
// document" path. Statement files are deleted shortly after processing, by design, so when something needs the file again the
// person uploads a replacement copy. It is attached to the SAME statement (no second document, nothing counted twice) and then
// processed with the ordinary, idempotent process call. See lib/services/investment-intelligence/sourceDocumentReplacement.ts.

export interface ReplacementOutcome {
  ok: boolean;
  message: string;
}

/** WP-H: the copy differs from the statement it would replace in ways a person may legitimately accept. Shown before anything is attached. */
export interface ReplacementConfirmationRequest {
  codes: string[];
  lines: string[];
  summary: string;
}

/**
 * Reads the server's "needs confirmation" answer (409 replacement_needs_confirmation). Pure, so the rule that ONLY confirmable
 * differences can ever be confirmed is tested without a browser: a rejection (a different statement) returns null here and is shown
 * as a plain refusal with no confirm button.
 */
export function readConfirmationRequest(status: number, body: { error?: string; identity?: { decision?: string; differences?: { code: string; severity: string; message: string }[]; candidateSummary?: string } }): ReplacementConfirmationRequest | null {
  if (status !== 409 || body?.error !== 'replacement_needs_confirmation') return null;
  const differences = (body.identity?.differences ?? []).filter((d) => d.severity === 'confirm');
  if (body.identity?.decision !== 'needs_confirmation' || differences.length === 0) return null;
  return { codes: differences.map((d) => d.code), lines: differences.map((d) => d.message), summary: body.identity?.candidateSummary ?? '' };
}

/** Turns the two API answers into one plain sentence. Pure, so the wording is tested without a browser. */
export function describeReplacementOutcome(step: 'attach' | 'process', body: { error?: string; message?: string; data?: { ok?: boolean; status?: string; error?: string | null } }, httpOk: boolean): ReplacementOutcome {
  if (step === 'attach') {
    if (httpOk) return { ok: true, message: 'Replacement copy attached. Processing it now.' };
    return { ok: false, message: body.message ?? body.error ?? 'The replacement copy could not be attached. Nothing was changed.' };
  }
  const data = body.data;
  if (httpOk && data?.ok) return { ok: true, message: 'Done. The replacement copy was processed against the same statement; no duplicate holdings or transactions were added.' };
  if (httpOk && data?.status === 'password_required') return { ok: false, message: 'The copy is attached but the password was missing or wrong. Enter the document password and try again.' };
  return { ok: false, message: data?.error ?? body.message ?? body.error ?? 'The copy was attached but could not be processed.' };
}

export function ReplacementCopyControl({
  documentId,
  needsPassword = true,
  compact = false,
  onDone,
}: {
  documentId: string;
  /** Show the optional document-password box (statements are often password-protected). */
  needsPassword?: boolean;
  /** Kept for existing callers. A replacement copy is always re-read (the process call below always forces a re-parse): serving the cached run of the OLD file would silently ignore the new copy. */
  forceReparse?: boolean;
  compact?: boolean;
  onDone?: () => void | Promise<void>;
}) {
  const fileId = useId();
  const passwordId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ReplacementOutcome | null>(null);
  const [confirmation, setConfirmation] = useState<ReplacementConfirmationRequest | null>(null);

  async function submit(e: React.FormEvent, confirmedCodes: string[] = []) {
    e.preventDefault();
    if (!file || busy) return; // duplicate-submission guard
    setBusy(true);
    setResult(null);
    let keepPassword = false;
    try {
      const attachOnce = async () => {
        const form = new FormData();
        form.append('file', file);
        // The password is only used by the server to read the copy for the "is this the same statement" check. It is not stored.
        if (password) form.append('password', password);
        if (confirmedCodes.length > 0) form.append('confirmDifferences', confirmedCodes.join(','));
        const res = await fetch(`/api/investment-intelligence/source-documents/${encodeURIComponent(documentId)}/replacement`, { method: 'POST', body: form });
        return { res, body: await res.json().catch(() => ({})) };
      };
      let { res: attach, body: attachBody } = await attachOnce();
      // The safety scan may still be running: wait calmly (bounded) rather than showing that as a failure.
      const scanDeadline = Date.now() + 120_000;
      while (attach.status === 409 && attachBody?.error === 'malware_scan_pending' && Date.now() < scanDeadline) {
        await new Promise((r) => setTimeout(r, 3000));
        ({ res: attach, body: attachBody } = await attachOnce());
      }
      const needs = readConfirmationRequest(attach.status, attachBody);
      if (needs) {
        // Nothing was attached. The file stays selected so the person can confirm or choose another one.
        setConfirmation(needs);
        keepPassword = true;
        setResult({ ok: false, message: 'This copy is different from the statement it would replace. Check the differences below.' });
        return;
      }
      setConfirmation(null);
      const attached = describeReplacementOutcome('attach', attachBody, attach.ok);
      if (!attached.ok) {
        setResult(attached);
        return;
      }
      setResult(attached);
      const processOnce = () =>
        fetch(`/api/investment-intelligence/source-documents/${encodeURIComponent(documentId)}/process`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: password || undefined, forceReparse: true }),
        });
      let res = await processOnce();
      let body = await res.json().catch(() => ({}));
      // The safety scan may still be running: wait calmly (bounded) rather than showing that as a failure.
      const deadline = Date.now() + 120_000;
      while (res.status === 409 && body?.error === 'malware_scan_pending' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 3000));
        res = await processOnce();
        body = await res.json().catch(() => ({}));
      }
      setResult(describeReplacementOutcome('process', body, res.ok));
      setFile(null);
      await onDone?.();
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : 'Something went wrong. Nothing was changed.' });
    } finally {
      setBusy(false);
      // The password is a live secret: never keep it in memory longer than the request that used it. (While a confirmation is pending it
      // is kept, because the confirmed request needs it again to read the same file.)
      if (!keepPassword) setPassword('');
    }
  }

  return (
    <form onSubmit={(e) => submit(e)} className={compact ? 'mt-1 flex flex-wrap items-center gap-2' : 'mt-2 flex flex-wrap items-end gap-3'} data-testid="replacement-copy-control">
      <div>
        <label htmlFor={fileId} className="block text-xs font-medium text-gray-600">
          Replacement copy (PDF)
        </label>
        <input id={fileId} type="file" accept=".pdf,application/pdf" disabled={busy} onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setConfirmation(null);
            setResult(null);
          }} className="mt-1 block text-xs" />
      </div>
      {needsPassword && (
        <div>
          <label htmlFor={passwordId} className="block text-xs font-medium text-gray-600">
            Document password (if it has one)
          </label>
          <input
            id={passwordId}
            type="password"
            autoComplete="off"
            value={password}
            disabled={busy}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 rounded border border-gray-300 px-2 py-1 text-xs"
          />
        </div>
      )}
      <button type="submit" disabled={!file || busy} className="rounded bg-gray-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
        {busy ? 'Uploading and processing…' : 'Upload replacement copy'}
      </button>
      {result && (
        <p role="status" aria-live="polite" className={`w-full text-xs ${result.ok ? 'text-green-700' : 'text-red-700'}`}>
          {result.message}
        </p>
      )}
      {confirmation && (
        <div className="w-full rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900" data-testid="replacement-confirmation">
          {confirmation.summary && <p className="mb-1">{confirmation.summary}</p>}
          <ul className="list-disc pl-4">
            {confirmation.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="mt-1">Nothing has been attached yet. Attach this copy only if it really is the same statement.</p>
          <div className="mt-2 flex gap-2">
            <button type="button" disabled={busy} onClick={(e) => submit(e, confirmation.codes)} className="rounded bg-gray-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
              Yes, this is the same statement. Attach this copy
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setConfirmation(null);
                setResult(null);
                setFile(null);
                setPassword('');
              }}
              className="rounded border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 disabled:opacity-50"
            >
              No, choose a different file
            </button>
          </div>
        </div>
      )}
    </form>
  );
}
