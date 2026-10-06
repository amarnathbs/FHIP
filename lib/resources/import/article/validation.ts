// Article upload adapter -- type-specific validation + mapping hooks.

import { ARTICLE_FRESHNESS_VALUES } from '../common-schema';
import { RowIssues, resolveEnum, type AdapterBuild, type AdapterHooks, type CommonFields, type IndexedRefs } from '../validation';
import type { RawImportRow } from '../types';
import { ARTICLE_SCHEMA } from './schema';
import { mapArticleBody } from './mapper';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resolveAuthor(raw: string, refs: IndexedRefs, issues: RowIssues): { id: string | null; label: string | null } {
  const t = raw.trim();
  if (!t) {
    issues.warn('AUTHOR_MISSING', 'author', 'No author. The draft can be saved, but an author must be set before it can go to review.');
    return { id: null, label: null };
  }
  const key = t.toLowerCase();
  // 1. stable identifiers first: author id, then author slug (the stable code)
  const hit = (UUID_RE.test(t) ? refs.authorsById.get(key) : undefined) ?? refs.authorsBySlug.get(key);
  if (hit) return { id: hit.id, label: hit.display_name };
  // 2. exact, UNIQUE display name
  const byName = refs.authorsByName.get(key) ?? [];
  if (byName.length === 1) return { id: byName[0].id, label: byName[0].display_name };
  if (byName.length > 1) {
    issues.error('AMBIGUOUS_AUTHOR', 'author', `More than one active author is named "${t}". Use the author slug instead.`);
    return { id: null, label: null };
  }
  issues.error('UNKNOWN_AUTHOR', 'author', `"${t}" is not an existing, active author. Use the author slug or exact display name; authors are never created by an upload.`);
  return { id: null, label: null };
}

export const ARTICLE_HOOKS: AdapterHooks = {
  schema: ARTICLE_SCHEMA,
  build(raw: RawImportRow, common: CommonFields, refs: IndexedRefs, issues: RowIssues): AdapterBuild {
    const v = raw.values;
    const get = (k: string) => (v[k] ?? '').trim();

    // ---- freshness ----
    let freshness_type = 'evergreen';
    const fRaw = get('freshness_type');
    if (fRaw) {
      const f = resolveEnum(fRaw, ARTICLE_FRESHNESS_VALUES);
      if (!f) issues.error('INVALID_ENUM', 'freshness_type', `Freshness type must be one of: ${ARTICLE_FRESHNESS_VALUES.join(', ')}.`);
      else freshness_type = f;
    }
    if (freshness_type === 'time_sensitive' && !common.next_review_at && !common.expires_at) {
      issues.error('MISSING_REVIEW_OR_EXPIRY', 'next_review_at', 'A time-sensitive article needs a next review date or an expiry date.');
    }

    // ---- author ----
    const author = resolveAuthor(get('author'), refs, issues);

    // ---- finished body -> content_blocks ----
    const main = get('main_content');
    let content_blocks: unknown[] = [];
    if (!main) {
      issues.error('ARTICLE_BODY_EMPTY', 'main_content', 'The article body (main content) is empty.');
    } else {
      const seed = `article:${common.external_id ?? common.slug ?? raw.rowNumber}`;
      const mapped = mapArticleBody({
        seed,
        quick_answer: get('quick_answer'),
        key_takeaways: get('key_takeaways'),
        main_content: main,
        example: get('example'),
        financial_health_meaning: get('financial_health_meaning'),
      });
      if (!mapped.ok) {
        for (const p of mapped.problems) {
          issues.error('UNSUPPORTED_ARTICLE_MARKUP', p.field, `Unsupported content (${p.reasons.slice(0, 3).join('; ')}). Allowed: ## and ### headings, paragraphs, bullet lists, numbered lists, **bold**, _italic_ and https links.`);
        }
      } else if (mapped.blocks.length === 0) {
        issues.error('ARTICLE_BODY_EMPTY', 'main_content', 'The article body contains no usable content.');
      } else content_blocks = mapped.blocks;
    }

    return {
      freshness_type,
      event_date: null,
      affected_audience: null,
      author_id: author.id,
      author_label: author.label,
      content_blocks,
    };
  },
};
