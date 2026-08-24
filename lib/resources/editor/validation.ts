// R1.3 stage-aware validation — spec §35-37, §83-84.
//
// Three distinct levels, deliberately not one shared rule set (spec §36:
// "Do not use one validation level for every workflow stage"):
//   - validateForDraftSave: near-nothing. Drafts must support incomplete work.
//   - validateForReview: the spec §35 checklist, required before "Submit for
//     Editorial Review".
//   - validateForPublish: the spec §37 checklist, required before
//     Publish/Schedule (defense-in-depth only — the DB CHECK constraints and
//     the transition RPC remain the authoritative backstop; this exists so
//     the UI can show a field-level error summary instead of a raw
//     Postgres/RPC exception, spec §74/§83).
//
// Every result is { valid, errors } where errors is a field-keyed map, so
// the UI can both show an accessible summary list and associate each
// message with its input via aria-describedby (spec §84).

import { isValidSlugFormat } from './slug';
import { hasAtLeastOneMeaningfulBlock, type AnyBlock } from './blocks';

export interface ValidationResult {
  valid: boolean;
  errors: Record<string, string>;
}

export interface ValidatablePost {
  title: string;
  slug: string | null;
  excerpt: string | null;
  content_type: string;
  jurisdiction: string;
  primary_category_id: string | null;
  author_id: string | null;
  compliance_classification: string;
  content_blocks: AnyBlock[];
  seo_title: string | null;
  seo_description: string | null;
  editorial_approved_by?: string | null;
  compliance_approved_by?: string | null;
}

function result(errors: Record<string, string>): ValidationResult {
  return { valid: Object.keys(errors).length === 0, errors };
}

export const TITLE_MAX_LENGTH = 180;
export const EXCERPT_MAX_LENGTH = 300;

// Draft save (spec §35: "Saving a draft may be more permissive... Drafts
// should allow incomplete work"). Only structural guards that would corrupt
// data if skipped — nothing about content completeness.
export function validateForDraftSave(post: Pick<ValidatablePost, 'title'>): ValidationResult {
  const errors: Record<string, string> = {};
  if (post.title.length > TITLE_MAX_LENGTH) errors.title = `Title must be ${TITLE_MAX_LENGTH} characters or fewer.`;
  return result(errors);
}

// Hotfix (post-closure) — spec §22: "Prefer validation: primary_cta_id !=
// secondary_cta_id." Shared by every content-type's PATCH route (content,
// videos, glossary, money-updates all carry the same two CTA columns on the
// one shared resource_posts table) rather than duplicated per content type.
// Server-side defense-in-depth alongside the editor's own inline hint —
// never trust the client-side check alone (same rationale as every other
// validator in this file, spec §20).
export function validateCtaAssignment(patch: { primary_cta_id: string | null; secondary_cta_id: string | null }): ValidationResult {
  const errors: Record<string, string> = {};
  if (patch.primary_cta_id && patch.secondary_cta_id && patch.primary_cta_id === patch.secondary_cta_id) {
    errors.secondary_cta_id = 'Primary and Secondary CTA cannot be the same. Choose a different Secondary CTA or leave it blank.';
  }
  return result(errors);
}

// Before "Submit for Editorial Review" (spec §35).
export function validateForReview(post: ValidatablePost): ValidationResult {
  const errors: Record<string, string> = {};
  if (!post.title.trim()) errors.title = 'Title is required.';
  else if (post.title.length > TITLE_MAX_LENGTH) errors.title = `Title must be ${TITLE_MAX_LENGTH} characters or fewer.`;

  if (!post.slug || !isValidSlugFormat(post.slug)) errors.slug = 'A valid URL slug is required.';

  if (!post.excerpt || !post.excerpt.trim()) errors.excerpt = 'A short excerpt/summary is required.';
  else if (post.excerpt.length > EXCERPT_MAX_LENGTH) errors.excerpt = `Excerpt must be ${EXCERPT_MAX_LENGTH} characters or fewer.`;

  if (!post.content_type) errors.content_type = 'Content type is required.';
  if (!post.jurisdiction) errors.jurisdiction = 'Jurisdiction is required.';
  if (!post.primary_category_id) errors.primary_category_id = 'A primary category is required.';
  if (!post.author_id) errors.author_id = 'An author is required.';
  if (!post.compliance_classification) errors.compliance_classification = 'A compliance classification is required.';

  if (!hasAtLeastOneMeaningfulBlock(post.content_blocks)) errors.content_blocks = 'Add at least one block with real content before submitting for review.';

  return result(errors);
}

// Before Publish/Schedule (spec §37). SEO title/description fall back to
// title/excerpt automatically (see mutations.ts deriveSeoFallback) so those
// two are effectively always satisfied by the time this runs; still checked
// here in case a caller passes raw, un-fallback-applied values.
export function validateForPublish(post: ValidatablePost): ValidationResult {
  const review = validateForReview(post);
  const errors: Record<string, string> = { ...review.errors };

  if (!post.seo_title?.trim() && !post.title.trim()) errors.seo_title = 'An SEO title (or a title to fall back to) is required.';
  if (!post.seo_description?.trim() && !post.excerpt?.trim()) errors.seo_description = 'A meta description (or an excerpt to fall back to) is required.';

  if (post.compliance_classification === 'red') errors.compliance_classification = 'RED content cannot be scheduled or published under the current Resources workflow.';
  if (post.compliance_classification === 'amber' && !post.compliance_approved_by) errors.compliance_classification = 'AMBER content requires compliance approval before it can be published.';
  if (!post.editorial_approved_by && post.compliance_classification !== 'amber') errors.status = 'This content has not yet received editorial approval.';

  return result(errors);
}
