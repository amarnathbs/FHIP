'use client';

import { useEffect, useRef } from 'react';

// Minimal, generic confirm/cancel modal — no confirm-dialog primitive existed
// anywhere in the app before this (verified: no Modal/Dialog component, no
// window.confirm() usage). Deliberately generic (title/message/labels, not
// sign-out-specific copy baked in) so it can be reused later for other
// destructive actions (goal deletion, row removal) without redoing this work.
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  destructive = true,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  destructive?: boolean;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    confirmRef.current?.focus();
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onCancel} aria-hidden="true" />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-message"
        className="relative w-full max-w-sm rounded-card bg-white p-5 shadow-xl"
      >
        <h2 id="confirm-dialog-title" className="text-lg font-semibold text-ink">
          {title}
        </h2>
        <p id="confirm-dialog-message" className="mt-2 text-sm text-muted">
          {message}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-line px-3 py-2 text-sm text-ink hover:bg-gray-50"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className={`rounded px-3 py-2 text-sm font-semibold text-white hover:opacity-90 ${destructive ? 'bg-risk' : 'bg-trust'}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
