// PO review F3 (06/10/2026) — an in-memory, UNSAVED Money Update / Template.
// Opening "Create Money Update" writes nothing; the record is created when the
// author presses Save. Defaults match createMoneyUpdateDraft exactly.

import { blankEditorPost } from '@/lib/resources/editor/blankPost';
import { starterTemplateForMoneyUpdate, starterTemplateForMoneyUpdateTemplate } from './blocks';
import type { MoneyUpdateContentType, MoneyUpdateEditorPost } from './types';

export function blankMoneyUpdatePost(contentType: MoneyUpdateContentType, userId: string | null): MoneyUpdateEditorPost {
  const base = blankEditorPost('article', userId);
  return {
    ...base,
    content_type: contentType,
    content_blocks: contentType === 'money_update_template' ? starterTemplateForMoneyUpdateTemplate() : starterTemplateForMoneyUpdate(),
    // Money Updates are inherently time-sensitive by default (spec 46); a
    // Template is structural, not itself time-sensitive content.
    freshness_type: contentType === 'money_update_template' ? 'evergreen' : 'time_sensitive',
    event_date: null,
    affected_audience: null,
    sources: [],
  };
}
