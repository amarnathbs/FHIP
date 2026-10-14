// Day-first date formatting for everything a person reads (Indian and Australian convention: dd/mm/yyyy).
// Pure and dependency-free so a client component can import it without pulling in the server-side file readers.
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/** dd/mm/yyyy for a database date. A value that is not a database date is returned unchanged. */
export function formatDayFirst(iso: string | null | undefined): string {
  if (!iso) return '';
  const m = ISO.exec(iso);
  if (!m) return iso;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/** dd/mm/yyyy hh:mm (24 hour, the viewer's own time zone) for a timestamp. */
export function formatDayFirstDateTime(ts: string | null | undefined): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Today in the database date form (UTC date). The caller injects the clock in tests. */
export function todayIsoUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
