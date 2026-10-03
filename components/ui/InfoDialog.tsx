'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';

// A small content dialog for short explanations (a "what is this?" popup).
// ConfirmDialog is the action-confirmation sibling; this one has no confirm
// step, only a Close button, and takes arbitrary content (links, lists).
//
// It follows ConfirmDialog's accessibility conventions exactly, so the app has
// one behaviour for dialogs, not two:
//   - role="dialog" + aria-modal + aria-labelledby (title) + aria-describedby (body)
//   - a focus trap: Tab / Shift+Tab cycle inside the dialog
//   - Escape closes it
//   - focus goes to the Close button when it opens, and BACK to the element
//     that opened it when it closes (only if that element is still on the page)
//   - clicking the dimmed backdrop closes it
// Per-instance ids via useId(), so two can exist without clashing.

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function InfoDialog({
  open,
  title,
  onClose,
  closeLabel = 'Close',
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  closeLabel?: string;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const instanceId = useId();
  const titleId = `info-dialog-title-${instanceId}`;
  const bodyId = `info-dialog-body-${instanceId}`;

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement;
    returnFocusRef.current = opener instanceof HTMLElement ? opener : null;
    closeRef.current?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
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
      const opener2 = returnFocusRef.current;
      if (opener2 && document.contains(opener2)) opener2.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-card bg-white p-5 shadow-xl"
      >
        <h2 id={titleId} className="text-lg font-semibold text-ink">
          {title}
        </h2>
        <div id={bodyId} className="mt-3 text-sm text-ink">
          {children}
        </div>
        <div className="mt-5 flex justify-end">
          <button ref={closeRef} type="button" onClick={onClose} className="min-h-11 rounded border border-line px-3 py-2 text-sm text-ink hover:bg-gray-50">
            {closeLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
