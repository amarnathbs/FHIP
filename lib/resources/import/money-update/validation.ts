// Money Update upload adapter -- type-specific validation + mapping hooks.
//
// Forced by the framework regardless of the file: content_type=money_update,
// status=draft, visibility=private, freshness_type=time_sensitive,
// is_indexable=false. This adapter adds: event_date required and not in the
// future; at least one of next_review_at / expires_at; at least one source; all
// five finished body sections.

import { RowIssues, FILE_DATE_HINT, displayDate, parseFileDate, type AdapterBuild, type AdapterHooks, type CommonFields, type IndexedRefs } from '../validation';
import type { RawImportRow } from '../types';
import { MONEY_UPDATE_SCHEMA } from './schema';
import { MONEY_UPDATE_SECTIONS, mapMoneyUpdateBody, type MoneyUpdateSectionKey } from './mapper';

/** The event date may be "today" in any timezone the product serves (Australia and India are ahead of UTC): allow one day of slack. */
function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const MONEY_UPDATE_HOOKS: AdapterHooks = {
  schema: MONEY_UPDATE_SCHEMA,
  build(raw: RawImportRow, common: CommonFields, _refs: IndexedRefs, issues: RowIssues, todayIso: string): AdapterBuild {
    const get = (k: string) => (raw.values[k] ?? '').trim();

    // ---- event date ----
    let event_date: string | null = null;
    const evRaw = get('event_date');
    if (!evRaw) issues.error('MISSING_REQUIRED_VALUE', 'event_date', 'Event date is required for a Money Update.');
    else {
      const d = parseFileDate(evRaw);
      if (!d) issues.error('INVALID_DATE', 'event_date', `Event date is not a valid date. ${FILE_DATE_HINT}`);
      else if (d > addDaysIso(todayIso, 1)) issues.error('FUTURE_EVENT_DATE', 'event_date', `The event date (${displayDate(d, common.jurisdiction)}) is in the future. A Money Update records something that has already happened.`);
      else event_date = d;
    }

    // ---- freshness: at least one of next review / expiry ----
    if (!common.next_review_at && !common.expires_at) {
      issues.error('MISSING_REVIEW_OR_EXPIRY', 'next_review_at', 'A Money Update needs a next review date or an expiry date (at least one of the two).');
    }

    // ---- sources: at least one ----
    // (A source that was filled in but is itself invalid already carries its own specific error; do not pile a
    // misleading "no source" on top of it.)
    const attempted = Object.entries(raw.values).some(([k, val]) => /^source_\d+_(?!is_public)/.test(k) && val.trim() !== '');
    if (common.sources.length === 0 && !attempted) {
      issues.error('SOURCE_REQUIRED', 'source_1_name', 'A Money Update needs at least one source. Fill in the source 1 columns.');
    }

    // ---- five finished sections ----
    const sections = {} as Record<MoneyUpdateSectionKey, string>;
    for (const s of MONEY_UPDATE_SECTIONS) {
      sections[s.key] = get(s.key);
      if (!sections[s.key]) issues.error('MISSING_REQUIRED_VALUE', s.key, `${s.heading.replace(/\?$/, '')} is required: the five Money Update sections are finished content.`);
    }
    let content_blocks: unknown[] = [];
    if (MONEY_UPDATE_SECTIONS.every((s) => sections[s.key])) {
      const mapped = mapMoneyUpdateBody(`money_update:${common.external_id ?? common.slug ?? raw.rowNumber}`, sections);
      if (!mapped.ok) {
        for (const p of mapped.problems) {
          issues.error('UNSUPPORTED_MARKUP', p.field, `Unsupported content (${p.reasons.slice(0, 3).join('; ')}). Allowed: paragraphs, bullet lists, numbered lists, ### sub-headings, **bold**, _italic_ and https links.`);
        }
      } else content_blocks = mapped.blocks;
    }

    const audience = get('affected_audience');
    return {
      freshness_type: 'time_sensitive',
      event_date,
      affected_audience: audience || null,
      author_id: null,
      author_label: null,
      content_blocks,
    };
  },
};
