// R1.4 Money Update structured starter template — spec §43: "Prefer
// specialist structured sections. Do not require editor to manually
// reconstruct headings every time." Reuses the R1.3 block model/editor
// completely unchanged (createBlock, BlockEditor, BlockRenderer) — this is
// only a starter template, the same mechanism starterTemplateFor() already
// uses for Article/Guide/FHIP Explainer, extended to the Money Update
// structure the approved spec defines. Every block remains fully editable/
// removable after insertion, and additional blocks may be appended after the
// structured core (spec §43: "Allow optional additional blocks after the
// structured core if useful").
//
// "Summary / 30-second explanation" (spec §42) reuses the existing
// `excerpt` field, same as every other content type — not a block.
// "Official Sources" (spec §42/§49) is handled by the dedicated source
// picker (resource_sources/resource_post_sources), not a content block —
// keeping citations as structured, linkable rows rather than free text.

import { createBlock, type ContentBlock, type HeadingData, type ParagraphData } from '@/lib/resources/editor/blocks';

function heading(text: string): ContentBlock {
  return { ...createBlock('heading'), data: { level: 2, text } satisfies HeadingData };
}
function paragraph(): ContentBlock {
  return { ...createBlock('paragraph'), data: { text: '' } satisfies ParagraphData };
}

export function starterTemplateForMoneyUpdate(): ContentBlock[] {
  return [
    heading('What Happened?'),
    paragraph(),
    heading('Why Does It Matter?'),
    paragraph(),
    heading('Who May Be Affected?'),
    paragraph(),
    heading('What Does This Mean for Your Financial Health?'),
    paragraph(),
    heading('How FHIP Can Help You Monitor It'),
    paragraph(),
  ];
}

// A Money Update Template (spec §44) starts from the same section headings
// but with explanatory placeholder guidance instead of blank paragraphs, so
// a future "Create Update from Template" clone (spec §45) has meaningful
// starting text to overwrite rather than an empty page.
export function starterTemplateForMoneyUpdateTemplate(): ContentBlock[] {
  return [
    heading('What Happened?'),
    { ...createBlock('paragraph'), data: { text: 'Describe the financial development in one or two plain-English paragraphs.' } satisfies ParagraphData },
    heading('Why Does It Matter?'),
    { ...createBlock('paragraph'), data: { text: 'Explain the practical significance — what changes for someone reading this.' } satisfies ParagraphData },
    heading('Who May Be Affected?'),
    { ...createBlock('paragraph'), data: { text: 'Name the group(s) affected, e.g. first-home buyers, retirees, self-managed super fund holders.' } satisfies ParagraphData },
    heading('What Does This Mean for Your Financial Health?'),
    { ...createBlock('paragraph'), data: { text: 'Connect the development to the reader’s own financial health — what should they check or consider.' } satisfies ParagraphData },
    heading('How FHIP Can Help You Monitor It'),
    { ...createBlock('paragraph'), data: { text: 'Reference the relevant FHIP module/score that helps the reader track this over time.' } satisfies ParagraphData },
  ];
}
