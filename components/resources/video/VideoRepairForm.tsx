'use client';

// PO review F12 — replaces the dead end "This video record is missing its
// YouTube details and cannot be edited safely. Contact a Resource
// Administrator." with a way forward.
//
// These records are the video SCRIPTS the content import created without a
// YouTube video (the source data had no real YouTube IDs, and none was
// invented). The form asks for the real YouTube URL or video ID and creates
// the one missing record for THIS existing item. It never replaces the video
// of an item that already has one: the server refuses in that case.

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { readJsonSafely } from '@/lib/resources/admin/resultState';

export function VideoRepairForm({ postId, title, contentId, canRepair }: { postId: string; title: string; contentId: string | null; canRepair: boolean }) {
  const router = useRouter();
  const [input, setInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/resources/videos/${postId}/repair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ youtubeInput: input }) });
      const json = await readJsonSafely(res);
      if (!res.ok) {
        const message = typeof json?.error === 'string' && json.error ? json.error : res.status === 403 ? "You don't have permission to add YouTube details to a video." : 'Could not save the YouTube details. Nothing was changed.';
        setError(message);
        setSaving(false);
        return;
      }
      // Re-render the page from the server: it now has a video row, so the
      // full editor opens in place of this form.
      router.refresh();
    } catch {
      setError('Could not reach the server, so nothing was changed. Check your connection and try again.');
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="video-repair-heading" className="rounded-card border border-attention/40 bg-attention/5 p-5">
      <h2 id="video-repair-heading" className="text-base font-semibold text-ink">
        This video needs its YouTube details
      </h2>
      <p className="mt-2 max-w-2xl text-sm text-ink">
        <span className="font-semibold">{title}</span>
        {contentId ? ` (${contentId})` : ''} was created as a video script without a YouTube video attached, so it cannot be edited or published yet. Enter the YouTube link of the finished @GKTC video below to attach it. Nothing else about this item changes.
      </p>

      {canRepair ? (
        <form onSubmit={submit} className="mt-4 max-w-lg space-y-3">
          <label htmlFor="video-repair-input" className="block text-sm font-medium text-ink">
            YouTube URL or Video ID
          </label>
          <p id="video-repair-hint" className="text-xs text-muted">
            e.g. https://www.youtube.com/watch?v=VIDEO_ID, https://youtu.be/VIDEO_ID, or a bare 11-character video ID.
          </p>
          <input
            id="video-repair-input"
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            required
            autoComplete="off"
            aria-invalid={!!error}
            aria-describedby={error ? 'video-repair-hint video-repair-error' : 'video-repair-hint'}
            placeholder="https://www.youtube.com/watch?v=…"
            className="block min-h-11 w-full rounded-compact border border-line bg-white px-3 py-2 text-sm text-ink focus:border-trust focus:outline-none focus:ring-1 focus:ring-trust"
          />
          {error && (
            <p id="video-repair-error" role="alert" className="text-sm font-medium text-risk">
              {error}
            </p>
          )}
          <button type="submit" disabled={saving} className="min-h-11 rounded-full bg-trust px-5 py-2 text-sm font-semibold text-white hover:bg-trust/90 disabled:opacity-50">
            {saving ? 'Saving…' : 'Add the YouTube details'}
          </button>
        </form>
      ) : (
        <p className="mt-4 text-sm text-muted">Adding YouTube details is available to Authors, Editors, Resource Administrators and Super Admins. Ask one of them to open this page.</p>
      )}
    </section>
  );
}
