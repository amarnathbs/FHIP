'use client';

import { useEffect, useId, useRef } from 'react';

// Minimal, generic confirm/cancel modal — no confirm-dialog primitive existed
// anywhere in the app before this (verified: no Modal/Dialog component, no
// window.confirm() usage). Deliberately generic (title/message/labels, not
// sign-out-specific copy baked in) so it can be reused later for other
// destructive actions (goal deletion, row removal) without redoing this work.
//
// Admin A0.2 Wave 5 (§11 — focus management) fixed three real defects:
//   1. `aria-modal="true"` was declared but Tab could leave the dialog and
//      reach the page behind it, so keyboard and screen-reader users could
//      operate the very controls the dialog was blocking. A focus trap now
//      cycles Tab/Shift+Tab within the dialog.
//   2. Focus was never restored when the dialog closed — dismissing it
//      dropped the user at <body>, losing their place in a long list. The
//      element that opened the dialog is now refocused on close.
//   3. The element ids were hardcoded, so two dialogs mounted at once (the
//      content editors mount an unsaved-changes dialog AND a conflict
//      dialog simultaneously) produced duplicate ids and an ambiguous
//      accessible name. They are now per-instance via useId().
//
// `initialFocus` defaults to 'cancel' — for a destructive confirmation the
// safe choice, not the irreversible one, should hold focus (a stray Enter
// must never delete anything).

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  destructive = true,
  initialFocus = 'cancel',
  confirmDisabled = false,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  destructive?: boolean;
  initialFocus?: 'confirm' | 'cancel';
  confirmDisabled?: boolean;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const instanceId = useId();
  const titleId = `confirm-dialog-title-${instanceId}`;
  const messageId = `confirm-dialog-message-${instanceId}`;

  useEffect(() => {
    if (!open) return;

    // Remember where focus came from so it can be given back on close.
    const opener = document.activeElement;
    returnFocusRef.current = opener instanceof HTMLElement ? opener : null;

    const target = initialFocus === 'confirm' ? confirmRef.current : cancelRef.current;
    target?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onCancel();
        return;
      }
      if (e.key !== 'Tab') return;

      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      // Trap: Tab past the last control wraps to the first, and Shift+Tab
      // before the first wraps to the last. Also recovers focus if it has
      // already escaped the dialog for any reason.
      if (!panel.contains(active instanceof Node ? active : null)) {
        e.preventDefault();
        first.focus();
        return;
      }
      if (e.shiftKey && active === first) {
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
      // Restore focus to the opener, but only if it is still in the
      // document (a row action button can be unmounted by the very action
      // the dialog confirmed — in that case leave focus alone rather than
      // focusing a detached node).
      const opener2 = returnFocusRef.current;
      if (opener2 && document.contains(opener2)) opener2.focus();
    };
  }, [open, onCancel, initialFocus]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onCancel} aria-hidden="true" />
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        className="relative w-full max-w-sm rounded-card bg-white p-5 shadow-xl"
      >
        <h2 id={titleId} className="text-lg font-semibold text-ink">
          {title}
        </h2>
        <p id={messageId} className="mt-2 text-sm text-muted">
          {message}
        </p>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="min-h-11 rounded border border-line px-3 py-2 text-sm text-ink hover:bg-gray-50"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            disabled={confirmDisabled}
            aria-disabled={confirmDisabled}
            className={`min-h-11 rounded px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50 ${destructive ? 'bg-risk' : 'bg-trust'}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
