// Resources Bulk Upload -- restricted Markdown -> EXISTING content block types.
//
// The block model (lib/resources/editor/blocks.ts) has: paragraph, heading
// (level 2|3|4), bulleted_list, numbered_list, key_takeaways, callout, example,
// warning, quote, divider, fhip_context, table. The uploader maps finished body
// text onto exactly: heading (H2/H3), paragraph, bulleted_list, numbered_list,
// key_takeaways, callout, example. Inline emphasis uses the editor's own
// closed syntax (**bold**, _italic_, [text](https://...)); nothing here ever
// produces or interprets HTML.
//
// ANYTHING outside that subset is REPORTED (with its line number), never
// silently dropped or "fixed":
//   raw HTML / comments / CDATA, H1 and H4+ headings, tables, block quotes,
//   code fences, horizontal rules, images, nested (indented) lists, and links
//   whose target is not https.

import { createHash } from 'node:crypto';

export interface MarkupBlock {
  id: string;
  type: 'heading' | 'paragraph' | 'bulleted_list' | 'numbered_list' | 'key_takeaways' | 'callout' | 'example';
  data: Record<string, unknown>;
}

export type MarkupResult = { ok: true; blocks: MarkupBlock[] } | { ok: false; reasons: string[] };

/** UUID-shaped, deterministic block id: the same input always yields the same staged payload (stable digest). */
export function deterministicBlockId(seed: string, index: number): string {
  const h = createHash('sha256').update(`${seed}#${index}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const RAW_HTML_RE = /<\/?[A-Za-z][^<>]*>|<!|<\?/;
const IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/;
const LINK_TARGET_RE = /\[[^\]]*\]\(([^)\s]*)[^)]*\)/g;
const BULLET_RE = /^[-*+]\s+(.*)$/;
const NUMBERED_RE = /^\d{1,3}[.)]\s+(.*)$/;
const HEADING_RE = /^(#{1,6})(\s+(.*))?$/;
const HR_RE = /^(-{3,}|\*{3,}|_{3,})\s*$/;
const TABLE_RE = /^\|.*\|\s*$/;

/** Problems with one line of INLINE text (no block structure considered). */
export function inlineProblems(text: string): string[] {
  const out: string[] = [];
  if (RAW_HTML_RE.test(text)) out.push('raw HTML is not allowed');
  if (IMAGE_RE.test(text)) out.push('images are not supported');
  for (const m of text.matchAll(LINK_TARGET_RE)) {
    if (!/^https:\/\/\S+$/i.test(m[1])) out.push(`links must start with https:// (found "${m[1].slice(0, 40)}")`);
  }
  return out;
}

function sanitizeLines(src: string): string[] {
  return src.replace(/\r\n?/g, '\n').split('\n');
}

export interface ParseOptions {
  seed: string;
  /** Start of the id counter, so several parses for one post never reuse an id. */
  startIndex?: number;
  allowH2?: boolean;
  allowH3?: boolean;
}

/** Restricted Markdown -> blocks. Whole-field result: either every line is understood or the reasons are returned. */
export function parseRestrictedMarkdown(src: string, opts: ParseOptions): MarkupResult {
  const lines = sanitizeLines(src);
  const reasons: string[] = [];
  const blocks: MarkupBlock[] = [];
  let idx = opts.startIndex ?? 0;
  const allowH2 = opts.allowH2 !== false;
  const allowH3 = opts.allowH3 !== false;
  const nextId = () => deterministicBlockId(opts.seed, idx++);

  let para: string[] = [];
  let list: { kind: 'bulleted_list' | 'numbered_list'; items: string[] } | null = null;
  const fail = (lineNo: number, why: string) => {
    if (reasons.length < 20) reasons.push(`line ${lineNo}: ${why}`);
  };
  const flushPara = () => {
    if (para.length > 0) {
      blocks.push({ id: nextId(), type: 'paragraph', data: { text: para.join(' ') } });
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push({ id: nextId(), type: list.kind, data: { items: list.items } });
      list = null;
    }
  };

  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i];
    const t = raw.trim();

    if (t.startsWith('```') || t.startsWith('~~~')) {
      fail(lineNo, 'code blocks are not supported');
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    if (t === '') {
      flushPara();
      flushList();
      continue;
    }

    const probs = inlineProblems(t);
    for (const p of probs) fail(lineNo, p);

    if (HR_RE.test(t)) {
      fail(lineNo, 'horizontal rules are not supported');
      continue;
    }
    if (t.startsWith('>')) {
      fail(lineNo, 'block quotes are not supported');
      continue;
    }
    if (TABLE_RE.test(t)) {
      fail(lineNo, 'tables are not supported');
      continue;
    }

    // nested list: an indented marker
    if (/^\s{2,}([-*+]|\d{1,3}[.)])\s+/.test(raw) || /^\t+([-*+]|\d{1,3}[.)])\s+/.test(raw)) {
      fail(lineNo, 'nested (indented) lists are not supported');
      continue;
    }

    const h = HEADING_RE.exec(t);
    if (h) {
      const level = h[1].length;
      const text = (h[3] ?? '').trim();
      flushPara();
      flushList();
      if (!text) {
        fail(lineNo, 'a heading has no text');
      } else if (level === 2 && allowH2) {
        blocks.push({ id: nextId(), type: 'heading', data: { level: 2, text } });
      } else if (level === 3 && allowH3) {
        blocks.push({ id: nextId(), type: 'heading', data: { level: 3, text } });
      } else if (level === 1) {
        fail(lineNo, 'a top-level heading (#) is not allowed; the title is the page heading. Use ## or ###');
      } else if (level === 2 || level === 3) {
        fail(lineNo, `a ${'#'.repeat(level)} heading is not allowed in this field`);
      } else {
        fail(lineNo, `${'#'.repeat(level)} headings are not supported; use ## or ###`);
      }
      continue;
    }

    const b = BULLET_RE.exec(t);
    const n = NUMBERED_RE.exec(t);
    if (b || n) {
      const kind = b ? 'bulleted_list' : 'numbered_list';
      const text = (b ? b[1] : (n as RegExpExecArray)[1]).trim();
      flushPara();
      if (list && list.kind !== kind) flushList();
      if (!list) list = { kind, items: [] };
      if (!text) fail(lineNo, 'a list item has no text');
      else list.items.push(text);
      continue;
    }

    // plain text: continuation of the open list item (soft wrap) or of a paragraph
    if (list && list.items.length > 0) {
      list.items[list.items.length - 1] = `${list.items[list.items.length - 1]} ${t}`;
    } else {
      para.push(t);
    }
  }
  if (inFence) fail(lines.length, 'a code fence is never closed');
  flushPara();
  flushList();

  if (reasons.length > 0) return { ok: false, reasons };
  return { ok: true, blocks };
}

/** newline-delimited list -> items; leading bullet or number markers are stripped. */
export function parseLineList(src: string): { items: string[]; reasons: string[] } {
  const items: string[] = [];
  const reasons: string[] = [];
  sanitizeLines(src).forEach((line, i) => {
    let t = line.trim();
    if (!t) return;
    t = t.replace(/^([-*+•]|\d{1,3}[.)])\s+/, '').trim();
    if (!t) return;
    for (const p of inlineProblems(t)) {
      if (reasons.length < 20) reasons.push(`line ${i + 1}: ${p}`);
    }
    items.push(t);
  });
  return { items, reasons };
}

/** A single free-text value (quick answer, example): raw HTML and non-https links are reported. */
export function checkInlineText(src: string): string[] {
  const reasons: string[] = [];
  sanitizeLines(src).forEach((line, i) => {
    for (const p of inlineProblems(line.trim())) {
      if (reasons.length < 20) reasons.push(`line ${i + 1}: ${p}`);
    }
  });
  return reasons;
}
