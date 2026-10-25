// The calendar day in India, the day the Reserve Bank of India publishes on. The risk-free admin surface uses it wherever a date may not be in
// the future ("verified through", a rate row), and the database function risk_free_today() (migration 0294) uses the same day, so the screen
// and the database always agree about what "today" is. UTC is NOT used: an operator in India or Australia early in their day would otherwise
// be told that today is in the future (found on 19-10-2026, the repo rate verified-through date that "stayed").
//
// India has no daylight saving time, so a fixed +05:30 offset is exact.
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/** yyyy-mm-dd of `now` on the India calendar. */
export function indiaTodayIso(now: Date = new Date()): string {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}
