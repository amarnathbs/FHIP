// An unambiguous English date for messages that an ADMINISTRATOR triggers (for example the e-mail that carries a
// promo code): "3 October 2026". The recipient's country is deliberately NOT looked up for these messages (PO rule,
// hardening mission): a long English month name cannot be misread as month-first or day-first.
//
// Everything a person reads in the application itself, and the reminder e-mails the system sends on its own, stay
// day-first through formatDateShort (dd/mm/yyyy Australia, dd-mm-yyyy India). This module is for the one other case.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;

/** `iso` is a calendar date written year-month-day with hyphens. Returns '' for anything that is not a real date. */
export function formatEnglishLongDate(iso: string | null | undefined): string {
  if (typeof iso !== 'string') return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return '';
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return '';
  return `${day} ${MONTHS[month - 1]} ${year}`;
}
