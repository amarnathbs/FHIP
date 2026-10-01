'use client';

// In-app expiry notice for time-limited Premium (admin grant or promo code).
//
// The repository has no existing notification/banner mechanism (searched
// components/ and the app shell: only a static admin status line), so this is a
// small dismissible banner rendered by app/(app)/layout.tsx. The decision of
// WHETHER and WHAT to show is made on the server by computeEntitlementReminder()
// for the signed-in user's own row; this component only displays what it is given.
// Dismissal is remembered per notice key ("expiring_7:<end date>"), so crossing the
// next threshold (30 -> 7 days) or lapsing shows a fresh notice. Browser storage is
// an optional convenience: if it is unavailable the notice simply stays visible.

import { useSyncExternalStore } from 'react';
import Link from 'next/link';

interface Props {
  noticeKey: string;
  kind: 'expiring_30' | 'expiring_7' | 'lapsed';
  title: string;
  message: string;
}

const STORAGE_PREFIX = 'fhip.premiumNotice.dismissed:';
const DISMISS_EVENT = 'fhip-premium-notice-dismissed';

function subscribe(onChange: () => void) {
  window.addEventListener('storage', onChange);
  window.addEventListener(DISMISS_EVENT, onChange);
  return () => {
    window.removeEventListener('storage', onChange);
    window.removeEventListener(DISMISS_EVENT, onChange);
  };
}

// In-memory fallback so Dismiss still works for this page view when browser storage is blocked.
const dismissedInMemory = new Set<string>();

function readDismissed(noticeKey: string): boolean {
  if (dismissedInMemory.has(noticeKey)) return true;
  try {
    return window.localStorage.getItem(STORAGE_PREFIX + noticeKey) === '1';
  } catch {
    return false; // storage unavailable: keep showing
  }
}

export function PremiumAccessNotice({ noticeKey, kind, title, message }: Props) {
  // Server render and hydration both start from "not dismissed"; the browser value is read through
  // useSyncExternalStore (no setState inside an effect).
  const dismissed = useSyncExternalStore(
    subscribe,
    () => readDismissed(noticeKey),
    () => false
  );

  if (dismissed) return null;

  const urgent = kind === 'expiring_7' || kind === 'lapsed';
  return (
    <div
      role="status"
      className={`mb-4 flex flex-wrap items-start justify-between gap-3 rounded-card border p-3 text-sm ${urgent ? 'border-risk/40 bg-risk/5' : 'border-trust/30 bg-trust/5'}`}
    >
      <div className="max-w-3xl">
        <p className="font-medium text-ink">{title}</p>
        <p className="mt-1 text-muted">{message}</p>
        <p className="mt-2 flex flex-wrap gap-3">
          <Link href="/profile" className="font-medium text-trust hover:underline">
            View plan options
          </Link>
          <Link href="/contact" className="font-medium text-trust hover:underline">
            Contact FHIP support
          </Link>
        </p>
      </div>
      <button
        type="button"
        onClick={() => {
          dismissedInMemory.add(noticeKey);
          try {
            window.localStorage.setItem(STORAGE_PREFIX + noticeKey, '1');
          } catch {
            /* ignore: the notice simply reappears next time */
          }
          window.dispatchEvent(new Event(DISMISS_EVENT));
        }}
        className="text-xs text-gray-500 hover:underline"
      >
        Dismiss
      </button>
    </div>
  );
}
