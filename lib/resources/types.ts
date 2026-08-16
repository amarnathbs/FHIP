// Resources / Financial Knowledge & Insights — R1.1 foundation types.
//
// Hand-authored, not `supabase gen types` output: this project has no
// Supabase CLI project link configured (no access token / linked project
// ref in the environment), so `supabase gen types typescript` cannot be run
// non-interactively here. These types are scoped to exactly what the R1.1
// permission/workflow helpers need and are written to match
// supabase/migrations/0033_resources_foundation.sql field-for-field. See
// docs/resources/R1.1-database-foundation.md ("N. TypeScript Integration")
// for the full explanation and what running the generator later would add.

// 'analyst' added during the R1.1 closure pass to reconcile against the
// approved R0-B spec. Deliberately not granted any content-workflow
// capability — see lib/resources/permissions.ts's isResourceStaff(), which
// excludes it on purpose, mirroring the DB-side
// private.is_resource_staff() function.
export type ResourceRole = 'resource_admin' | 'author' | 'editor' | 'compliance_reviewer' | 'publisher' | 'analyst';

export type ResourceContentType = 'article' | 'guide' | 'fhip_explainer' | 'video' | 'glossary' | 'money_update' | 'money_update_template';

export type ResourceStatus =
  | 'idea'
  | 'draft'
  | 'editorial_review'
  | 'compliance_review'
  | 'approved'
  | 'scheduled'
  | 'published'
  | 'review_due'
  | 'archived';

export type ComplianceClassification = 'green' | 'amber' | 'red';

export type ResourceJurisdiction = 'global' | 'australia' | 'india' | 'australia_india_cross_border';

export type ResourceDifficulty = 'beginner' | 'beginner_intermediate' | 'intermediate' | 'intermediate_advanced' | 'advanced';

export type ResourceFreshness = 'evergreen' | 'time_sensitive';

export type ResourceVisibility = 'public' | 'unlisted' | 'private';

export interface ResourceUserRoleRow {
  id: string;
  user_id: string;
  role: ResourceRole;
  is_active: boolean;
  assigned_by: string | null;
  assigned_at: string;
  created_at: string;
  updated_at: string;
}

export interface ResourcePost {
  id: string;
  content_id: string | null;
  title: string;
  slug: string | null;
  excerpt: string | null;
  content_blocks: unknown[];
  content_type: ResourceContentType;
  jurisdiction: ResourceJurisdiction;
  difficulty: ResourceDifficulty | null;
  freshness_type: ResourceFreshness;
  visibility: ResourceVisibility;
  primary_category_id: string | null;
  featured_image_id: string | null;
  author_id: string | null;
  reviewer_id: string | null;
  compliance_reviewer_id: string | null;
  status: ResourceStatus;
  compliance_classification: ComplianceClassification;
  scheduled_at: string | null;
  published_at: string | null;
  expires_at: string | null;
  last_reviewed_at: string | null;
  next_review_at: string | null;
  seo_title: string | null;
  seo_description: string | null;
  canonical_url: string | null;
  social_image_id: string | null;
  is_indexable: boolean;
  primary_cta_id: string | null;
  secondary_cta_id: string | null;
  is_featured: boolean;
  featured_priority: number | null;
  editorial_approved_by: string | null;
  editorial_approved_at: string | null;
  compliance_approved_by: string | null;
  compliance_approved_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
}

export interface ResourceWorkflowHistoryRow {
  id: string;
  post_id: string;
  from_status: ResourceStatus | null;
  to_status: ResourceStatus;
  actor_user_id: string | null;
  actor_role: string | null;
  action: string;
  reason: string | null;
  notes: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}
