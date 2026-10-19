// The month under a point of a report chart. A stored series carries ISO months ("2026-08-01", "2026-10"); the Product Owner's rule (06-10-2026)
// is that no year-first date reaches a screen or a PDF, so the report's charts label their points "Aug 2026". Month names are the same in India and
// Australia. A value that is not a year and month is returned unchanged (never guessed at). Pure: no locale API, no clock.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function chartMonthLabel(value: string): string {
  const m = /^(\d{4})-(0[1-9]|1[0-2])(?:-\d{2})?$/.exec(value.trim());
  return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : value;
}
