// R1.3 editor-only types — extends the R1.1 (lib/resources/types.ts) and
// R1.2 (lib/resources/admin/queries.ts) types with what the editor UI and
// mutation layer need. Kept in its own file rather than growing the R1.1
// types file, since these are editor-specific shapes (form state, block
// model) not part of the R1.1 database-foundation contract.

import type { ResourcePost, ResourceContentType } from '@/lib/resources/types';

// Exactly the three content types R1.3 builds editors for (spec §2/§3).
export const EDITABLE_CONTENT_TYPES: Extract<ResourceContentType, 'article' | 'guide' | 'fhip_explainer'>[] = ['article', 'guide', 'fhip_explainer'];
export type EditableContentType = (typeof EDITABLE_CONTENT_TYPES)[number];

export function isEditableContentType(t: string): t is EditableContentType {
  return (EDITABLE_CONTENT_TYPES as string[]).includes(t);
}

export interface RelatedOption {
  id: string;
  name: string;
}

// Full editor-shape post: every column the editor reads/writes, plus its
// taxonomy join rows and CTA labels. Never fetched by the R1.2 list/dashboard
// queries (which deliberately omit content_blocks — see lib/resources/admin/queries.ts).
export interface EditorPost extends ResourcePost {
  categories: RelatedOption[]; // additional (non-primary) categories
  tags: RelatedOption[];
}

// Hotfix (post-closure, see FHIP_RESOURCES_ADMIN_ROLE_CTA_MANAGEMENT_HOTFIX_
// REPORT.md section D/J-L): `authors`, `reviewers`, and `complianceReviewers`
// are now three genuinely distinct, role-eligibility-filtered lists (author/
// resource_admin; editor/resource_admin; compliance_reviewer/resource_admin
// respectively — mirroring the transition RPC's own permission predicates),
// not the same undifferentiated resource_authors.is_active list repeated
// three times as before.
export interface EditorReferenceData {
  categories: RelatedOption[];
  tags: RelatedOption[];
  authors: RelatedOption[];
  reviewers: RelatedOption[];
  complianceReviewers: RelatedOption[];
  ctas: RelatedOption[];
}

export interface PostVersionSummary {
  id: string;
  version_number: number;
  change_summary: string | null;
  created_by: string | null;
  created_at: string;
}

// Shape persisted into resource_post_versions.snapshot (spec §44) — enough
// to reconstruct the post's editorial state at that point. No secrets, no
// audit metadata (spec §44: "Do not include secrets or irrelevant audit data").
export interface PostVersionSnapshot {
  title: string;
  slug: string | null;
  excerpt: string | null;
  content_type: string;
  content_blocks: unknown[];
  jurisdiction: string;
  difficulty: string | null;
  freshness_type: string;
  visibility: string;
  compliance_classification: string;
  primary_category_id: string | null;
  category_ids: string[];
  tag_ids: string[];
  author_id: string | null;
  reviewer_id: string | null;
  compliance_reviewer_id: string | null;
  seo_title: string | null;
  seo_description: string | null;
  canonical_url: string | null;
  is_indexable: boolean;
  primary_cta_id: string | null;
  secondary_cta_id: string | null;
}

// Fields the editor may write via ordinary column UPDATE (never status or
// the approval/publish-control columns — those are RPC-only, spec §65).
export interface EditorSavePatch {
  title: string;
  slug: string | null;
  excerpt: string | null;
  content_blocks: unknown[];
  jurisdiction: string;
  difficulty: string | null;
  freshness_type: string;
  visibility: string;
  compliance_classification: string; // writable as of migration 0037 — see that file
  primary_category_id: string | null;
  author_id: string | null;
  reviewer_id: string | null;
  compliance_reviewer_id: string | null;
  expires_at: string | null;
  next_review_at: string | null;
  seo_title: string | null;
  seo_description: string | null;
  canonical_url: string | null;
  is_indexable: boolean;
  primary_cta_id: string | null;
  secondary_cta_id: string | null;
  content_id: string | null; // only meaningful on create; ignored by updateResourceDraft after creation (see mutations.ts)
}

export type EditorSaveTaxonomy = {
  categoryIds: string[]; // additional categories, NOT including primary
  tagIds: string[];
};
