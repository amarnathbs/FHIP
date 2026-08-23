// Test-only helper: builds a minimal, valid, UNENCRYPTED, digitally-
// generated multi-page text PDF from plain-text lines, entirely in-process
// (no external tool, no network, no binary fixture checked into git as
// bytes). Used by R2's PDF-extraction-layer tests to prove
// lib/services/investment-intelligence/pdfExtraction.ts really reads real
// PDF bytes with a real PDF-parsing library end-to-end, not just a
// text-string stub.
//
// Deliberately NOT used for the 30+15 golden CAS fixtures themselves (see
// docs/investment-intelligence/R2_GOLDEN_FIXTURE_CATALOG.md for why those
// are plain-text "already extracted" fixtures instead) — this generator's
// only job is to prove the pdf-parse integration layer.

function escapePdfText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

export function buildMinimalTextPdf(pages: string[][]): Buffer {
  const pageObjNums: number[] = [];
  const contentObjNums: number[] = [];

  // Object numbering: 1=Catalog, 2=Pages, then per page: page obj, content obj; final = Font
  let nextObjNum = 3;
  for (let i = 0; i < pages.length; i++) {
    pageObjNums.push(nextObjNum++);
    contentObjNums.push(nextObjNum++);
  }
  const fontObjNum = nextObjNum++;

  const catalogObj = `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`;
  const kids = pageObjNums.map((n) => `${n} 0 R`).join(' ');
  const pagesObj = `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`;

  const byNumber = new Map<number, string>();
  byNumber.set(1, catalogObj);
  byNumber.set(2, pagesObj);
  for (let i = 0; i < pages.length; i++) {
    const lines = pages[i];
    const parts: string[] = ['BT', '/F1 9 Tf', '50 760 Td'];
    for (let li = 0; li < lines.length; li++) {
      if (li === 0) parts.push(`(${escapePdfText(lines[li])}) Tj`);
      else parts.push('0 -12 Td', `(${escapePdfText(lines[li])}) Tj`);
    }
    parts.push('ET');
    const streamContent = parts.join('\n');
    const contentObj = `${contentObjNums[i]} 0 obj\n<< /Length ${Buffer.byteLength(streamContent, 'utf8')} >>\nstream\n${streamContent}\nendstream\nendobj\n`;
    const pageObj = `${pageObjNums[i]} 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 ${fontObjNum} 0 R >> >> /MediaBox [0 0 612 792] /Contents ${contentObjNums[i]} 0 R >>\nendobj\n`;
    byNumber.set(pageObjNums[i], pageObj);
    byNumber.set(contentObjNums[i], contentObj);
  }
  const fontObj = `${fontObjNum} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n`;
  byNumber.set(fontObjNum, fontObj);

  const totalObjects = fontObjNum; // highest object number
  let pdf = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  let cursor = Buffer.byteLength(pdf, 'binary');
  const offsetByNumber = new Map<number, number>();
  for (let n = 1; n <= totalObjects; n++) {
    const objStr = byNumber.get(n);
    if (!objStr) continue;
    offsetByNumber.set(n, cursor);
    pdf += objStr;
    cursor += Buffer.byteLength(objStr, 'binary');
  }

  const xrefOffset = cursor;
  let xref = `xref\n0 ${totalObjects + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= totalObjects; n++) {
    const off = offsetByNumber.get(n);
    xref += off === undefined ? `0000000000 00000 f \n` : `${off.toString().padStart(10, '0')} 00000 n \n`;
  }
  pdf += xref;
  pdf += `trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  return Buffer.from(pdf, 'binary');
}

/** A PDF with a valid header/trailer but a truncated/garbage body — for corrupt-document tests. */
export function buildTruncatedPdf(): Buffer {
  return Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog', 'binary');
}

/** A syntactically-valid PDF with a page and NO text content (empty content stream) — simulates an image-only/scanned page for insufficient-text detection tests. */
export function buildEmptyTextPdf(): Buffer {
  return buildMinimalTextPdf([['']]);
}
