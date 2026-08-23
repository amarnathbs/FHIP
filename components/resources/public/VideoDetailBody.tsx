// Spec §35-39: Video detail rendering. Reuses R1.4's validated YouTubeEmbed
// unchanged (spec §36: "Reuse R1.4's validated YouTube embed component. Do
// not create another iframe implementation") — the iframe src is always
// derived from the stored youtube_video_id via buildYouTubeEmbedUrl, never
// an arbitrary URL (spec §36/§92: "no arbitrary iframe").
//
// Spec §37: "Only load iframe/embed on Video detail" — this component (and
// therefore the iframe) is imported solely by the [slug] detail dispatcher,
// never by any list/card component, which instead shows only the static
// thumbnail <img> (components/resources/public/ResourcePublicCard.tsx).

import { YouTubeEmbed } from '@/components/resources/specialist/YouTubeEmbed';
import type { PublicResourceDetail } from '@/lib/resources/public/queries';

export function VideoDetailBody({ video, title }: { video: NonNullable<PublicResourceDetail['video']>; title: string }) {
  return (
    <div className="space-y-6">
      {video.embed_enabled === false ? (
        <p className="rounded-card border border-line bg-white p-6 text-center text-sm text-muted">
          Embed is disabled for this video.{' '}
          <a href={video.youtube_url} target="_blank" rel="noopener noreferrer" className="font-semibold text-trust hover:underline">
            Watch on YouTube
          </a>
        </p>
      ) : (
        <YouTubeEmbed videoId={video.youtube_video_id} title={title} />
      )}

      {video.chapters && video.chapters.length > 0 && (
        <section aria-labelledby="chapters-heading">
          <h2 id="chapters-heading" className="text-xl font-semibold text-ink">
            Chapters
          </h2>
          {/* Spec §39: chapter navigation is informational content here — no
              YouTube Player API integration in R1.5 (out of scope). */}
          <ul className="mt-3 space-y-1 text-sm text-ink">
            {video.chapters.map((c) => (
              <li key={c.id} className="flex gap-3">
                <span className="w-14 shrink-0 font-mono text-muted">{c.timestamp}</span>
                <span>{c.title}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {video.transcript && (
        <section aria-labelledby="transcript-heading">
          <h2 id="transcript-heading" className="text-xl font-semibold text-ink">
            Transcript
          </h2>
          {/* Spec §38: "must remain accessible without JavaScript where
              practical" — a native <details> disclosure, open by default so
              the full transcript text is present in the initial server-
              rendered HTML regardless of JS/hydration. */}
          <details open className="mt-3 rounded-card border border-line bg-white p-4">
            <summary className="cursor-pointer text-sm font-semibold text-ink marker:content-none">Transcript</summary>
            <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-ink">{video.transcript}</p>
          </details>
        </section>
      )}
    </div>
  );
}
