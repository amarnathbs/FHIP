// Premium expiry e-mail reminders — constants and the pure message composer.
//
// SCOPE. E-mails are for ADMIN-GRANTED and PROMO Premium only (never paid), sent
// only to the entitlement's own user. The decision of WHO is due lives in the
// database (premium_reminder_claim, migration 0238); this module owns the single
// named threshold list and the wording.
//
// COPY RULES (transactional, not marketing): plain text, observation style, the
// end date and the real ways to continue (the Plans section of the Profile page,
// or contact support). No name, no financial data, no promo-code value, no
// tracking, no upsell language.

import { dateFormatKeyForCountry, formatDateShort } from '@/lib/engines/date';

/**
 * THE SINGLE NAMED LIST of reminder thresholds, in days before the end date.
 * Default: one e-mail one month (30 days) before access ends. Adding 7 here
 * ([30, 7]) enables an optional second e-mail with no other change: the database
 * sends only the most urgent applicable threshold, so enabling it late never
 * sends two e-mails at once.
 */
export const PREMIUM_EXPIRY_EMAIL_THRESHOLD_DAYS: readonly number[] = [30];

/** Bounded retry budget for a failed send (attempts include the first). */
export const PREMIUM_EXPIRY_EMAIL_MAX_ATTEMPTS = 3;
/** Base delay between attempts; attempt n waits n x this. */
export const PREMIUM_EXPIRY_EMAIL_RETRY_MINUTES = 60;
/** Messages claimed per cron run. */
export const PREMIUM_EXPIRY_EMAIL_BATCH_SIZE = 50;

/** The job-control key the kill switch lives under. */
export const PREMIUM_EXPIRY_EMAIL_JOB_KEY = 'expiry_email';

export interface ReminderEmailInput {
  /** Last day of access, YYYY-MM-DD. */
  endsOn: string;
  /** Whole days from today to endsOn (informational). */
  daysLeft: number;
  /** The user's country of residence ('IN' or anything else). */
  country: string | null;
  /** App origin used for the two links, no trailing slash. */
  baseUrl: string;
}

export interface ReminderEmail {
  subject: string;
  text: string;
}

/** Country -> the repo's date-format key (formatDateShort is currency-keyed: AU dd/mm/yyyy, India dd-mm-yyyy). Lives in lib/engines/date.ts; re-exported for existing callers. */
export { dateFormatKeyForCountry };

export function composeExpiryReminderEmail(input: ReminderEmailInput): ReminderEmail {
  const date = formatDateShort(input.endsOn, dateFormatKeyForCountry(input.country));
  const profile = `${input.baseUrl}/profile`;
  const contact = `${input.baseUrl}/contact`;
  const when = input.daysLeft <= 0 ? 'today' : `in ${input.daysLeft} day${input.daysLeft === 1 ? '' : 's'}`;
  return {
    subject: `Your complimentary Premium access ends on ${date}`,
    text: [
      'Hello,',
      '',
      `Your complimentary Premium access on FHIP ends on ${date} (${when}).`,
      'After that date your account moves to the Free plan. Your saved information stays in your account.',
      '',
      'To continue with Premium, you can subscribe from the Plans section of your Profile page:',
      profile,
      '',
      'Or contact FHIP support and ask for your access to be reviewed:',
      contact,
      '',
      'This is a service message about your account, not marketing. It is sent because your account has complimentary Premium access that is about to end.',
      '',
      'FHIP',
    ].join('\n'),
  };
}
