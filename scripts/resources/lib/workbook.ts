// R1.7 — R0-A workbook parser. Reads the approved Content Master workbook
// with the `xlsx` (SheetJS) library and returns plain typed row objects.
// This module does NO validation and NO database work — it only turns the
// raw spreadsheet into arrays of objects keyed by the workbook's own header
// row, so every other module (validators, mapping, importer) works against
// stable field names instead of column letters.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as XLSX from 'xlsx';

export const CONTENT_MASTER_HEADERS = [
  'Content_ID', 'Title', 'Content_Type', 'Primary_Category', 'Subcategory', 'Jurisdiction',
  'Audience_Level', 'User_Question_Search_Intent', 'Primary_Keyword_Theme', 'Editorial_Brief',
  'Key_Points_to_Cover', 'Primary_FHIP_Module', 'Secondary_FHIP_Module', 'Primary_CTA',
  'GKTC_Video_Linkage', 'YouTube_Channel', 'Risk_Class', 'Freshness_Type', 'Review_Cycle_Months',
  'Launch_Priority', 'Launch_Wave', 'Recommended_Length', 'Recommended_Visual',
  'Primary_Source_Hierarchy', 'SEO_Pillar', 'Related_Content_Cluster', 'Conversion_Goal',
  'Proposed_URL', 'Status', 'Owner', 'Notes',
] as const;

export interface ContentMasterRow {
  Content_ID: string;
  Title: string;
  Content_Type: string;
  Primary_Category: string;
  Subcategory: string;
  Jurisdiction: string;
  Audience_Level: string;
  User_Question_Search_Intent: string;
  Primary_Keyword_Theme: string;
  Editorial_Brief: string;
  Key_Points_to_Cover: string;
  Primary_FHIP_Module: string;
  Secondary_FHIP_Module: string;
  Primary_CTA: string;
  GKTC_Video_Linkage: string;
  YouTube_Channel: string;
  Risk_Class: string;
  Freshness_Type: string;
  Review_Cycle_Months: number | null;
  Launch_Priority: string;
  Launch_Wave: string;
  Recommended_Length: string;
  Recommended_Visual: string;
  Primary_Source_Hierarchy: string;
  SEO_Pillar: string;
  Related_Content_Cluster: string;
  Conversion_Goal: string;
  Proposed_URL: string;
  Status: string;
  Owner: string;
  Notes: string;
  /** 1-based row number in the source sheet (header = row 1), for error messages. */
  __row: number;
}

export interface MoneyUpdateTemplateRow {
  Content_ID: string;
  Title: string;
  Jurisdiction: string;
  Subcategory: string;
  Editorial_Brief: string;
  Key_Points_to_Cover: string;
  Risk_Class: string;
  Review_Cycle_Months: number | null;
  Proposed_URL: string;
  Status: string;
  __row: number;
}

export interface GktcVideoPlanRow {
  Content_ID: string;
  Title: string;
  Subcategory: string;
  Jurisdiction: string;
  Editorial_Brief: string;
  Primary_CTA: string;
  Launch_Priority: string;
  Launch_Wave: string;
  Recommended_Length: string;
  Proposed_URL: string;
  Status: string;
  __row: number;
}

export interface TaxonomyRow {
  Category: string;
  'Primary Module': string;
  'Secondary Module': string;
  'Default CTA': string;
  'Default Visual': string;
  'Primary Source Hierarchy': string;
  'SEO Pillar': string;
}

export interface CtaLibraryRow {
  'CTA ID': string;
  Label: string;
  Destination: string;
  'Use When': string;
}

export interface ParsedWorkbook {
  sourceHash: string;
  sheetNames: string[];
  contentMaster: ContentMasterRow[];
  moneyUpdateTemplates: MoneyUpdateTemplateRow[];
  gktcVideoPlan: GktcVideoPlanRow[];
  taxonomy: TaxonomyRow[];
  ctaLibrary: CtaLibraryRow[];
}

function sha256OfFile(path: string): string {
  const buf = readFileSync(path);
  return createHash('sha256').update(buf).digest('hex');
}

function sheetToObjects<T>(wb: XLSX.WorkBook, sheetName: string): { rows: T[]; sparse: number[] } {
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error(`Workbook is missing required sheet "${sheetName}"`);
  // defval: '' so a genuinely blank cell becomes '' rather than being
  // omitted from the row object entirely (spec §72: never silently drop a
  // partially-populated row — we need every column key present to detect
  // partial population downstream).
  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '', raw: true });
  const rows: T[] = [];
  const sparse: number[] = [];
  raw.forEach((r, i) => {
    const values = Object.values(r);
    const nonBlank = values.filter((v) => v !== '' && v !== null && v !== undefined).length;
    if (nonBlank === 0) return; // genuinely blank trailing row — ignore (spec §72)
    if (nonBlank > 0 && nonBlank < values.length * 0.3) {
      sparse.push(i + 2); // +2: header is row 1, data starts row 2
    }
    (r as Record<string, unknown> & { __row: number }).__row = i + 2;
    rows.push(r as T);
  });
  return { rows, sparse };
}

export function parseWorkbook(path: string): { workbook: ParsedWorkbook; sparseRowWarnings: string[] } {
  const sourceHash = sha256OfFile(path);
  const buf = readFileSync(path);
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: false });

  const warnings: string[] = [];

  const cm = sheetToObjects<ContentMasterRow>(wb, 'Content_Master');
  cm.sparse.forEach((r) => warnings.push(`Content_Master row ${r} is only partially populated (kept, not dropped)`));

  const mut = sheetToObjects<MoneyUpdateTemplateRow>(wb, 'Money_Update_Templates');
  const gvp = sheetToObjects<GktcVideoPlanRow>(wb, 'GKTC_Video_Plan');
  const tax = sheetToObjects<TaxonomyRow>(wb, 'Taxonomy');
  const ctaLib = sheetToObjects<CtaLibraryRow>(wb, 'CTA_Library');

  // Trim every string cell (workbook authors sometimes leave trailing
  // whitespace; normalizing here means every downstream consumer works with
  // clean values without re-implementing this).
  function trimRow<T extends object>(r: T): T {
    const out: Record<string, unknown> = { ...(r as Record<string, unknown>) };
    for (const k of Object.keys(out)) {
      if (typeof out[k] === 'string') out[k] = (out[k] as string).trim();
    }
    return out as T;
  }

  return {
    workbook: {
      sourceHash,
      sheetNames: wb.SheetNames,
      contentMaster: cm.rows.map(trimRow),
      moneyUpdateTemplates: mut.rows.map(trimRow),
      gktcVideoPlan: gvp.rows.map(trimRow),
      taxonomy: tax.rows.map(trimRow),
      ctaLibrary: ctaLib.rows.map(trimRow),
    },
    sparseRowWarnings: warnings,
  };
}
