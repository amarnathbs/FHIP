// Money Update upload adapter -- the PO's existing v1 contract
// (FHIP_Money_Update_Upload_Template_v1). Column order and names are fixed by
// that contract and must not be redesigned here.
//
// The five body fields are finished content mapped into the existing Money
// Update content_blocks sections.

import {
  COL_COMPLIANCE,
  COL_DIFFICULTY,
  COL_EXCERPT,
  COL_EXPIRES,
  COL_EXTERNAL_ID,
  COL_IS_INDEXABLE,
  COL_JURISDICTION,
  COL_NEXT_REVIEW,
  COL_PRIMARY_CATEGORY,
  COL_PRIMARY_CTA,
  COL_SECONDARY_CTA,
  COL_SEO_DESCRIPTION,
  COL_SEO_TITLE,
  COL_SLUG,
  COL_TAGS,
  COL_TEMPLATE_VERSION,
  COL_TITLE,
  sourceColumns,
} from '../common-schema';
import { TEMPLATE_VERSION, type ColumnSpec, type ImportSchema } from '../types';

const SECTION_MAX = 10000;

function section(key: string, label: string, help: string, example: string): ColumnSpec {
  return { key, kind: 'long_text', required: true, label, help: `${help} Plain paragraphs, bullet lists (lines starting with - ) and numbered lists are allowed; raw HTML is rejected.`, example, maxLength: SECTION_MAX };
}

export const MONEY_UPDATE_SCHEMA: ImportSchema = {
  contentType: 'money_update',
  templateVersion: TEMPLATE_VERSION,
  uploadSheetName: 'Money_Update_Upload',
  exampleSheetName: 'Example_Money_Update',
  templateFileBase: 'FHIP_Money_Update_Upload_Template_v1',
  columns: [
    COL_TEMPLATE_VERSION,
    COL_EXTERNAL_ID,
    COL_TITLE,
    COL_SLUG,
    COL_JURISDICTION,
    COL_DIFFICULTY,
    COL_COMPLIANCE,
    {
      key: 'event_date',
      kind: 'date',
      required: true,
      label: 'Event date',
      help: 'The real-world date the development happened. Required, and not in the future. File format: year-month-day with hyphens, for example 2026-09-30.',
      example: '2026-09-30',
    },
    { ...COL_NEXT_REVIEW, help: `${COL_NEXT_REVIEW.help} A Money Update needs a next review date or an expiry date (at least one of the two).` },
    { ...COL_EXPIRES, help: `${COL_EXPIRES.help} A Money Update needs a next review date or an expiry date (at least one of the two).` },
    {
      key: 'affected_audience',
      kind: 'text',
      required: false,
      label: 'Affected audience',
      help: 'A short phrase naming who is affected, for example first-home buyers. Up to 300 characters.',
      example: 'Households with a variable-rate home loan',
      maxLength: 300,
    },
    COL_EXCERPT,
    section('what_happened', 'What happened', 'The development in one or two plain-English paragraphs.', 'The Reserve Bank held the cash rate at 3.60 percent at its September meeting.'),
    section('why_it_matters', 'Why it matters', 'Why a reader should care.', 'Variable-rate repayments are unlikely to change this month, which keeps monthly budgets steady.'),
    section('who_may_be_affected', 'Who may be affected', 'The groups affected.', 'Households with variable-rate loans and savers holding cash in online savings accounts.'),
    section('financial_health_impact', 'Financial health impact', 'How the development connects to the reader’s financial health.', 'Stable repayments protect the debt servicing ratio; check your emergency buffer still covers three months of costs.'),
    section('how_fhip_can_help', 'How FHIP can help', 'How FHIP can help the reader monitor this.', 'Your Financial Health dashboard shows your debt servicing ratio and updates when you change your loan rate.'),
    COL_PRIMARY_CATEGORY,
    COL_TAGS,
    COL_PRIMARY_CTA,
    COL_SECONDARY_CTA,
    COL_SEO_TITLE,
    COL_SEO_DESCRIPTION,
    COL_IS_INDEXABLE,
    ...sourceColumns(),
  ],
};
