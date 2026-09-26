/**
 * Write the synthetic certification documents to a folder (default .canonical-cert/docs-<salt>/).
 *
 *   npx tsx scripts/canonical_cert/documents/build_documents.ts --salt A [--month 2026-08] [--out dir] [--scale 1000,1001]
 *
 * Writes every oracle-pack document, the scale bank statements, and manifest.json (filename, sha256,
 * upload recipe, oracle) -- no DEV access, no network.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { oraclePack, scaleBankStatement, parseMonth, previousCompleteMonth, type BuiltDocument } from './builders';

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const salt = arg('--salt') ?? '';
if (salt && !/^[A-Za-z0-9]{1,8}$/.test(salt)) throw new Error('--salt must be 1-8 letters/digits (e.g. the range letter)');
const month = arg('--month') ? parseMonth(arg('--month')!) : previousCompleteMonth();
const scale = (arg('--scale') ?? '1000,1001').split(',').filter(Boolean).map(Number);
const out = path.resolve(arg('--out') ?? path.join('.canonical-cert', `docs-${salt || 'nosalt'}`));

const docs: BuiltDocument[] = [...oraclePack(month, salt), ...scale.map((n) => scaleBankStatement(month, n, salt))];
fs.mkdirSync(out, { recursive: true });
const manifest = docs.map((d) => {
  fs.writeFileSync(path.join(out, d.filename), d.bytes);
  return { key: d.key, filename: d.filename, contentType: d.contentType, bytes: d.bytes.length, sha256: crypto.createHash('sha256').update(d.bytes).digest('hex'), upload: d.upload, oracle: d.oracle };
});
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ month: `${month.year}-${String(month.month).padStart(2, '0')}`, salt, documents: manifest }, null, 2));
for (const d of manifest) console.log(`${d.key.padEnd(22)} ${d.filename}  ${d.bytes} bytes  sha256 ${d.sha256.slice(0, 12)}`);
console.log(`wrote ${manifest.length} documents + manifest.json to ${out}`);
