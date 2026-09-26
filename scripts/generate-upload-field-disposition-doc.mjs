#!/usr/bin/env node
// Regenerates docs/financial-data-hub/UPLOAD_FIELD_DISPOSITION_REGISTRY.md from
// the TypeScript registry (lib/canonical-data/disposition/*.ts).
//
// The gate test (tests/unit/uploadFieldDispositionRegistry.test.ts, rule R10)
// only COMPARES the doc with renderRegistryMarkdown() -- it never writes it --
// so a test run can never rewrite a checked-in file. This script is the one
// writer; run it after editing the registry:
//
//   node scripts/generate-upload-field-disposition-doc.mjs          # write
//   node scripts/generate-upload-field-disposition-doc.mjs --check  # exit 1 if stale
//
// The registry is TypeScript, so the script re-runs itself once under the
// `tsx` loader (a devDependency already used by the resources:* scripts).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DOC = path.join(ROOT, 'docs', 'financial-data-hub', 'UPLOAD_FIELD_DISPOSITION_REGISTRY.md');

if (process.env.FHIP_DISPOSITION_DOC_CHILD !== '1') {
  try {
    execFileSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
      stdio: 'inherit',
      env: { ...process.env, FHIP_DISPOSITION_DOC_CHILD: '1' },
      cwd: ROOT,
    });
    process.exit(0);
  } catch (e) {
    process.exit(typeof e.status === 'number' ? e.status : 1);
  }
}

const mod = await import(pathToFileURL(path.join(ROOT, 'lib', 'canonical-data', 'disposition', 'index.ts')).href);
const markdown = `${mod.renderRegistryMarkdown()}\n`;

if (process.argv.includes('--check')) {
  const current = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf8').replace(/\r\n/g, '\n') : '';
  if (current !== markdown) {
    console.error(`${path.relative(ROOT, DOC)} is stale: run node scripts/generate-upload-field-disposition-doc.mjs`);
    process.exit(1);
  }
  console.log(`${path.relative(ROOT, DOC)} is up to date (${mod.FIELD_DISPOSITION_REGISTRY.length} entries).`);
} else {
  fs.writeFileSync(DOC, markdown);
  console.log(`wrote ${path.relative(ROOT, DOC)} (${mod.FIELD_DISPOSITION_REGISTRY.length} entries).`);
}
