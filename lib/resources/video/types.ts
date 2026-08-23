// R1.4 @GKTC video editor types — spec §17. resource_videos (R1.1 foundation,
// migration 0033) row shape plus the video-flavoured editor post shape.

import type { EditorPost, EditorSavePatch } from '@/lib/resources/editor/types';
import type { VideoChapter } from './youtube';

export interface VideoRow {
  id: string;
  resource_post_id: string;
  youtube_video_id: string;
  youtube_url: string;
  youtube_channel_handle: string;
  youtube_channel_url: string | null;
  duration_seconds: number | null;
  thumbnail_url: string | null;
  youtube_published_at: string | null;
  transcript: string | null;
  chapters: VideoChapter[];
  embed_enabled: boolean;
  created_at: string;
  updated_at: string;
}

// The editor's full working shape: the common resource_posts envelope
// (title/excerpt/taxonomy/SEO/workflow — identical to R1.3's EditorPost)
// plus the video-specific side table. `video` is null only in the
// impossible case of a post whose content_type is 'video' but whose
// resource_videos row is missing (defensive typing only; the creation flow
// never allows this to happen — see mutations.ts).
export interface VideoEditorPost extends EditorPost {
  video: VideoRow | null;
}

// Fields the video editor writes to resource_videos directly (never
// youtube_video_id/youtube_url after creation — spec §61 content type and
// the underlying video identity are locked once created; changing the
// linked YouTube video is a delete-and-recreate operation, not an edit,
// same principle as content_type lock).
export interface VideoSidePatch {
  duration_seconds: number | null;
  thumbnail_url: string | null;
  youtube_published_at: string | null;
  transcript: string | null;
  chapters: VideoChapter[];
  embed_enabled: boolean;
  youtube_channel_handle: string;
  youtube_channel_url: string | null;
}

export type VideoSavePatch = EditorSavePatch; // common post fields only; video-specific fields travel via VideoSidePatch

// The shape the client sends for the resource_videos side-table save (spec
// §17-20). Kept here rather than in mutations.ts so both the mutation layer
// and the API route can import it without a route -> mutations -> route
// circular concern.
export interface VideoSideSaveInput {
  duration_seconds: number | null;
  thumbnail_url: string | null;
  youtube_published_at: string | null;
  transcript: string;
  chapters: VideoChapter[];
  embed_enabled: boolean;
  youtube_channel_handle: string;
  youtube_channel_url: string | null;
}
