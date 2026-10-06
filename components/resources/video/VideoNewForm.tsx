'use client';

// R1.4 Video creation — spec §14-16. The entire "chooser" for Video is this
// one YouTube URL/ID input, since @GKTC is the source-of-truth host (spec
// §4) — there is nothing else to choose between.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

export function VideoNewForm({ canCreate, canLink = false }: { canCreate: boolean; canLink?: boolean }) {
  const router = useRouter();
  const [input, setInput] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // PO review F12: after a successful add, offer "Link to content" as the next step.
  const [createdId, setCreatedId] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/resources/videos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ youtubeInput: input }) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "This YouTube URL doesn't appear valid.");
      setCreating(false);
      setCreatedId(json.data.id as string);
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : 'Something went wrong.');
      setCreating(false);
    }
  }

  if (!canCreate) {
    return (
      <div className="rounded-card border border-line bg-white p-6 text-center">
        <p className="text-sm font-semibold text-ink">You don&apos;t have permission to add a video.</p>
        <p className="mt-1 text-sm text-muted">Video creation is available to Authors, Editors, Resource Administrators and Super Admins.</p>
        <Link href="/admin/resources/videos" className="mt-4 inline-block text-sm font-semibold text-trust hover:underline">
          Back to Videos
        </Link>
      </div>
    );
  }

  if (createdId) {
    return (
      <div className="max-w-lg space-y-4 rounded-card border border-line bg-white p-5">
        <h1 className="text-xl font-semibold text-ink">Video added</h1>
        <p role="status" className="text-sm text-muted">
          The video was added as a private draft. What would you like to do next?
        </p>
        <div className="flex flex-wrap gap-3">
          {canLink && (
            <Link href={`/admin/resources/videos/${createdId}/edit#linked-content`} className="inline-flex min-h-11 items-center rounded-full bg-trust px-5 py-2 text-sm font-semibold text-white hover:bg-trust/90">
              Link to content
            </Link>
          )}
          <Link
            href={`/admin/resources/videos/${createdId}/edit`}
            className={`inline-flex min-h-11 items-center rounded-full px-5 py-2 text-sm font-semibold ${canLink ? 'border border-line text-ink hover:bg-gray-50' : 'bg-trust text-white hover:bg-trust/90'}`}
          >
            Edit video details
          </Link>
          <Link href="/admin/resources/videos" className="inline-flex min-h-11 items-center px-2 text-sm font-semibold text-trust hover:underline">
            Back to Videos
          </Link>
        </div>
        {!canLink && <p className="text-xs text-muted">Linking videos to content is available to Resource Administrators and Editors.</p>}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <nav aria-label="Breadcrumb" className="text-sm text-muted">
        <Link href="/admin/resources" className="hover:text-trust hover:underline">
          Resources
        </Link>{' '}
        &gt;{' '}
        <Link href="/admin/resources/videos" className="hover:text-trust hover:underline">
          Videos
        </Link>{' '}
        &gt; <span className="text-ink">Add @GKTC Video</span>
      </nav>

      <div>
        <h1 className="text-2xl font-semibold text-ink">Add @GKTC Video</h1>
        <p className="mt-1 text-sm text-muted">
          Enter the YouTube URL or video ID for a video already published on <span className="font-semibold">@GKTC</span>. FHIP stores metadata and embeds the video — it does not host the underlying file.
        </p>
      </div>

      <form onSubmit={submit} className="max-w-lg space-y-3 rounded-card border border-line bg-white p-5">
        <label htmlFor="youtube-input" className="block text-sm font-medium text-ink">
          YouTube URL or Video ID
        </label>
        <p className="text-xs text-muted">e.g. https://www.youtube.com/watch?v=VIDEO_ID, https://youtu.be/VIDEO_ID, or a bare video ID.</p>
        <input
          id="youtube-input"
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          required
          aria-invalid={!!error}
          aria-describedby={error ? 'youtube-input-error' : undefined}
          className="block w-full rounded-compact border border-line px-3 py-2 text-sm text-ink focus:border-trust focus:outline-none focus:ring-1 focus:ring-trust"
          placeholder="https://www.youtube.com/watch?v=…"
        />
        {error && (
          <p id="youtube-input-error" role="alert" className="text-xs font-medium text-risk">
            {error}
          </p>
        )}
        <button type="submit" disabled={creating} className="rounded-full bg-trust px-4 py-2 text-sm font-semibold text-white hover:bg-trust/90 disabled:opacity-50">
          {creating ? 'Adding…' : 'Add Video'}
        </button>
      </form>
    </div>
  );
}
