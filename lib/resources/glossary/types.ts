// R1.4 Glossary editor types — spec §26.
//
// Term -> resource_posts.title, Short Definition -> resource_posts.excerpt,
// Detailed Explanation/Example -> resource_posts.content_blocks (structured
// blocks, reusing the R1.3 block model/editor exactly as-is — spec §27:
// "Do not force every definition to become a long Article", satisfied by a
// short glossary-specific starter template rather than a new content model).
// Aliases -> resource_posts.aliases (migration 0038). Related Terms ->
// resource_related_content (R1.1 foundation table, relationship_type
// 'related', reused unmodified).

import type { EditorPost, EditorSavePatch, RelatedOption } from '@/lib/resources/editor/types';

export interface GlossaryEditorPost extends EditorPost {
  aliases: string[];
  relatedTerms: RelatedOption[];
}

export interface GlossarySavePatch extends EditorSavePatch {
  aliases: string[];
}

export interface SimilarTermMatch {
  id: string;
  title: string;
  status: string;
}
