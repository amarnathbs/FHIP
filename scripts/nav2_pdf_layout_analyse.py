"""Layout analysis of the Fund analytics PDF (PyMuPDF). Called by scripts/nav2_pdf_layout_check.ts; prints one JSON object.

    python scripts/nav2_pdf_layout_analyse.py <pdf> <png-output-dir> <fund-names-json> [dpi]

Per page it reports how much of the text area (between the running header and footer) is empty below the last content, what the last
and first content lines are, whether the page names a fund, and whether anything runs past the right margin. The caller turns that
into pass / fail. The margins are the ones in lib/services/investment-intelligence/nav2/fundAnalyticsPdfRenderer.ts.
"""
import json
import os
import sys

import collections

import pymupdf

MM = 72.0 / 25.4
TOP, BOTTOM, LEFT, RIGHT = 22 * MM, 20 * MM, 16 * MM, 16 * MM


def main() -> None:
    pdf, out_dir, names_path = sys.argv[1], sys.argv[2], sys.argv[3]
    dpi = int(sys.argv[4]) if len(sys.argv) > 4 else 110
    fund_names = json.load(open(names_path, encoding='utf-8'))
    os.makedirs(out_dir, exist_ok=True)
    doc = pymupdf.open(pdf)
    pages = []
    for i, page in enumerate(doc):
        W, H = page.rect.width, page.rect.height
        area_top, area_bottom = TOP, H - BOTTOM
        area_h = area_bottom - area_top
        lines = []
        sizes = collections.Counter()
        for b in page.get_text('dict')['blocks']:
            if b.get('type') != 0:
                continue
            for ln in b['lines']:
                x0, y0, x1, y1 = ln['bbox']
                txt = ''.join(s['text'] for s in ln['spans']).strip()
                if not txt:
                    continue
                # the running header and footer sit outside the text area
                if y1 < area_top - 1 or y0 > area_bottom + 1:
                    continue
                size = max(s['size'] for s in ln['spans'])
                bold = any((s['flags'] & 16) or 'bold' in s['font'].lower() for s in ln['spans'])
                for sp in ln['spans']:
                    sizes[round(sp['size'], 1)] += len(sp['text'].strip())
                lines.append({'y0': y0, 'y1': y1, 'x0': x0, 'x1': x1, 'text': txt, 'size': round(size, 1), 'bold': bool(bold)})
        # COLLISIONS: two text spans of the page whose boxes overlap (a header or cell that runs into its neighbour: 'Common returnsPeriod').
        spans = []
        for b in page.get_text('dict')['blocks']:
            if b.get('type') != 0:
                continue
            for ln in b['lines']:
                for sp in ln['spans']:
                    if sp['text'].strip() and not (sp['bbox'][3] < area_top - 1 or sp['bbox'][1] > area_bottom + 1):
                        spans.append((sp['bbox'], sp['text'].strip()))
        overlaps = []
        for m in range(len(spans)):
            for n in range(m + 1, len(spans)):
                (ax0, ay0, ax1, ay1), at = spans[m]
                (bx0, by0, bx1, by1), bt = spans[n]
                oy = min(ay1, by1) - max(ay0, by0)
                ox = min(ax1, bx1) - max(ax0, bx0)
                if oy > 0.5 * min(ay1 - ay0, by1 - by0) and ox > 1.0:
                    overlaps.append(f'{at[:30]} / {bt[:30]}')
        lowest = max([l['y1'] for l in lines], default=area_top)
        for d in page.get_drawings():
            r = d['rect']
            if r.y1 < area_top - 1 or r.y0 > area_bottom + 1:
                continue
            if r.height > 0.9 * area_h and r.width > 0.9 * (W - LEFT - RIGHT):
                continue  # a page-sized background
            if r.y0 >= area_bottom - 3:
                continue  # starts at the very bottom edge (a clip or an overflow of the next page), not content
            lowest = max(lowest, min(r.y1, area_bottom))
        for im in page.get_image_info():
            r = pymupdf.Rect(im['bbox'])
            if r.y1 >= area_top - 1 and r.y0 <= area_bottom + 1:
                lowest = max(lowest, min(r.y1, area_bottom))
        blank = max(0.0, (area_bottom - lowest) / area_h)
        ordered = sorted(lines, key=lambda l: (l['y0'], l['x0']))
        last_line = max(lines, key=lambda l: l['y1']) if lines else None
        first_line = ordered[0] if ordered else None
        text = page.get_text()
        # EVERY span on the page, the running header and footer included (they are Chromium templates and sit outside the text area)
        all_sizes = [round(sp['size'], 1) for b in page.get_text('dict')['blocks'] if b.get('type') == 0 for ln in b['lines'] for sp in ln['spans'] if sp['text'].strip()]
        named = [n for n in fund_names if n in text]
        overflow = [l['text'][:60] for l in lines if l['x1'] > W - RIGHT + 2 or l['x0'] < LEFT - 2]
        png = os.path.join(out_dir, f'page-{i + 1:02d}.png')
        page.get_pixmap(dpi=dpi).save(png)
        pages.append({
            'page': i + 1,
            'blank_ratio': round(blank, 3),
            'lines': len(lines),
            'last_line': last_line and {'text': last_line['text'][:90], 'size': last_line['size'], 'bold': last_line['bold']},
            'first_line': first_line and {'text': first_line['text'][:90], 'size': first_line['size'], 'bold': first_line['bold']},
            'funds_named': named,
            'overflow_right': overflow,
            'overlaps': overlaps[:10],
            'min_size': min(sizes) if sizes else None,
            'min_size_all': min(all_sizes) if all_sizes else None,
            'body_size': sizes.most_common(1)[0][0] if sizes else None,
            'png': png,
        })
    print(json.dumps({'page_count': len(pages), 'pages': pages}))


if __name__ == '__main__':
    main()
