'use client';

/**
 * Presentation-only read of the signed-in user's import access, for the locked / unlocked Import UI.
 *
 * It asks the server (`GET /api/financial-data-hub/upload-status` -> `data.import_access`), which evaluates the
 * Premium entitlement itself. NOTHING here authorises anything: the value only decides what to DRAW, and every
 * upload / process API route re-checks the entitlement on its own. `null` means "not known yet" -- callers must
 * render a neutral state (never an active file picker) until it resolves, so a Free user never sees a working
 * picker flash up. There is deliberately no cache: a user who has just upgraded (or been downgraded) sees the
 * correct state the next time the control mounts, without logging out.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  accessViewFromDeniedBody,
  isFinancialImportDeniedBody,
  type FinancialImportAccessView,
} from './financialDataImportContract';

const UPLOAD_STATUS_URL = '/api/financial-data-hub/upload-status';

// Concurrent mounts on one page (the page's button and its panel) share ONE request; there is no cache after it settles.
let inflight: Promise<FinancialImportAccessView> | null = null;

export function parseImportAccess(json: unknown): FinancialImportAccessView {
  const raw = (json as { data?: { import_access?: unknown } } | null)?.data?.import_access;
  if (raw === 'allowed') return { state: 'allowed' };
  if (raw === 'premium_required') return { state: 'premium_required' };
  // Anything else -- unknown, missing, malformed -- is NOT "allowed": fail closed in what is drawn too.
  return { state: 'unavailable' };
}

function fetchImportAccess(): Promise<FinancialImportAccessView> {
  if (inflight) return inflight;
  const p = fetch(UPLOAD_STATUS_URL, { cache: 'no-store' })
    .then((res) => (res.ok ? res.json() : null))
    .then((json) => parseImportAccess(json))
    .catch((): FinancialImportAccessView => ({ state: 'unavailable' }))
    .finally(() => {
      inflight = null;
    });
  inflight = p;
  return p;
}

export function useFinancialImportAccess(): {
  access: FinancialImportAccessView | null;
  /** Feed any API response body in: if it is the unified Premium refusal, the UI switches to the locked state. */
  noteResponse: (json: unknown) => boolean;
} {
  const [access, setAccess] = useState<FinancialImportAccessView | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchImportAccess().then((view) => {
      if (!cancelled) setAccess(view);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const noteResponse = useCallback((json: unknown) => {
    if (!isFinancialImportDeniedBody(json)) return false;
    setAccess(accessViewFromDeniedBody(json));
    return true;
  }, []);

  return { access, noteResponse };
}
