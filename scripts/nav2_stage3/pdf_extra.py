"""Extra measurements on the exported Fund analytics PDF (PyMuPDF), beyond scripts/nav2_pdf_layout_analyse.py.
    python scripts/nav2_stage3/pdf_extra.py <pdf>
Prints one JSON object: per page the extractable text length, the running footer's "Page n of N", the number of drawn chart paths and images,
the smallest and most common font sizes; and a flag for pages that are an image only (no selectable text)."""
import collections
import json
import re
import sys

import pymupdf


def main() -> None:
    doc = pymupdf.open(sys.argv[1])
    pages = []
    all_text = []
    for i, page in enumerate(doc):
        text = page.get_text()
        all_text.append(text)
        sizes = collections.Counter()
        for b in page.get_text('dict')['blocks']:
            if b.get('type') != 0:
                continue
            for ln in b['lines']:
                for sp in ln['spans']:
                    t = sp['text'].strip()
                    if t:
                        sizes[round(sp['size'], 1)] += len(t)
        m = re.search(r'Page\s+(\d+)\s+of\s+(\d+)', text)
        pages.append({
            'page': i + 1,
            'text_chars': len(text.strip()),
            'footer_page': [int(m.group(1)), int(m.group(2))] if m else None,
            'drawings': len(page.get_drawings()),
            'images': len(page.get_image_info()),
            'min_font_pt': min(sizes) if sizes else None,
            'common_font_pt': sizes.most_common(1)[0][0] if sizes else None,
            'image_only': len(text.strip()) < 20 and len(page.get_image_info()) > 0,
        })
    print(json.dumps({'page_count': len(pages), 'pages': pages, 'text': '\n'.join(all_text), 'metadata': doc.metadata}))


if __name__ == '__main__':
    main()
