// Money Update upload adapter -- the five finished body fields -> the existing
// Money Update content_blocks sections.
//
// Headings reuse the SAME wording as the manual Money Update starter
// (lib/resources/money-update/blocks.ts starterTemplateForMoneyUpdate) so an
// imported draft is structurally identical to one authored by hand and opens in
// the normal MoneyUpdateEditor unchanged.

import { deterministicBlockId, parseRestrictedMarkdown, type MarkupBlock } from '../markup';

export const MONEY_UPDATE_SECTIONS = [
  { key: 'what_happened', heading: 'What Happened?' },
  { key: 'why_it_matters', heading: 'Why Does It Matter?' },
  { key: 'who_may_be_affected', heading: 'Who May Be Affected?' },
  { key: 'financial_health_impact', heading: 'What Does This Mean for Your Financial Health?' },
  { key: 'how_fhip_can_help', heading: 'How FHIP Can Help You Monitor It' },
] as const;
export type MoneyUpdateSectionKey = (typeof MONEY_UPDATE_SECTIONS)[number]['key'];

export type MoneyUpdateBodyResult = { ok: true; blocks: MarkupBlock[] } | { ok: false; problems: { field: MoneyUpdateSectionKey; reasons: string[] }[] };

export function mapMoneyUpdateBody(seed: string, sections: Record<MoneyUpdateSectionKey, string>): MoneyUpdateBodyResult {
  const blocks: MarkupBlock[] = [];
  const problems: Extract<MoneyUpdateBodyResult, { ok: false }>['problems'] = [];
  let idx = 0;
  for (const s of MONEY_UPDATE_SECTIONS) {
    const body = (sections[s.key] ?? '').trim();
    if (!body) continue; // required-ness is a validation concern, not a mapping one
    const headingId = deterministicBlockId(seed, idx++);
    // The section heading is ours; a section body may use ### sub-headings but never ##.
    const parsed = parseRestrictedMarkdown(body, { seed, startIndex: idx, allowH2: false });
    if (!parsed.ok) {
      problems.push({ field: s.key, reasons: parsed.reasons });
      continue;
    }
    idx += parsed.blocks.length;
    blocks.push({ id: headingId, type: 'heading', data: { level: 2, text: s.heading } }, ...parsed.blocks);
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, blocks };
}
