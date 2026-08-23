// R1.4 Glossary validation — spec §28. Deliberately its own module rather
// than a variant of R1.3's validateForReview: Glossary review-readiness
// differs in one specific way from Article/Guide/FHIP Explainer — a
// detailed explanation (content_blocks) is explicitly optional for simple
// terms (spec §28: "Detailed explanation may be optional for simple
// terms."), where R1.3's validateForReview requires at least one meaningful
// block unconditionally. Reuses R1.3's slug/aliases-agnostic checks where
// they apply unchanged (title/slug length, category/author/compliance
// presence) rather than re-deriving them.

import { isValidSlugFormat } from '@/lib/resources/editor/slug';
import { TITLE_MAX_LENGTH } from '@/lib/resources/editor/validation';

export interface ValidationResult {
  valid: boolean;
  errors: Record<string, string>;
}

function result(errors: Record<string, string>): ValidationResult {
  return { valid: Object.keys(errors).length === 0, errors };
}

export const SHORT_DEFINITION_MAX_LENGTH = 300;

export interface ValidatableGlossaryTerm {
  title: string; // the Term
  slug: string | null;
  excerpt: string | null; // the Short Definition
  jurisdiction: string;
  primary_category_id: string | null;
  author_id: string | null;
  compliance_classification: string;
}

// Draft save — near-nothing, same principle as R1.3 (spec §35/§36): drafts
// must support incomplete work.
export function validateGlossaryForDraftSave(term: Pick<ValidatableGlossaryTerm, 'title'>): ValidationResult {
  const errors: Record<string, string> = {};
  if (term.title.length > TITLE_MAX_LENGTH) errors.title = `Term must be ${TITLE_MAX_LENGTH} characters or fewer.`;
  return result(errors);
}

// Before "Submit for Editorial Review" (spec §28's checklist exactly: term,
// slug, short definition, jurisdiction, primary category, author, compliance
// classification — detailed explanation is NOT in this list on purpose).
export function validateGlossaryForReview(term: ValidatableGlossaryTerm): ValidationResult {
  const errors: Record<string, string> = {};
  if (!term.title.trim()) errors.title = 'A term is required.';
  else if (term.title.length > TITLE_MAX_LENGTH) errors.title = `Term must be ${TITLE_MAX_LENGTH} characters or fewer.`;

  if (!term.slug || !isValidSlugFormat(term.slug)) errors.slug = 'A valid URL slug is required.';

  if (!term.excerpt || !term.excerpt.trim()) errors.excerpt = 'A short definition is required.';
  else if (term.excerpt.length > SHORT_DEFINITION_MAX_LENGTH) errors.excerpt = `Short definition must be ${SHORT_DEFINITION_MAX_LENGTH} characters or fewer.`;

  if (!term.jurisdiction) errors.jurisdiction = 'Jurisdiction is required.';
  if (!term.primary_category_id) errors.primary_category_id = 'A primary category is required.';
  if (!term.author_id) errors.author_id = 'An author is required.';
  if (!term.compliance_classification) errors.compliance_classification = 'A compliance classification is required.';

  return result(errors);
}
