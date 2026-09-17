// M12D — extract the true requirement inventory (id, phase, family, section, verbatim title)
// from the Product-Owner specs. Reads only; copies no requirement BODY text into the repo,
// only the id + the requirement's own one-line title (which is the requirement sentence).
import fs from 'fs';
import path from 'path';

const SPEC_DIR = 'C:/Users/user/Downloads';
const SPECS = [
  ['AIE-1.0', 'AIE-1.0_Architecture_&_Privacy_Contract.md'],
  ['AIE-1.1', 'AIE-1.1_Shared_Preprocessing_Masking_and_JSON-Schema_Gateway (1).md'],
  ['AIE-1.2', 'AIE-1.2_Investment_Intelligence_Adapter.md'],
  ['AIE-1.3', 'AIE-1.3_FDH_Bank-Statement_Adapter.md'],
  ['AIE-1.4', 'AIE-1.4_Other_PDF-Enabled_FHIP_Modules.md'],
  ['AIE-1.5', 'AIE-1.5_User_Exception_Review_and_Acceptance_Integration.md'],
  ['AIE-1.6', 'AIE-1.6_Production_Cost_Security_and_Accuracy_Certification.md'],
];

const out = [];
for (const [phase, file] of SPECS) {
  const full = path.join(SPEC_DIR, file);
  const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
  let section = '';
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    const h2 = /^##\s+(.+?)\s*$/.exec(L);
    if (h2 && !/^#{3}/.test(L)) { section = h2[1]; continue; }
    const h3 = /^###\s+(AIE1[0-6]-[A-Z0-9]+-[0-9]+[a-z]?)\s*[—-]\s*(.+?)\s*$/.exec(L);
    if (h3) {
      const id = h3[1];
      const fam = id.split('-')[1];
      out.push({ id, phase, family: fam, section, title: h3[2], specLine: i + 1, specFile: file });
    }
  }
}

// The 18 ADR deliverables from the AIE-1.0 ADR register table.
const adrFile = 'AIE-1.0_Architecture_&_Privacy_Contract.md';
const adrLines = fs.readFileSync(path.join(SPEC_DIR, adrFile), 'utf8').split(/\r?\n/);
for (let i = 0; i < adrLines.length; i++) {
  const m = /^\|\s*(ADR-AIE-\d{3})\s*\|\s*(.+?)\s*\|\s*$/.exec(adrLines[i]);
  if (m) out.push({ id: m[1], phase: 'AIE-1.0', family: 'ADR', section: 'Architecture decision records (register)', title: m[2], specLine: i + 1, specFile: adrFile });
}

fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
console.log('requirements extracted:', out.length);
const byPhase = {};
for (const r of out) byPhase[r.phase] = (byPhase[r.phase] || 0) + 1;
console.log(byPhase);
const fams = {};
for (const r of out) fams[r.phase + '/' + r.family] = (fams[r.phase + '/' + r.family] || 0) + 1;
console.log(Object.keys(fams).length, 'phase/family groups');
fs.writeFileSync(process.argv[2].replace('.json', '-families.json'), JSON.stringify(fams, null, 1));
