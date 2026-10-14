// Builds the six promo hardening migrations by concatenating their hand-run parts byte for byte.
//   node scripts/promo_hardening_build_migrations.mjs          (write the migration files)
//   node scripts/promo_hardening_build_migrations.mjs --check  (exit 1 if a file differs from its parts)
// The parts under docs/admin/po_apply_promo_hardening_release/parts are the source of truth. Never edit the migration
// files by hand: edit a part and rebuild. A test proves the migration is the concatenation.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MIGRATIONS = [
  { file: '0264_promo_hardening_foundations.sql', parts: ['0264a', '0264b', '0264c', '0264d'] },
  { file: '0265_promo_hardening_functions.sql', parts: ['0265a', '0265b', '0265c', '0265d', '0265e', '0265f'] },
  { file: '0266_promo_email_abuse_controls.sql', parts: ['0266a', '0266b', '0266c', '0266d'] },
  { file: '0267_promo_retention_and_cleanup.sql', parts: ['0267a', '0267b', '0267c', '0267d'] },
  { file: '0268_platform_marker_hardening_and_cron_verify.sql', parts: ['0268a', '0268b'] },
  // The legacy cleanup: run by the PO only after the new release is verified (it drops the old function shapes the earlier ones kept).
  { file: '0279_promo_hardening_legacy_cleanup.sql', parts: ['0279a', '0279b'] },
];
const PARTS = path.join(ROOT, 'docs', 'admin', 'po_apply_promo_hardening_release', 'parts');
const MIG = path.join(ROOT, 'supabase', 'migrations');

if (process.argv[1] && process.argv[1].endsWith('promo_hardening_build_migrations.mjs')) {
  let bad = 0;
  for (const m of MIGRATIONS) {
    const whole = Buffer.concat(m.parts.map((p) => fs.readFileSync(path.join(PARTS, `${p}.sql`))));
    const target = path.join(MIG, m.file);
    if (process.argv.includes('--check')) {
      if (!fs.existsSync(target) || !fs.readFileSync(target).equals(whole)) {
        bad += 1;
        console.log(`DIFFERS: ${m.file}`);
      }
    } else {
      fs.writeFileSync(target, whole);
      console.log(`wrote ${m.file} (${whole.length} bytes, ${m.parts.length} parts)`);
    }
  }
  process.exit(bad ? 1 : 0);
}
