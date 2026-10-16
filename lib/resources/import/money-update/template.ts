// Money Update upload adapter -- template wording (the PO's v1 contract). Headers,
// required flags, enums and the example row come from the canonical schema.

import { IMPORT_LIMITS } from '../types';

export const MONEY_UPDATE_TEMPLATE_INTRO: string[] = [
  'FHIP Resources: Money Update upload template (version 1.0)',
  'Paste one finished Money Update per row into the Money_Update_Upload sheet, then upload the file under Resources > Bulk Upload > Money Updates.',
  'Every uploaded Money Update becomes a PRIVATE DRAFT with freshness set to time-sensitive. Nothing is published, scheduled or approved by uploading. The normal Resources review and approval workflow still applies.',
  'Your rows go on the Money_Update_Upload sheet. When you upload, you choose which sheet to import (it is preselected); the other sheets (Instructions, Lookup_Values, Example_Money_Update) are never imported.',
  'The five finished sections (what happened, why it matters, who may be affected, financial health impact, how FHIP can help) become the real Money Update sections you can edit in the normal Money Update editor.',
];

export const MONEY_UPDATE_TEMPLATE_NOTES: string[] = [
  `Each file may hold up to ${IMPORT_LIMITS.maxRows} rows (and 10 MB). For more, split the file and upload the parts one at a time.`,
  'Event date is required and cannot be in the future. At least one of next review date or expiry date is required.',
  'At least one source is required. Links must start with https://.',
  'Category, tags and CTAs must already exist. They are matched by exact name or slug and are never created by an upload.',
  'Each section may use paragraphs, bullet lists (- item), numbered lists (1. item) and ### sub-headings. Raw HTML is rejected.',
];
