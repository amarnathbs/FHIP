// R1.4 FAQ validation — spec §34-35.

export interface ValidationResult {
  valid: boolean;
  errors: Record<string, string>;
}

function result(errors: Record<string, string>): ValidationResult {
  return { valid: Object.keys(errors).length === 0, errors };
}

export const QUESTION_MAX_LENGTH = 300;
export const SHORT_ANSWER_MAX_LENGTH = 600;

export interface ValidatableFaq {
  question: string;
  short_answer: string;
  jurisdiction: string;
}

// FAQ has no draft/review/publish workflow (spec §32/§54 — it's not a
// resource_post) — one validation level covers both "save" and "active".
// Question and Short Answer are the two spec §34 "Required" fields; a FAQ
// may be saved inactive with these still required, since an inactive FAQ
// with no real content isn't useful to keep around either.
export function validateFaq(faq: ValidatableFaq): ValidationResult {
  const errors: Record<string, string> = {};
  if (!faq.question.trim()) errors.question = 'A question is required.';
  else if (faq.question.length > QUESTION_MAX_LENGTH) errors.question = `Question must be ${QUESTION_MAX_LENGTH} characters or fewer.`;

  if (!faq.short_answer.trim()) errors.short_answer = 'A short answer is required.';
  else if (faq.short_answer.length > SHORT_ANSWER_MAX_LENGTH) errors.short_answer = `Short answer must be ${SHORT_ANSWER_MAX_LENGTH} characters or fewer.`;

  if (!faq.jurisdiction) errors.jurisdiction = 'Jurisdiction is required.';

  return result(errors);
}
