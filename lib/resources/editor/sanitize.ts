// R1.3 defense-in-depth text sanitisation — spec §33/§34/§106.
//
// As documented in richtext.ts, block text is never parsed as HTML, so
// there is no HTML-injection surface to sanitise away in the first place.
// This module is the belt to that braces: a server-side pass (also usable
// client-side) that strips control characters and caps length on every
// plain-text field before it's persisted, so a block can never carry null
// bytes / non-printing control codes regardless of source.

// Strips C0 control characters and DEL, but keeps tab (\t), newline (\n)
// and carriage-return (\r) — written as \u escapes, not literal bytes, so
// this file stays a normal readable UTF-8 source file.
const CONTROL_CHARS_RE = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]', 'g');

export function sanitizePlainText(raw: unknown, maxLength = 20000): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(CONTROL_CHARS_RE, '').slice(0, maxLength);
}

// Recursively sanitises every string value inside a block's `data` object
// (list items, table cells, etc.) without needing per-block-type-specific
// code — safe because block data is always a plain JSON-shaped object
// (arrays/objects/strings/numbers/booleans/null), never a class instance or
// function.
export function sanitizeBlockData(data: unknown, maxLength = 20000): unknown {
  if (typeof data === 'string') return sanitizePlainText(data, maxLength);
  if (Array.isArray(data)) return data.map((v) => sanitizeBlockData(v, maxLength));
  if (data && typeof data === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) out[k] = sanitizeBlockData(v, maxLength);
    return out;
  }
  return data;
}

export function sanitizeBlocks(blocks: unknown[]): unknown[] {
  return blocks.map((b) => {
    if (!b || typeof b !== 'object') return b;
    const block = b as Record<string, unknown>;
    return { ...block, data: sanitizeBlockData(block.data) };
  });
}
