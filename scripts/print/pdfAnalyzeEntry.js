// Browser entry: reads a PDF (base64) with pdf.js inside Chromium and reports, per page, its size, its text (with positions
// and font sizes) and how much of the page carries ink. Used by scripts/print/printLayoutCheck.ts. Nothing leaves the machine.
import * as pdfjs from 'pdfjs-dist/build/pdf.mjs';
import 'pdfjs-dist/build/pdf.worker.mjs';

const MM = 72 / 25.4;

window.analyzePdf = async (base64, opts) => {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const doc = await pdfjs.getDocument({ data: bytes, useSystemFonts: false }).promise;
  const scale = opts.scale || 0.6;
  const band = (opts.excludeBandMm ?? 12) * MM; // header / footer bands are not part of the content
  const out = [];
  for (let n = 1; n <= doc.numPages; n += 1) {
    const page = await doc.getPage(n);
    const vp1 = page.getViewport({ scale: 1 });
    const text = await page.getTextContent();
    const items = text.items
      .filter((t) => 'str' in t && t.str.trim() !== '')
      .map((t) => ({ str: t.str, x: t.transform[4], y: vp1.height - t.transform[5], size: Math.hypot(t.transform[0], t.transform[1]), w: t.width }));
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const top = Math.round(band * scale);
    const bottom = height - Math.round(band * scale);
    const rowInk = new Array(height).fill(0);
    let inkPixels = 0;
    for (let y = top; y < bottom; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4;
        // "ink": anything visibly darker than the page. Near-white tints (a 1px #f3f4f6 card edge) are not ink.
        if (data[i] < 235 || data[i + 1] < 235 || data[i + 2] < 235) {
          rowInk[y] += 1;
          inkPixels += 1;
        }
      }
    }
    let first = -1;
    let last = -1;
    for (let y = top; y < bottom; y += 1) if (rowInk[y] > 0) { if (first < 0) first = y; last = y; }
    // The tallest run of rows with no ink inside the content band (a hole in the middle of a page).
    let run = 0;
    let maxRun = 0;
    for (let y = top; y < bottom; y += 1) { if (rowInk[y] === 0) { run += 1; if (run > maxRun) maxRun = run; } else run = 0; }
    const contentH = bottom - top;
    const entry = {
      page: n, widthPt: vp1.width, heightPt: vp1.height, landscape: vp1.width > vp1.height,
      contentTopFrac: first < 0 ? null : (first - top) / contentH,
      // How far down the content band the last ink reaches (1 = full page, 0.5 = bottom half empty).
      filledFrac: last < 0 ? 0 : (last - top + 1) / contentH,
      inkDensity: inkPixels / (width * contentH),
      maxHoleFrac: maxRun / contentH,
      items,
    };
    if (opts.png && opts.png.includes(n)) entry.png = canvas.toDataURL('image/png');
    out.push(entry);
  }
  return out;
};
window.__PDF_READY__ = true;
