// R1.4 Video validation — spec §17. Its own module rather than reusing
// R1.3's validateForReview() as-is: that function requires at least one
// meaningful content_blocks entry (spec §35 for Article/Guide/FHIP
// Explainer), but Video has no long-form content_blocks body at all — its
// "content" lives in resource_videos (transcript/chapters) and the ordinary
// excerpt field, so content_blocks is always `[]` by design (see
// mutations.ts createVideoDraft). Genuine defect found and fixed during the
// R1.4 live browser pass: the workflow route originally called R1.3's
// validateForReview() directly on a video post, which blocked every video
// from ever reaching Editorial Review with "Add at least one block with
// real content" — a check that can never be satisfied by a video and was
// never meant to apply to one.

import { isValidSlugFormat } from '@/lib/resources/editor/slug';
import { TITLE_MAX_LENGTH } from '@/lib/resources/editor/validation';

export interface ValidationResult {
  valid: boolean;
  errors: Record<string, string>;
}

function result(errors: Record<string, string>): ValidationResult {
  return { valid: Object.keys(errors).length === 0, errors };
}

export interface ValidatableVideo {
  title: string;
  slug: string | null;
  excerpt: string | null;
  jurisdiction: string;
  primary_category_id: string | null;
  author_id: string | null;
  compliance_classification: string;
  seo_title?: string | null;
  seo_description?: string | null;
  editorial_approved_by?: string | null;
  compliance_approved_by?: string | null;
}

export function validateVideoForDraftSave(video: Pick<ValidatableVideo, 'title'>): ValidationResult {
  const errors: Record<string, string> = {};
  if (video.title.length > TITLE_MAX_LENGTH) errors.title = `Title must be ${TITLE_MAX_LENGTH} characters or fewer.`;
  return result(errors);
}

// Before "Submit for Editorial Review" — same core fields as R1.3's
// validateForReview (title/slug/excerpt/jurisdiction/category/author/
// compliance), deliberately without a content_blocks check.
export function validateVideoForReview(video: ValidatableVideo): ValidationResult {
  const errors: Record<string, string> = {};
  if (!video.title.trim()) errors.title = 'A title is required.';
  else if (video.title.length > TITLE_MAX_LENGTH) errors.title = `Title must be ${TITLE_MAX_LENGTH} characters or fewer.`;

  if (!video.slug || !isValidSlugFormat(video.slug)) errors.slug = 'A valid URL slug is required.';
  if (!video.excerpt || !video.excerpt.trim()) errors.excerpt = 'An excerpt/description is required.';
  if (!video.jurisdiction) errors.jurisdiction = 'Jurisdiction is required.';
  if (!video.primary_category_id) errors.primary_category_id = 'A primary category is required.';
  if (!video.author_id) errors.author_id = 'An author is required.';
  if (!video.compliance_classification) errors.compliance_classification = 'A compliance classification is required.';

  return result(errors);
}

// Before Publish/Schedule — mirrors R1.3's validateForPublish shape (SEO
// fallback + compliance-approval checks) without the content_blocks
// dependency validateVideoForReview already omits.
export function validateVideoForPublish(video: ValidatableVideo): ValidationResult {
  const review = validateVideoForReview(video);
  const errors: Record<string, string> = { ...review.errors };

  if (!video.seo_title?.trim() && !video.title.trim()) errors.seo_title = 'An SEO title (or a title to fall back to) is required.';
  if (!video.seo_description?.trim() && !video.excerpt?.trim()) errors.seo_description = 'A meta description (or an excerpt to fall back to) is required.';

  if (video.compliance_classification === 'red') errors.compliance_classification = 'RED content cannot be scheduled or published under the current Resources workflow.';
  if (video.compliance_classification === 'amber' && !video.compliance_approved_by) errors.compliance_classification = 'AMBER content requires compliance approval before it can be published.';
  if (!video.editorial_approved_by && video.compliance_classification !== 'amber') errors.status = 'This content has not yet received editorial approval.';

  return result(errors);
}
