// Registry: one shared engine, separate canonical adapters. v1 supports ONLY
// article and money_update. A Guide / FHIP Explainer adapter could be added
// here later by implementing the same four files (schema, validation, mapper,
// template); none is built now.

import type { AdapterHooks } from './validation';
import { ARTICLE_HOOKS } from './article/validation';
import { ARTICLE_SCHEMA } from './article/schema';
import { ARTICLE_TEMPLATE_INTRO, ARTICLE_TEMPLATE_NOTES } from './article/template';
import { MONEY_UPDATE_HOOKS } from './money-update/validation';
import { MONEY_UPDATE_SCHEMA } from './money-update/schema';
import { MONEY_UPDATE_TEMPLATE_INTRO, MONEY_UPDATE_TEMPLATE_NOTES } from './money-update/template';
import type { ImportContentType, ImportSchema } from './types';

export interface ImportAdapter {
  contentType: ImportContentType;
  schema: ImportSchema;
  hooks: AdapterHooks;
  templateIntro: string[];
  templateNotes: string[];
  /** Admin route that opens the normal editor for an imported draft of this type. */
  editRoute: (postId: string) => string;
  listRoute: string;
}

const ADAPTERS: Record<ImportContentType, ImportAdapter> = {
  article: {
    contentType: 'article',
    schema: ARTICLE_SCHEMA,
    hooks: ARTICLE_HOOKS,
    templateIntro: ARTICLE_TEMPLATE_INTRO,
    templateNotes: ARTICLE_TEMPLATE_NOTES,
    editRoute: (id) => `/admin/resources/content/${id}/edit`,
    listRoute: '/admin/resources/content/drafts',
  },
  money_update: {
    contentType: 'money_update',
    schema: MONEY_UPDATE_SCHEMA,
    hooks: MONEY_UPDATE_HOOKS,
    templateIntro: MONEY_UPDATE_TEMPLATE_INTRO,
    templateNotes: MONEY_UPDATE_TEMPLATE_NOTES,
    editRoute: (id) => `/admin/resources/money-updates/${id}/edit`,
    listRoute: '/admin/resources/money-updates',
  },
};

export function getImportAdapter(type: ImportContentType): ImportAdapter {
  return ADAPTERS[type];
}
