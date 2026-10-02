// A deliberately small, strict, LINEAR-time XML scanner for the handful of
// OOXML parts the XLSX reader needs. No regular expressions with backtracking,
// no DTD, no entity definitions, no external references: any `<!DOCTYPE` or
// `<!ENTITY` is refused outright (XML_DTD_FORBIDDEN), so entity-expansion
// ("billion laughs") and XXE attacks cannot be expressed. Only the five
// predefined entities and numeric character references are decoded.
import type { Problem } from './types';

export interface XmlHandler {
  open(name: string, attrs: Record<string, string>, selfClosing: boolean): void;
  close(name: string): void;
  text(text: string): void;
}

const MAX_DEPTH = 64;
const MAX_TAGS = 20_000_000;

function isNameChar(c: number): boolean {
  // letters, digits, '-', '_', '.', ':' and any non-ASCII
  return (
    (c >= 0x30 && c <= 0x39) ||
    (c >= 0x41 && c <= 0x5a) ||
    (c >= 0x61 && c <= 0x7a) ||
    c === 0x2d ||
    c === 0x5f ||
    c === 0x2e ||
    c === 0x3a ||
    c > 0x7f
  );
}

function isSpace(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
}

/** Local name: drops a namespace prefix ("x:row" -> "row", "r:id" -> "id"). */
function localName(n: string): string {
  const i = n.lastIndexOf(':');
  return i >= 0 ? n.slice(i + 1) : n;
}

function decodeEntities(s: string, problems: Problem[]): string {
  if (s.indexOf('&') < 0) return s;
  let out = '';
  let i = 0;
  while (i < s.length) {
    const amp = s.indexOf('&', i);
    if (amp < 0) {
      out += s.slice(i);
      break;
    }
    out += s.slice(i, amp);
    const semi = s.indexOf(';', amp + 1);
    if (semi < 0 || semi - amp > 12) {
      problems.push({ code: 'XML_ENTITY_FORBIDDEN', message: 'The XML contains a malformed entity reference.' });
      out += '&';
      i = amp + 1;
      continue;
    }
    const ent = s.slice(amp + 1, semi);
    if (ent === 'amp') out += '&';
    else if (ent === 'lt') out += '<';
    else if (ent === 'gt') out += '>';
    else if (ent === 'quot') out += '"';
    else if (ent === 'apos') out += "'";
    else if (ent.length > 1 && ent[0] === '#') {
      const hex = ent[1] === 'x' || ent[1] === 'X';
      const digits = hex ? ent.slice(2) : ent.slice(1);
      let ok = digits.length > 0;
      for (let k = 0; k < digits.length && ok; k++) {
        const ch = digits.charCodeAt(k);
        const isDec = ch >= 0x30 && ch <= 0x39;
        const isHex = isDec || (ch >= 0x41 && ch <= 0x46) || (ch >= 0x61 && ch <= 0x66);
        if (hex ? !isHex : !isDec) ok = false;
      }
      const cp = ok ? parseInt(digits, hex ? 16 : 10) : NaN;
      const allowed =
        Number.isInteger(cp) &&
        cp <= 0x10ffff &&
        !(cp >= 0xd800 && cp <= 0xdfff) &&
        (cp >= 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0d);
      if (allowed) out += String.fromCodePoint(cp);
      else {
        problems.push({ code: 'XML_ENTITY_FORBIDDEN', message: 'The XML contains an invalid character reference.' });
      }
    } else {
      problems.push({ code: 'XML_ENTITY_FORBIDDEN', message: `The XML uses an undefined entity (&${ent.slice(0, 20)};).` });
    }
    i = semi + 1;
  }
  return out;
}

/**
 * Scans `xml`, calling the handler for each element and text run. Returns the
 * problems found; on a fatal problem scanning stops. Never throws.
 */
export function scanXml(xml: string, handler: XmlHandler): Problem[] {
  const problems: Problem[] = [];
  const fatal = (code: string, message: string): Problem[] => {
    problems.push({ code, message });
    return problems;
  };
  const n = xml.length;
  let i = xml.charCodeAt(0) === 0xfeff ? 1 : 0;
  let depth = 0;
  let tags = 0;
  const stack: string[] = [];

  while (i < n) {
    const lt = xml.indexOf('<', i);
    const textEnd = lt < 0 ? n : lt;
    if (textEnd > i) {
      if (depth > 0) handler.text(decodeEntities(xml.slice(i, textEnd), problems));
      i = textEnd;
    }
    if (lt < 0) break;

    // xml[i] === '<'
    if (xml.startsWith('<!--', i)) {
      const end = xml.indexOf('-->', i + 4);
      if (end < 0) return fatal('XML_MALFORMED', 'An XML comment is never closed.');
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', i)) {
      const end = xml.indexOf(']]>', i + 9);
      if (end < 0) return fatal('XML_MALFORMED', 'A CDATA section is never closed.');
      if (depth > 0) handler.text(xml.slice(i + 9, end));
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<!', i)) {
      // <!DOCTYPE, <!ENTITY, <!ELEMENT ... : never allowed.
      return fatal('XML_DTD_FORBIDDEN', 'The XML contains a document type declaration or entity definition, which is not allowed.');
    }
    if (xml.startsWith('<?', i)) {
      const end = xml.indexOf('?>', i + 2);
      if (end < 0) return fatal('XML_MALFORMED', 'A processing instruction is never closed.');
      i = end + 2;
      continue;
    }
    if (xml.charCodeAt(i + 1) === 0x2f) {
      // closing tag
      let j = i + 2;
      while (j < n && isNameChar(xml.charCodeAt(j))) j++;
      const name = localName(xml.slice(i + 2, j));
      while (j < n && isSpace(xml.charCodeAt(j))) j++;
      if (xml[j] !== '>') return fatal('XML_MALFORMED', 'A closing tag is malformed.');
      if (stack.length === 0 || stack[stack.length - 1] !== name) {
        return fatal('XML_MALFORMED', `Unexpected closing tag </${name.slice(0, 30)}>.`);
      }
      stack.pop();
      depth--;
      handler.close(name);
      i = j + 1;
      continue;
    }
    // opening tag
    if (++tags > MAX_TAGS) return fatal('XML_TOO_COMPLEX', 'The XML has too many elements.');
    let j = i + 1;
    while (j < n && isNameChar(xml.charCodeAt(j))) j++;
    if (j === i + 1) return fatal('XML_MALFORMED', 'An element has no name.');
    const name = localName(xml.slice(i + 1, j));
    const attrs: Record<string, string> = {};
    let selfClosing = false;
    for (;;) {
      while (j < n && isSpace(xml.charCodeAt(j))) j++;
      if (j >= n) return fatal('XML_MALFORMED', 'A tag is never closed.');
      const ch = xml[j];
      if (ch === '>') {
        j++;
        break;
      }
      if (ch === '/') {
        if (xml[j + 1] !== '>') return fatal('XML_MALFORMED', 'A self-closing tag is malformed.');
        selfClosing = true;
        j += 2;
        break;
      }
      const aStart = j;
      while (j < n && isNameChar(xml.charCodeAt(j))) j++;
      if (j === aStart) return fatal('XML_MALFORMED', 'An attribute is malformed.');
      const aName = localName(xml.slice(aStart, j));
      while (j < n && isSpace(xml.charCodeAt(j))) j++;
      if (xml[j] !== '=') return fatal('XML_MALFORMED', 'An attribute has no value.');
      j++;
      while (j < n && isSpace(xml.charCodeAt(j))) j++;
      const q = xml[j];
      if (q !== '"' && q !== "'") return fatal('XML_MALFORMED', 'An attribute value is not quoted.');
      const vEnd = xml.indexOf(q, j + 1);
      if (vEnd < 0) return fatal('XML_MALFORMED', 'An attribute value is never closed.');
      attrs[aName] = decodeEntities(xml.slice(j + 1, vEnd), problems);
      j = vEnd + 1;
    }
    handler.open(name, attrs, selfClosing);
    if (!selfClosing) {
      if (++depth > MAX_DEPTH) return fatal('XML_TOO_COMPLEX', 'The XML is nested too deeply.');
      stack.push(name);
    } else handler.close(name);
    i = j;
  }
  if (stack.length > 0) problems.push({ code: 'XML_MALFORMED', message: 'The XML ends before every element is closed.' });
  return problems;
}
