import fitz
import os
import json

OUT_DIR = "C:/Users/user/AppData/Local/Temp/claude/D--FHIP/754236a6-648e-4039-9457-c73bef97d4a2/scratchpad/pdf_pages"

for i in range(1, 16):
    scenario = f"VC{i:02d}"
    pdf_path = f"{OUT_DIR}/{scenario}.pdf"
    if not os.path.exists(pdf_path):
        print(f"{scenario}: PDF NOT FOUND")
        continue
    doc = fitz.open(pdf_path)
    print(f"{scenario}: {doc.page_count} pages")
    os.makedirs(f"{OUT_DIR}/{scenario}", exist_ok=True)
    for p in range(doc.page_count):
        pix = doc[p].get_pixmap(dpi=100)
        pix.save(f"{OUT_DIR}/{scenario}/p{p+1:02d}.png")
    doc.close()
print("done")
