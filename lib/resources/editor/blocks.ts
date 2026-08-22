// R1.3 structured content block model — spec §22-31.
//
// Deliberately NOT arbitrary HTML (spec §22: "Do not store arbitrary
// executable HTML. Content must remain structured."). Every block is a
// plain-data object; the "rich text" fields inside a block's `data` are
// plain strings using the restrained inline markup handled by richtext.ts
// (bold/italic/link only, never real HTML — see that file's header for why
// this sidesteps the sanitisation problem entirely rather than solving it
// with a dependency).
//
// content_blocks itself is guaranteed to be a JSON array by a DB CHECK
// constraint (chk_resource_posts_content_blocks_is_array, migration 0033)
// — this module is the application-level guarantee that every element in
// that array has a stable id, a known type, and data matching that type's
// shape (spec §23).

export type BlockType =
  | 'paragraph'
  | 'heading'
  | 'bulleted_list'
  | 'numbered_list'
  | 'key_takeaways'
  | 'callout'
  | 'example'
  | 'warning'
  | 'quote'
  | 'divider'
  | 'fhip_context'
  | 'table';

export interface ParagraphData {
  text: string;
}
export interface HeadingData {
  level: 2 | 3 | 4; // H1 is the page title — body content may never create an H1 (spec §24/§122)
  text: string;
}
export interface ListData {
  items: string[];
}
export interface CalloutLikeData {
  text: string;
}
export interface QuoteData {
  text: string;
  attribution?: string;
}
export interface TableData {
  headers: string[];
  rows: string[][];
}
export type DividerData = Record<string, never>;

export interface ContentBlock<TType extends BlockType = BlockType, TData = unknown> {
  id: string;
  type: TType;
  data: TData;
}

// A block whose `type` this build doesn't recognise (e.g. authored by a
// future R1.4+ editor, or hand-edited data). Preserved verbatim on save so
// the editor never corrupts content it doesn't understand (spec §25: "must
// still be able to render existing valid block types without corrupting
// them").
export interface UnknownBlock {
  id: string;
  type: string;
  data: unknown;
}

export type AnyBlock = ContentBlock | UnknownBlock;

export const BLOCK_TYPE_LABELS: Record<BlockType, string> = {
  paragraph: 'Paragraph',
  heading: 'Heading',
  bulleted_list: 'Bulleted List',
  numbered_list: 'Numbered List',
  key_takeaways: 'Key Takeaways',
  callout: 'Callout',
  example: 'Example',
  warning: 'Warning / Important',
  quote: 'Quote',
  divider: 'Divider',
  fhip_context: 'What This Means in FHIP',
  table: 'Table',
};

// Grouped for the Add Block menu (spec §31).
export const BLOCK_MENU_GROUPS: { label: string; types: BlockType[] }[] = [
  { label: 'Text', types: ['paragraph', 'heading', 'quote'] },
  { label: 'Structure', types: ['bulleted_list', 'numbered_list', 'divider', 'table'] },
  { label: 'Financial Education', types: ['key_takeaways', 'example', 'callout', 'warning', 'fhip_context'] },
];

function newId(): string {
  // crypto.randomUUID is available in both the browser and Node 19+ (this
  // project's engines.node >=24.18.0) — no uuid dependency needed.
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `block-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createBlock(type: BlockType): ContentBlock {
  const id = newId();
  switch (type) {
    case 'paragraph':
      return { id, type, data: { text: '' } satisfies ParagraphData };
    case 'heading':
      return { id, type, data: { level: 2, text: '' } satisfies HeadingData };
    case 'bulleted_list':
    case 'numbered_list':
      return { id, type, data: { items: [''] } satisfies ListData };
    case 'key_takeaways':
      return { id, type, data: { items: ['', ''] } satisfies ListData };
    case 'callout':
    case 'example':
    case 'warning':
    case 'fhip_context':
      return { id, type, data: { text: '' } satisfies CalloutLikeData };
    case 'quote':
      return { id, type, data: { text: '', attribution: '' } satisfies QuoteData };
    case 'divider':
      return { id, type, data: {} satisfies DividerData };
    case 'table':
      return { id, type, data: { headers: ['', ''], rows: [['', '']] } satisfies TableData };
  }
}

function block(type: BlockType, data: unknown): ContentBlock {
  return { id: newId(), type, data } as ContentBlock;
}

// Starter templates — spec §27-29. Every block is fully editable/removable
// after insertion; nothing here is enforced structure.
export function starterTemplateFor(contentType: 'article' | 'guide' | 'fhip_explainer'): ContentBlock[] {
  if (contentType === 'fhip_explainer') {
    return [
      block('heading', { level: 2, text: 'What it is' } satisfies HeadingData),
      block('paragraph', { text: '' } satisfies ParagraphData),
      block('heading', { level: 2, text: 'Why FHIP measures it' } satisfies HeadingData),
      block('paragraph', { text: '' } satisfies ParagraphData),
      block('heading', { level: 2, text: 'How it is calculated' } satisfies HeadingData),
      block('paragraph', { text: '' } satisfies ParagraphData),
      block('example', { text: '' } satisfies CalloutLikeData),
      block('heading', { level: 2, text: 'How to interpret your result' } satisfies HeadingData),
      block('paragraph', { text: '' } satisfies ParagraphData),
      block('heading', { level: 2, text: 'What may improve it' } satisfies HeadingData),
      block('paragraph', { text: '' } satisfies ParagraphData),
      block('heading', { level: 2, text: 'Important limitations' } satisfies HeadingData),
      block('warning', { text: '' } satisfies CalloutLikeData),
    ];
  }
  if (contentType === 'guide') {
    return [
      block('heading', { level: 2, text: 'Overview' } satisfies HeadingData),
      block('paragraph', { text: '' } satisfies ParagraphData),
      block('heading', { level: 2, text: 'Before you begin' } satisfies HeadingData),
      block('paragraph', { text: '' } satisfies ParagraphData),
      block('heading', { level: 3, text: 'Step 1' } satisfies HeadingData),
      block('paragraph', { text: '' } satisfies ParagraphData),
      block('heading', { level: 3, text: 'Step 2' } satisfies HeadingData),
      block('paragraph', { text: '' } satisfies ParagraphData),
      block('heading', { level: 3, text: 'Step 3' } satisfies HeadingData),
      block('paragraph', { text: '' } satisfies ParagraphData),
      block('example', { text: '' } satisfies CalloutLikeData),
      block('key_takeaways', { items: ['', ''] } satisfies ListData),
    ];
  }
  // Article — deliberately flexible, no forced section structure (spec §29/§77).
  return [
    block('callout', { text: '' } satisfies CalloutLikeData), // "30-second answer"
    block('key_takeaways', { items: ['', ''] } satisfies ListData),
    block('heading', { level: 2, text: 'Main content' } satisfies HeadingData),
    block('paragraph', { text: '' } satisfies ParagraphData),
    block('example', { text: '' } satisfies CalloutLikeData),
    block('heading', { level: 2, text: 'What this means for your financial health' } satisfies HeadingData),
    block('paragraph', { text: '' } satisfies ParagraphData),
  ];
}

export function isKnownBlockType(t: string): t is BlockType {
  return t in BLOCK_TYPE_LABELS;
}

// True if a block carries any user-authored content worth warning about
// before deletion (spec §87). Divider/empty blocks delete silently.
export function blockHasMeaningfulContent(b: AnyBlock): boolean {
  if (!isKnownBlockType(b.type)) return true; // unrecognised block — be conservative, always confirm
  const d = b.data as Record<string, unknown>;
  switch (b.type) {
    case 'divider':
      return false;
    case 'heading':
    case 'paragraph':
    case 'callout':
    case 'example':
    case 'warning':
    case 'fhip_context':
      return typeof d.text === 'string' && d.text.trim().length > 0;
    case 'quote':
      return (typeof d.text === 'string' && d.text.trim().length > 0) || (typeof d.attribution === 'string' && d.attribution.trim().length > 0);
    case 'bulleted_list':
    case 'numbered_list':
    case 'key_takeaways':
      return Array.isArray(d.items) && d.items.some((i) => typeof i === 'string' && i.trim().length > 0);
    case 'table': {
      const headers = Array.isArray(d.headers) ? (d.headers as string[]) : [];
      const rows = Array.isArray(d.rows) ? (d.rows as string[][]) : [];
      return headers.some((h) => h.trim().length > 0) || rows.some((r) => r.some((c) => c.trim().length > 0));
    }
    default:
      return true;
  }
}

// At least one meaningful block exists — part of review/publish validation
// (spec §35/§37).
export function hasAtLeastOneMeaningfulBlock(blocks: AnyBlock[]): boolean {
  return blocks.some(blockHasMeaningfulContent);
}
