// Article upload adapter -- finished body fields -> canonical content_blocks.
//
// Output order mirrors the existing Article starter (lib/resources/editor/
// blocks.ts starterTemplateFor('article')): callout ("30-second answer"),
// key_takeaways, the article body, example, then the H2 "What this means for
// your financial health" section. A blank optional field produces NO block (no
// empty visible block is ever created).

import { checkInlineText, deterministicBlockId, parseLineList, parseRestrictedMarkdown, type MarkupBlock } from '../markup';

export const FINANCIAL_HEALTH_HEADING = 'What this means for your financial health';

export interface ArticleBodyInput {
  seed: string;
  quick_answer: string;
  key_takeaways: string;
  main_content: string;
  example: string;
  financial_health_meaning: string;
}

export type ArticleBodyResult =
  | { ok: true; blocks: MarkupBlock[] }
  | { ok: false; problems: { field: 'quick_answer' | 'key_takeaways' | 'main_content' | 'example' | 'financial_health_meaning'; reasons: string[] }[] };

export function mapArticleBody(input: ArticleBodyInput): ArticleBodyResult {
  const problems: Extract<ArticleBodyResult, { ok: false }>['problems'] = [];
  const blocks: MarkupBlock[] = [];
  let idx = 0;
  const id = () => deterministicBlockId(input.seed, idx++);

  const quick = input.quick_answer.trim();
  if (quick) {
    const reasons = checkInlineText(quick);
    if (reasons.length > 0) problems.push({ field: 'quick_answer', reasons });
    else blocks.push({ id: id(), type: 'callout', data: { text: quick } });
  }

  const take = input.key_takeaways.trim();
  if (take) {
    const { items, reasons } = parseLineList(take);
    if (reasons.length > 0) problems.push({ field: 'key_takeaways', reasons });
    else if (items.length > 0) blocks.push({ id: id(), type: 'key_takeaways', data: { items } });
  }

  const main = parseRestrictedMarkdown(input.main_content, { seed: input.seed, startIndex: idx });
  if (!main.ok) problems.push({ field: 'main_content', reasons: main.reasons });
  else {
    blocks.push(...main.blocks);
    idx += main.blocks.length;
  }

  const example = input.example.trim();
  if (example) {
    const reasons = checkInlineText(example);
    if (reasons.length > 0) problems.push({ field: 'example', reasons });
    else blocks.push({ id: id(), type: 'example', data: { text: example } });
  }

  const fh = input.financial_health_meaning.trim();
  if (fh) {
    const parsed = parseRestrictedMarkdown(fh, { seed: input.seed, startIndex: idx + 1, allowH2: false });
    if (!parsed.ok) problems.push({ field: 'financial_health_meaning', reasons: parsed.reasons });
    else if (parsed.blocks.length > 0) {
      blocks.push({ id: id(), type: 'heading', data: { level: 2, text: FINANCIAL_HEALTH_HEADING } });
      blocks.push(...parsed.blocks);
    }
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, blocks };
}
