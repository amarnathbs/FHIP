// R1.4 Money Update validation — spec §42/§46/§88.

import { isValidSlugFormat } from '@/lib/resources/editor/slug';
import { TITLE_MAX_LENGTH } from '@/lib/resources/editor/validation';
import { hasAtLeastOneMeaningfulBlock, type AnyBlock } from '@/lib/resources/editor/blocks';

export interface ValidationResult {
  valid: boolean;
  errors: Record<string, string>;
}

function result(errors: Record<string, string>): ValidationResult {
  return { valid: Object.keys(errors).length === 0, errors };
}

export interface ValidatableMoneyUpdate {
  title: string;
  slug: string | null;
  excerpt: string | null;
  jurisdiction: string;
  primary_category_id: string | null;
  author_id: string | null;
  compliance_classification: string;
  content_blocks: AnyBlock[];
  event_date: string | null;
  next_review_at: string | null;
  expires_at: string | null;
  content_type: string;
}

export function validateMoneyUpdateForDraftSave(update: Pick<ValidatableMoneyUpdate, 'title'>): ValidationResult {
  const errors: Record<string, string> = {};
  if (update.title.length > TITLE_MAX_LENGTH) errors.title = `Title must be ${TITLE_MAX_LENGTH} characters or fewer.`;
  return result(errors);
}

// Before "Submit for Editorial Review" — spec §42's required-field list plus
// spec §46's freshness requirement (a review or expiry date before
// publication) and spec §88's explicit test list. A Money Update Template
// (content_type = 'money_update_template') is exempt from the event_date /
// review-or-expiry requirements — spec §44: "Templates should allow reusable
// structure without pretending to be a published current event," so a
// template has no real event date and no publication of its own to gate.
export function validateMoneyUpdateForReview(update: ValidatableMoneyUpdate): ValidationResult {
  const errors: Record<string, string> = {};
  const isTemplate = update.content_type === 'money_update_template';

  if (!update.title.trim()) errors.title = 'A title is required.';
  else if (update.title.length > TITLE_MAX_LENGTH) errors.title = `Title must be ${TITLE_MAX_LENGTH} characters or fewer.`;

  if (!update.slug || !isValidSlugFormat(update.slug)) errors.slug = 'A valid URL slug is required.';
  if (!update.excerpt || !update.excerpt.trim()) errors.excerpt = 'A summary (30-second explanation) is required.';
  if (!update.jurisdiction) errors.jurisdiction = 'Jurisdiction is required.';
  if (!update.primary_category_id) errors.primary_category_id = 'A primary category is required.';
  if (!update.author_id) errors.author_id = 'An author is required.';
  if (!update.compliance_classification) errors.compliance_classification = 'A compliance classification is required.';
  if (!hasAtLeastOneMeaningfulBlock(update.content_blocks)) errors.content_blocks = 'Complete at least one structured section before submitting for review.';

  if (!isTemplate) {
    if (!update.event_date) errors.event_date = 'An event date is required for a Money Update.';
    // Spec §46: "Require next review date; or expiry date before
    // publication where appropriate." Either satisfies this — a Money
    // Update reviewed again in 60 days may not need a hard expiry, and vice
    // versa.
    if (!update.next_review_at && !update.expires_at) errors.next_review_at = 'A next review date or expiry date is required before this can be published.';
  }

  return result(errors);
}
