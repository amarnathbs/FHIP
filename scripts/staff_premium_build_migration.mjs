// Builds migration 0283 (staff admin Premium) by concatenating its hand-run parts byte for byte.
//   node scripts/staff_premium_build_migration.mjs          (write the migration file)
//   node scripts/staff_premium_build_migration.mjs --check  (exit 1 if the file differs from its parts)
// The parts under docs/admin/po_apply_staff_premium/parts are the source of truth. Never edit the migration by hand:
// edit a part and rebuild. A test proves the migration is the concatenation.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MIGRATION = { file: '0283_staff_admin_premium.sql', parts: ['0283a', '0283b', '0283c'] };
const PARTS = path.join(ROOT, 'docs', 'admin', 'po_apply_staff_premium', 'parts');
const MIG = path.join(ROOT, 'supabase', 'migrations');

if (process.argv[1] && process.argv[1].endsWith('staff_premium_build_migration.mjs')) {
  const whole = Buffer.concat(MIGRATION.parts.map((p) => fs.readFileSync(path.join(PARTS, `${p}.sql`))));
  const target = path.join(MIG, MIGRATION.file);
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(target) || !fs.readFileSync(target).equals(whole)) {
      console.log(`DIFFERS: ${MIGRATION.file}`);
      process.exit(1);
    }
  } else {
    fs.writeFileSync(target, whole);
    console.log(`wrote ${MIGRATION.file} (${whole.length} bytes, ${MIGRATION.parts.length} parts)`);
  }
}
