'use client';

// PO review F3 (06/10/2026) — "There is delete button here or in the next
// screen after view. Need to add delete button".
//
// One shared control for deleting a NEVER-PUBLISHED draft, used by the All
// Content list (and the other queue lists), the read-only content detail page
// and every content editor. It always asks first (a confirmation dialog that
// names the item and what will be removed), then calls the DELETE route. The
// route re-checks the capability, the never-published rule and writes the
// audit event; this component never decides authorisation on its own, it
// only decides whether to SHOW the control (the caller passes `canDelete`
// from a server-resolved capability).

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';

const DELETABLE = ['idea', 'draft'];

export function isDeletableDraftStatus(status: string, publishedAt: string | null | undefined): boolean {
  return DELETABLE.includes(status) && !publishedAt;
}

export function DeleteDraftButton({
  postId,
  title,
  status,
  publishedAt,
  canDelete,
  onDeleted,
  redirectTo,
  className,
  label = 'Delete',
}: {
  postId: string;
  title: string;
  status: string;
  publishedAt?: string | null;
  canDelete: boolean;
  onDeleted?: () => void;
  redirectTo?: string;
  className?: string;
  label?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cancel = useCallback(() => {
    if (!busy) setOpen(false);
  }, [busy]);

  const confirm = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/resources/content/${postId}`, { method: 'DELETE' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error ?? 'Could not delete this draft.');
        setBusy(false);
        setOpen(false);
        return;
      }
      setBusy(false);
      setOpen(false);
      onDeleted?.();
      if (redirectTo) router.push(redirectTo);
      else router.refresh();
    } catch {
      setError('Could not reach the server. Nothing was deleted.');
      setBusy(false);
      setOpen(false);
    }
  }, [postId, onDeleted, redirectTo, router]);

  if (!canDelete || !isDeletableDraftStatus(status, publishedAt)) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
        aria-label={`Delete draft "${title}"`}
        className={className ?? 'inline-flex min-h-11 items-center rounded-full border border-risk/40 px-3 py-1.5 text-sm font-semibold text-risk hover:bg-risk/5'}
      >
        {label}
      </button>
      <ConfirmDialog
        open={open}
        title="Delete this draft?"
        message={`"${title || 'Untitled'}" has never been published. Deleting it permanently removes the draft, its saved versions and its links to categories, tags, related content and context. This cannot be undone. Published content is never deleted this way. The deletion is recorded in the audit log.`}
        confirmLabel={busy ? 'Deleting…' : 'Delete draft'}
        cancelLabel="Keep draft"
        destructive
        confirmDisabled={busy}
        onConfirm={() => void confirm()}
        onCancel={cancel}
      />
      {error && (
        <p role="alert" className="mt-1 text-xs text-risk">
          {error}
        </p>
      )}
    </>
  );
}
