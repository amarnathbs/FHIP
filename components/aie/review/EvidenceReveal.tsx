'use client';

import { useEffect, useRef, useState } from 'react';

const MASK_TOKEN_SHAPE = /^\[MASKED:[a-z_]+:[a-z]+:[0-9a-z]+\]$/i;

/** AIE15-MASK-01..12: masked-by-default display value, with an explicit,
 * one-at-a-time, audited reveal (server-side: `POST .../reveal`,
 * `lib/aie/review/reveal.ts`) and automatic remasking after 20 seconds or
 * on unmount (MASK-07). Only renders a Reveal control at all for a value
 * that actually looks like a reversible mask token — anything else (e.g.
 * Insurance's own irreversibly partial-masked policy number) is shown
 * as-is, with no false promise of a reveal that cannot succeed. */
export function EvidenceValue({ runId, value }: { runId: string; value: string | null }) {
  const [revealed, setRevealed] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    },
    [],
  );

  if (value === null) return <span className="text-muted">Not found</span>;
  const isRevealableToken = MASK_TOKEN_SHAPE.test(value);

  async function reveal() {
    setRevealing(true);
    setError(null);
    try {
      const res = await fetch(`/api/aie/review/runs/${runId}/reveal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: value }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body?.message ?? 'Could not reveal this value.');
        return;
      }
      setRevealed(body.data.value);
      // MASK-07: automatically remask after 20 seconds of inactivity.
      timeoutRef.current = setTimeout(() => setRevealed(null), 20_000);
    } catch {
      setError('Could not reach the server.');
    } finally {
      setRevealing(false);
    }
  }

  if (!isRevealableToken) return <span>{value}</span>;

  if (revealed !== null) {
    return (
      <span className="inline-flex items-center gap-2">
        <span className="font-mono">{revealed}</span>
        <button
          type="button"
          onClick={() => {
            if (timeoutRef.current) clearTimeout(timeoutRef.current);
            setRevealed(null);
          }}
          className="min-h-11 text-xs font-semibold text-trust hover:underline"
        >
          Hide
        </button>
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-2">
      <span aria-label="Hidden value">••••••</span>
      <button type="button" onClick={reveal} disabled={revealing} aria-disabled={revealing} className="min-h-11 text-xs font-semibold text-trust hover:underline disabled:opacity-50">
        {revealing ? 'Revealing…' : 'Reveal'}
      </button>
      {error && (
        <span role="alert" className="text-xs text-risk">
          {error}
        </span>
      )}
    </span>
  );
}
