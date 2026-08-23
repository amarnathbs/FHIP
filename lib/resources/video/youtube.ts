// R1.4 @GKTC video — safe YouTube URL/ID parsing and embed derivation.
// Spec §15/§21/§84.
//
// Never makes an outbound request (spec §15: "Do not make external YouTube
// requests to parse the ID" — this is pure string/URL parsing). Uses the
// platform `URL` parser rather than fragile regex-over-the-whole-string
// matching (same principle spec §100 requires for source URLs), so a
// malformed or malicious string (`javascript:alert(1)`, `data:text/html,...`)
// is rejected by protocol/host inspection rather than accidentally matched
// by an over-permissive regex.

const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export function isValidYouTubeId(id: string): boolean {
  return YOUTUBE_ID_RE.test(id);
}

export type YouTubeParseResult = { ok: true; videoId: string; normalizedUrl: string } | { ok: false; error: string };

const INVALID_MESSAGE = "This YouTube URL doesn't appear valid.";

// Accepts: a bare 11-character video ID, youtube.com/watch?v=ID (+ any other
// query params, e.g. &t=90s), youtu.be/ID, youtube.com/embed/ID,
// youtube.com/shorts/ID, m.youtube.com and music.youtube.com host variants.
// Rejects everything else, including non-http(s) schemes (spec §84's
// `javascript:alert(1)` security test) and any host that isn't a genuine
// YouTube domain.
export function parseYouTubeVideoId(raw: unknown): YouTubeParseResult {
  if (typeof raw !== 'string') return { ok: false, error: INVALID_MESSAGE };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: 'Enter a YouTube URL or video ID.' };

  if (isValidYouTubeId(trimmed)) {
    return { ok: true, videoId: trimmed, normalizedUrl: buildYouTubeWatchUrl(trimmed) };
  }

  let url: URL;
  try {
    // A bare ID without "://" already returned above; anything reaching
    // here that has no scheme at all (e.g. "youtu.be/abc123DEFGH") is
    // treated as https by default, matching how a staff member would
    // naturally paste a URL copied without its protocol.
    url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
  } catch {
    return { ok: false, error: INVALID_MESSAGE };
  }

  // Only http(s) — this is the actual security boundary (spec §84):
  // javascript:/data:/vbscript: etc. never reach the host-matching logic
  // below because they fail here first.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, error: INVALID_MESSAGE };
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  let candidate: string | null = null;

  if (host === 'youtu.be') {
    candidate = url.pathname.slice(1).split('/')[0] || null;
  } else if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    if (url.pathname === '/watch') {
      candidate = url.searchParams.get('v');
    } else if (url.pathname.startsWith('/embed/')) {
      candidate = url.pathname.slice('/embed/'.length).split('/')[0] || null;
    } else if (url.pathname.startsWith('/shorts/')) {
      candidate = url.pathname.slice('/shorts/'.length).split('/')[0] || null;
    }
  }

  if (!candidate || !isValidYouTubeId(candidate)) {
    return { ok: false, error: INVALID_MESSAGE };
  }

  return { ok: true, videoId: candidate, normalizedUrl: buildYouTubeWatchUrl(candidate) };
}

export function buildYouTubeWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

// Spec §21/§123: the only place an embed URL is ever constructed — always
// derived from a validated video ID, never from an editor-supplied raw
// iframe/embed URL string. Returns null for an invalid id so the caller can
// render the spec §22 failure message instead of an iframe.
export function buildYouTubeEmbedUrl(videoId: string): string | null {
  if (!isValidYouTubeId(videoId)) return null;
  return `https://www.youtube.com/embed/${videoId}`;
}

export function buildYouTubeChannelWatchUrl(videoId: string): string {
  return buildYouTubeWatchUrl(videoId);
}

// Spec §18: "Initial implementation may use: YouTube standard thumbnail URL
// derived from video ID without API access." hqdefault.jpg exists for every
// public YouTube video and needs no API key.
export function buildYouTubeThumbnailUrl(videoId: string): string | null {
  if (!isValidYouTubeId(videoId)) return null;
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

// --- Chapters (spec §20/§79) ---------------------------------------------

export interface VideoChapter {
  id: string;
  timestamp: string; // "mm:ss" or "h:mm:ss"
  title: string;
}

const TIMESTAMP_RE = /^(?:(\d{1,2}):)?([0-5]?\d):([0-5]\d)$/;

export function isValidChapterTimestamp(raw: string): boolean {
  return TIMESTAMP_RE.test(raw.trim());
}

// Returns null for an invalid/unparseable timestamp rather than throwing —
// callers use this for sort-order derivation and display, never as a
// validation gate on its own (isValidChapterTimestamp is the gate).
export function chapterTimestampToSeconds(raw: string): number | null {
  const m = raw.trim().match(TIMESTAMP_RE);
  if (!m) return null;
  const hours = m[1] ? Number.parseInt(m[1], 10) : 0;
  const minutes = Number.parseInt(m[2], 10);
  const seconds = Number.parseInt(m[3], 10);
  return hours * 3600 + minutes * 60 + seconds;
}

function newChapterId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `chapter-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createChapter(): VideoChapter {
  return { id: newChapterId(), timestamp: '00:00', title: '' };
}

export interface ChapterValidationResult {
  valid: boolean;
  errors: Record<string, string>; // keyed by chapter id
}

// Every chapter must have a valid timestamp and a non-blank title (spec
// §20's own worked example implies both are meaningful — a chapter with no
// title is not useful navigation). Duplicate timestamps are flagged but not
// blocked (two chapters at the same second is unusual but not corrupting).
export function validateChapters(chapters: VideoChapter[]): ChapterValidationResult {
  const errors: Record<string, string> = {};
  for (const c of chapters) {
    if (!isValidChapterTimestamp(c.timestamp)) {
      errors[c.id] = 'Enter a timestamp in mm:ss or h:mm:ss format, e.g. 02:15.';
    } else if (!c.title.trim()) {
      errors[c.id] = 'Enter a chapter title.';
    }
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

export function sortChapters(chapters: VideoChapter[]): VideoChapter[] {
  return [...chapters].sort((a, b) => (chapterTimestampToSeconds(a.timestamp) ?? 0) - (chapterTimestampToSeconds(b.timestamp) ?? 0));
}
