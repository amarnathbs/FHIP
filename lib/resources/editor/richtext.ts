// R1.3 restrained inline rich text — spec §32-34.
//
// Deliberate design decision (documented per spec §33's "if rich text is
// introduced" and §32's "prefer simple, reliable inputs... a structured
// block editor using controlled React inputs is acceptable and may be
// preferable" — no TipTap/ProseMirror/Lexical/Slate exists anywhere in this
// codebase, confirmed during the pre-implementation audit, so none is
// introduced here):
//
// Block text fields are plain `<textarea>` controlled inputs, not
// contentEditable. Bold/italic/links are authored with a tiny, closed
// markdown-lite syntax (**bold**, _italic_, [text](url)) and parsed here
// into a flat list of typed segments — never into real HTML, never via
// `dangerouslySetInnerHTML`. This is what makes the sanitisation
// requirement (spec §33/§34/§106 — never persist <script> or event-handler
// markup) structurally true rather than merely enforced: there is no HTML
// parser anywhere in this path, so a string like
// `<script>alert(1)</script>` typed into a block can only ever round-trip
// as inert literal text. React's own text-node escaping handles the
// "display it safely" half automatically; this module handles the
// "recognise the three allowed emphasis forms" half.
//
// A `<textarea>` also solves §34 (pasting) for free: browsers strip
// formatting from anything pasted into a plain textarea, so rich
// HTML/script paste content already arrives as plain text before this
// module ever sees it.

export type InlineSegment = { kind: 'text'; text: string } | { kind: 'bold'; text: string } | { kind: 'italic'; text: string } | { kind: 'link'; text: string; href: string };

const LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/;
const BOLD_RE = /\*\*([^*]+)\*\*/;
const ITALIC_RE = /_([^_]+)_/;

// Only http(s) links are ever accepted — javascript:/data: URIs (the
// classic markdown-link XSS vector) never match LINK_RE's scheme
// requirement, so they render as literal text instead of a link.
export function parseInlineMarkup(raw: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let remaining = raw;

  while (remaining.length > 0) {
    const linkMatch = remaining.match(LINK_RE);
    const boldMatch = remaining.match(BOLD_RE);
    const italicMatch = remaining.match(ITALIC_RE);

    const candidates = [
      linkMatch ? { index: linkMatch.index!, len: linkMatch[0].length, kind: 'link' as const, text: linkMatch[1], href: linkMatch[2] } : null,
      boldMatch ? { index: boldMatch.index!, len: boldMatch[0].length, kind: 'bold' as const, text: boldMatch[1] } : null,
      italicMatch ? { index: italicMatch.index!, len: italicMatch[0].length, kind: 'italic' as const, text: italicMatch[1] } : null,
    ].filter((c): c is NonNullable<typeof c> => c !== null);

    if (candidates.length === 0) {
      segments.push({ kind: 'text', text: remaining });
      break;
    }

    candidates.sort((a, b) => a.index - b.index);
    const next = candidates[0];

    if (next.index > 0) segments.push({ kind: 'text', text: remaining.slice(0, next.index) });
    if (next.kind === 'link') segments.push({ kind: 'link', text: next.text, href: next.href });
    else segments.push({ kind: next.kind, text: next.text });

    remaining = remaining.slice(next.index + next.len);
  }

  return segments;
}

// Plain-text projection (strips markup) — used for excerpt/SEO fallback
// derivation and for the character-count display, where showing raw `**`
// characters in a count would be confusing.
export function toPlainText(raw: string): string {
  return parseInlineMarkup(raw)
    .map((s) => s.text)
    .join('');
}
