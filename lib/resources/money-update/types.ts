// R1.4 Money Update editor types — spec §40-49. Uses the same shared
// resource_posts envelope (content_type = 'money_update' |
// 'money_update_template') as every other specialist type, plus the two new
// migration-0038 columns (event_date, affected_audience) and the existing
// resource_sources/resource_post_sources relationship for citations.

import type { EditorPost, EditorSavePatch, RelatedOption } from '@/lib/resources/editor/types';

export interface MoneyUpdateSource {
  id: string;
  source_name: string;
  document_title: string | null;
  url: string | null;
  source_type: string | null;
  publication_date: string | null;
  sort_order: number;
}

export interface MoneyUpdateEditorPost extends EditorPost {
  event_date: string | null;
  affected_audience: string | null;
  sources: MoneyUpdateSource[];
}

export interface MoneyUpdateSavePatch extends EditorSavePatch {
  event_date: string | null;
  affected_audience: string;
}

export type MoneyUpdateContentType = 'money_update' | 'money_update_template';

export interface MoneyUpdateReferenceData {
  categories: RelatedOption[];
  tags: RelatedOption[];
  authors: RelatedOption[];
  ctas: RelatedOption[];
  templates: { id: string; title: string }[];
}
