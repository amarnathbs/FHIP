// Pure presentation logic for the Reference Data Quality admin page (PO review 2026-10-06, F7).
//
// The page used to print every import batch and every source-correction line it
// loaded, so a healthy feed produced a wall of identical "succeeded ... read 19,
// accepted 19, rejected 0" lines. The Product Owner asked for the last update only,
// plus anything that went wrong or was missed.
//
// SAFETY RULE (Admin Standard section 8 result-state semantics, section 13 safe failure).
// Collapsing may only ever hide a run that is BOTH succeeded AND clean AND not the latest
// success of its feed. Everything else stays visible: a failed / rolled-back / skipped /
// still-running run, a succeeded run that rejected rows or recorded an error code, a feed
// whose latest success is stale, and a feed that has no successful run (or no run at all).
// This module has no I/O and no React so every one of those rules is unit-tested directly.

export const RENDER_ROW_CAP = 100;

/** Loose input row: the API returns untyped rows, so every field is validated here. */
export type RawRow = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Day-first dates. Indian reference-data screens read dd-mm-yyyy (PO standing rule; the AU shape is dd/mm/yyyy); ISO and US order are
// never shown on this page (PO standing rule).
// ---------------------------------------------------------------------------

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

function validYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

function partsInZone(date: Date, timeZone?: string): { d: string; m: string; y: string; hh: string; mm: string } | null {
  if (Number.isNaN(date.getTime())) return null;
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) out[p.type] = p.value;
  if (!out.day || !out.month || !out.year) return null;
  return { d: out.day, m: out.month, y: out.year, hh: out.hour ?? '00', mm: out.minute ?? '00' };
}

/** A calendar date, day-first: `dd-mm-yyyy`. Returns null for null/undefined/empty. Unparseable input is returned as-is (never hidden). */
export function formatDateDMY(value: unknown, timeZone?: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') {
    const m = DATE_ONLY.exec(value);
    if (m) {
      const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
      return validYmd(y, mo, d) ? `${m[3]}-${m[2]}-${m[1]}` : value;
    }
  }
  const date = value instanceof Date ? value : new Date(String(value));
  const p = partsInZone(date, timeZone);
  return p ? `${p.d}-${p.m}-${p.y}` : String(value);
}

/**
 * A moment in time, day-first: `dd-mm-yyyy hh:mm` (24-hour). A date-only value has no
 * time to show and is returned as `dd-mm-yyyy` rather than an invented 00:00.
 */
export function formatDateTimeDMY(value: unknown, timeZone?: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && DATE_ONLY.test(value)) return formatDateDMY(value, timeZone);
  const date = value instanceof Date ? value : new Date(String(value));
  const p = partsInZone(date, timeZone);
  return p ? `${p.d}-${p.m}-${p.y} ${p.hh}:${p.mm}` : String(value);
}

const ISO_IN_TEXT =
  /(?<![\d-])(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}(?::?\d{2})?)?)?(?!\d)/g;

/**
 * Rewrites every ISO date / ISO timestamp inside server-authored free text (error details,
 * notes, freshness explanations) to day-first. Text that merely resembles a date but is not
 * a valid calendar date is left untouched.
 */
export function localiseIsoDatesInText(text: string, timeZone?: string): string {
  return text.replace(ISO_IN_TEXT, (whole, y: string, mo: string, d: string, hh?: string, mi?: string, zone?: string) => {
    if (!validYmd(Number(y), Number(mo), Number(d))) return whole;
    if (hh === undefined || mi === undefined) return `${d}-${mo}-${y}`;
    if (Number(hh) > 23 || Number(mi) > 59) return whole;
    if (!zone) return `${d}-${mo}-${y} ${hh}:${mi}`;
    const normalisedZone = zone === 'Z' ? 'Z' : zone.length === 3 ? `${zone}:00` : zone.includes(':') ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
    const date = new Date(`${y}-${mo}-${d}T${hh}:${mi}:00${normalisedZone}`);
    const p = partsInZone(date, timeZone);
    return p ? `${p.d}-${p.m}-${p.y} ${p.hh}:${p.mm}` : whole;
  });
}

// ---------------------------------------------------------------------------
// Import batches
// ---------------------------------------------------------------------------

export interface BatchLine {
  id: string;
  feedKey: string;
  status: string;
  asOfDate: string | null; // day-first
  /** Raw ISO as-of date, kept for age arithmetic only. Never rendered. */
  asOfIso: string | null;
  startedAt: string | null; // day-first with time
  counts: { read: number | null; accepted: number | null; rejected: number | null; inserted: number | null; unchanged: number | null; superseded: number | null };
  errorText: string | null;
  /** Why this run is shown even though it is not the latest success. Empty for a plain latest-success line. */
  reasons: AttentionReason[];
}

export type AttentionReason =
  | 'not_succeeded' // failed / rolled_back / skipped_* / running
  | 'rejected_rows' // succeeded but rows_rejected > 0
  | 'error_recorded'; // succeeded but an error code was recorded

export interface FeedSummary {
  feedKey: string;
  /** The newest successful run (null when none is in the loaded window). */
  latestSuccess: BatchLine | null;
  /** Successful, clean runs other than the latest one that were collapsed away. */
  hiddenSuccessCount: number;
  /** e.g. "amfi_nav_history: 14 further successful runs hidden, latest 06/10/2026 (read 19, accepted 19)". */
  summaryText: string | null;
  /** latest success is older than the feed's stale threshold (needs a threshold from the caller). */
  stale: { ageDays: number; thresholdDays: number } | null;
  /** The feed is expected to run but has no run at all in the loaded window. */
  noRunRecorded: boolean;
  /** Runs exist but none succeeded. */
  noSuccessfulRun: boolean;
}

export interface ImportBatchView {
  totalRuns: number;
  feeds: FeedSummary[];
  /** Every run that must stay visible regardless of collapse, newest first. */
  attention: BatchLine[];
  /** True when anything on this panel is not plain healthy. */
  needsAttention: boolean;
  /** Everything loaded, newest first, capped at RENDER_ROW_CAP for the "Show all" disclosure. */
  all: BatchLine[];
  allTruncated: boolean;
  hiddenByCollapse: number;
}

export interface ImportBatchOptions {
  /** ISO date the page is "as at"; required for stale judgement. */
  asOfDate?: string;
  /** feedKey -> days without a new run before the feed is reported stale. */
  staleAfterDaysByFeed?: Record<string, number>;
  /** Feeds that are scheduled to run; one with no run in the window is flagged, never silently omitted. */
  expectedFeeds?: readonly string[];
  timeZone?: string;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function sortKey(r: RawRow): string {
  return str(r.started_at) ?? str(r.finished_at) ?? str(r.created_at) ?? str(r.as_of_date) ?? '';
}

function feedKeyOf(r: RawRow): string {
  return str(r.source_config_id) ?? `${str(r.source_key) ?? 'unknown_source'}/${str(r.batch_kind) ?? 'unknown_kind'}`;
}

function attentionReasons(r: RawRow): AttentionReason[] {
  const out: AttentionReason[] = [];
  const status = str(r.status);
  if (status !== 'succeeded') out.push('not_succeeded');
  const rejected = num(r.rows_rejected);
  // Unknown (null) rejected count on a succeeded run is NOT assumed to be zero.
  if (status === 'succeeded' && (rejected === null || rejected > 0)) out.push('rejected_rows');
  if (status === 'succeeded' && str(r.error_code)) out.push('error_recorded');
  return out;
}

function toLine(r: RawRow, index: number, timeZone?: string): BatchLine {
  const code = str(r.error_code);
  const detail = str(r.error_detail);
  return {
    id: str(r.id) ?? `row-${index}`,
    feedKey: feedKeyOf(r),
    status: str(r.status) ?? 'unknown',
    asOfDate: formatDateDMY(r.as_of_date, timeZone),
    asOfIso: str(r.as_of_date),
    startedAt: formatDateTimeDMY(r.started_at, timeZone),
    counts: {
      read: num(r.rows_read),
      accepted: num(r.rows_accepted),
      rejected: num(r.rows_rejected),
      inserted: num(r.rows_inserted),
      unchanged: num(r.rows_unchanged),
      superseded: num(r.rows_superseded),
    },
    errorText: code || detail ? localiseIsoDatesInText(`${code ?? ''}${code && detail ? ': ' : ''}${detail ?? ''}`, timeZone) : null,
    reasons: attentionReasons(r),
  };
}

function daysBetween(fromIso: string, toIso: string): number | null {
  const a = DATE_ONLY.exec(fromIso.slice(0, 10));
  const b = DATE_ONLY.exec(toIso.slice(0, 10));
  if (!a || !b) return null;
  const ms = Date.UTC(Number(b[1]), Number(b[2]) - 1, Number(b[3])) - Date.UTC(Number(a[1]), Number(a[2]) - 1, Number(a[3]));
  return Math.round(ms / 86_400_000);
}

export function summaryTextFor(feedKey: string, hidden: number, latest: BatchLine): string {
  const c = latest.counts;
  const bits = [c.read !== null ? `read ${c.read}` : null, c.accepted !== null ? `accepted ${c.accepted}` : null].filter(Boolean).join(', ');
  return `${feedKey}: ${hidden} further successful run${hidden === 1 ? '' : 's'} hidden, latest ${latest.asOfDate ?? 'date unknown'}${bits ? ` (${bits})` : ''}`;
}

export function buildImportBatchView(rows: readonly RawRow[], options: ImportBatchOptions = {}): ImportBatchView {
  const { asOfDate, staleAfterDaysByFeed = {}, expectedFeeds = [], timeZone } = options;

  // Newest first. Stable for equal timestamps (original order, which the API already sorts desc).
  const ordered = rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const ka = sortKey(a.r);
      const kb = sortKey(b.r);
      return ka === kb ? a.i - b.i : ka < kb ? 1 : -1;
    });

  const lines = ordered.map(({ r }, idx) => toLine(r, idx, timeZone));

  const byFeed = new Map<string, BatchLine[]>();
  for (const l of lines) {
    const list = byFeed.get(l.feedKey);
    if (list) list.push(l);
    else byFeed.set(l.feedKey, [l]);
  }
  for (const key of expectedFeeds) if (!byFeed.has(key)) byFeed.set(key, []);

  // Latest success of each feed = first clean-or-not succeeded line in newest-first order.
  const latestSuccessId = new Set<string>();
  const feeds: FeedSummary[] = [];
  for (const [feedKey, runs] of byFeed) {
    const latestSuccess = runs.find((l) => l.status === 'succeeded') ?? null;
    if (latestSuccess) latestSuccessId.add(latestSuccess.id);
    const hiddenSuccessCount = runs.filter((l) => l.status === 'succeeded' && l.reasons.length === 0 && l !== latestSuccess).length;
    const threshold = staleAfterDaysByFeed[feedKey];
    let stale: FeedSummary['stale'] = null;
    if (latestSuccess && threshold !== undefined && asOfDate) {
      const age = latestSuccess.asOfIso ? daysBetween(latestSuccess.asOfIso, asOfDate) : null;
      if (age !== null && age > threshold) stale = { ageDays: age, thresholdDays: threshold };
    }
    feeds.push({
      feedKey,
      latestSuccess,
      hiddenSuccessCount,
      summaryText: latestSuccess && hiddenSuccessCount > 0 ? summaryTextFor(feedKey, hiddenSuccessCount, latestSuccess) : null,
      stale,
      noRunRecorded: runs.length === 0,
      noSuccessfulRun: runs.length > 0 && !latestSuccess,
    });
  }

  // Feeds needing attention first, then alphabetical (deterministic).
  const feedRank = (f: FeedSummary) => (f.noRunRecorded || f.noSuccessfulRun ? 0 : f.stale ? 1 : 2);
  feeds.sort((a, b) => feedRank(a) - feedRank(b) || a.feedKey.localeCompare(b.feedKey));

  // Anything abnormal stays. A feed's latest success is rendered in its feed row (which carries its
  // own reasons), so it is not repeated in the attention list.
  const attention = lines.filter((l) => l.reasons.length > 0 && !latestSuccessId.has(l.id));
  const hiddenByCollapse = lines.filter((l) => l.reasons.length === 0 && !latestSuccessId.has(l.id)).length;
  const needsAttention =
    attention.length > 0 ||
    feeds.some((f) => f.noRunRecorded || f.noSuccessfulRun || f.stale !== null || (f.latestSuccess?.reasons.length ?? 0) > 0);

  return {
    totalRuns: lines.length,
    feeds,
    attention,
    needsAttention,
    all: lines.slice(0, RENDER_ROW_CAP),
    allTruncated: lines.length > RENDER_ROW_CAP,
    hiddenByCollapse,
  };
}

export function describeBatchLine(l: BatchLine): string {
  const c = l.counts;
  const n = (v: number | null) => (v === null ? 'unknown' : String(v));
  return (
    `${l.status} ${l.feedKey}${l.asOfDate ? ` as at ${l.asOfDate}` : ''}` +
    ` - read ${n(c.read)}, accepted ${n(c.accepted)}, rejected ${n(c.rejected)}, inserted ${n(c.inserted)}, unchanged ${n(c.unchanged)}, superseded ${n(c.superseded)}` +
    (l.errorText ? ` - ${l.errorText}` : '')
  );
}

export function describeReasons(reasons: readonly AttentionReason[]): string {
  return reasons
    .map((r) => (r === 'not_succeeded' ? 'did not succeed' : r === 'rejected_rows' ? 'rows were rejected or the rejected count is unknown' : 'an error was recorded'))
    .join('; ');
}

// ---------------------------------------------------------------------------
// Source corrections
// ---------------------------------------------------------------------------

export interface CorrectionGroup {
  key: string;
  targetTable: string;
  targetRowId: string | null;
  correctionKind: string;
  actorKind: string;
  reason: string;
  count: number;
  firstAt: string | null; // day-first with time
  lastAt: string | null;
  /** A human-made or governance correction (anything but the automatic importer's source_correction). */
  notable: boolean;
}

export interface CorrectionView {
  totalLines: number;
  groups: CorrectionGroup[];
  /** Groups capped at RENDER_ROW_CAP for the "Show all" disclosure. */
  allCapped: CorrectionGroup[];
  allTruncated: boolean;
}

export function buildCorrectionView(rows: readonly RawRow[], timeZone?: string): CorrectionView {
  const acc = new Map<string, CorrectionGroup & { firstRaw: string; lastRaw: string }>();
  for (const r of rows) {
    const targetTable = str(r.target_table) ?? 'unknown_table';
    const targetRowId = str(r.target_row_id);
    const correctionKind = str(r.correction_kind) ?? 'unknown_kind';
    const actorKind = str(r.actor_kind) ?? 'unknown_actor';
    const reason = localiseIsoDatesInText(str(r.reason) ?? '', timeZone);
    const key = JSON.stringify([targetTable, targetRowId, correctionKind, actorKind, reason]);
    const at = str(r.created_at) ?? '';
    const cur = acc.get(key);
    if (cur) {
      cur.count += 1;
      if (at && (cur.firstRaw === '' || at < cur.firstRaw)) cur.firstRaw = at;
      if (at && at > cur.lastRaw) cur.lastRaw = at;
    } else {
      acc.set(key, {
        key,
        targetTable,
        targetRowId,
        correctionKind,
        actorKind,
        reason,
        count: 1,
        firstAt: null,
        lastAt: null,
        notable: !(correctionKind === 'source_correction' && actorKind === 'system_import'),
        firstRaw: at,
        lastRaw: at,
      });
    }
  }
  const groups = [...acc.values()]
    .map(({ firstRaw, lastRaw, ...g }) => ({ ...g, firstAt: formatDateTimeDMY(firstRaw || null, timeZone), lastAt: formatDateTimeDMY(lastRaw || null, timeZone), _last: lastRaw }))
    .sort((a, b) => Number(b.notable) - Number(a.notable) || (a._last < b._last ? 1 : a._last > b._last ? -1 : 0))
    .map((g) => ({ key: g.key, targetTable: g.targetTable, targetRowId: g.targetRowId, correctionKind: g.correctionKind, actorKind: g.actorKind, reason: g.reason, count: g.count, firstAt: g.firstAt, lastAt: g.lastAt, notable: g.notable }));
  return {
    totalLines: rows.length,
    groups,
    allCapped: groups.slice(0, RENDER_ROW_CAP),
    allTruncated: groups.length > RENDER_ROW_CAP,
  };
}
