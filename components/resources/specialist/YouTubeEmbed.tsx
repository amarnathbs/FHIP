// R1.4 safe YouTube embed — spec §21-23, §78, §84, §123.
//
// The embed URL is ALWAYS derived here from a validated video ID via
// buildYouTubeEmbedUrl(), never taken as a raw string from editor content or
// any other untrusted input — this component has no `src` prop at all, only
// `videoId`, which structurally prevents an arbitrary iframe URL from ever
// reaching the DOM through this component (spec §123: "not accept arbitrary
// iframe attributes from editor content"). A meaningful `title` is required
// (spec §78/§21 — never an untitled iframe).

import { buildYouTubeEmbedUrl, buildYouTubeWatchUrl } from '@/lib/resources/video/youtube';

export function YouTubeEmbed({ videoId, title }: { videoId: string; title: string }) {
  const embedUrl = buildYouTubeEmbedUrl(videoId);

  if (!embedUrl) {
    // Spec §22: exact required failure message, no iframe rendered at all.
    return (
      <div role="alert" className="rounded-card border border-risk/30 bg-risk/5 p-6 text-center text-sm text-risk">
        This YouTube video cannot be previewed. Check the Video ID or URL.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="aspect-video w-full overflow-hidden rounded-card border border-line bg-black">
        <iframe
          src={embedUrl}
          title={title}
          className="h-full w-full"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
        />
      </div>
      <p className="text-xs text-muted">
        Hosted on <span className="font-semibold">@GKTC</span> YouTube.{' '}
        <a href={buildYouTubeWatchUrl(videoId)} target="_blank" rel="noopener noreferrer" className="font-semibold text-trust hover:underline">
          Watch on YouTube
        </a>
      </p>
    </div>
  );
}
