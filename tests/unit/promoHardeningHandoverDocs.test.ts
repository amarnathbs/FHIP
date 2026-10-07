// The hand-over documents are part of the release: a runbook that names a file that does not exist, a secret generator that prints
// the secret, or a date in the wrong order is a defect the PO would meet at the worst moment. These tests read the documents.
//
// NAMED NEGATIVE CONTROLS
//   NC-D1  a generator that WRITES the value to the screen is caught by the no-output rule;
//   NC-D2  a reference to a file that does not exist is caught by the reference check.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PROMO_SECRET_ENV } from '@/lib/services/promoSecrets';
import { MIGRATIONS } from '../../scripts/promo_hardening_build_migrations.mjs';
import { expectNamedFailure, REPO_ROOT } from './support/promoTestHelpers';

const PACK = path.join(REPO_ROOT, 'docs', 'admin', 'po_apply_promo_hardening_release');
const read = (rel: string) => fs.readFileSync(path.join(PACK, rel), 'utf8');
const README = read('README.md');
const RUNBOOK = read('PRODUCTION_RUNBOOK.md');

/** Every `path/like/this.sql` style reference in a document that points inside this pack or supabase/migrations. */
function referencedFiles(doc: string): string[] {
  const out = new Set<string>();
  for (const m of doc.matchAll(/`((?:checks|rollback|emergency|parts)\/[A-Za-z0-9_.]+\.sql|supabase\/migrations\/[A-Za-z0-9_.]+\.sql)`/g)) out.add(m[1]);
  return [...out];
}
const exists = (rel: string) => (rel.startsWith('supabase/') ? fs.existsSync(path.join(REPO_ROOT, rel)) : fs.existsSync(path.join(PACK, rel)));

describe('every file the documents mention exists', () => {
  it('README and RUNBOOK references resolve', () => {
    const refs = [...referencedFiles(README), ...referencedFiles(RUNBOOK)];
    expect(refs.length).toBeGreaterThan(15);
    for (const r of refs) expect(exists(r), `${r} is referenced but does not exist`).toBe(true);
  });

  it('NC-D2: a reference to a missing file is caught', async () => {
    await expectNamedFailure(() => expect(exists('checks/V9999_does_not_exist.sql'), 'a referenced file exists').toBe(true), 'a referenced file exists');
  });

  it('the README names every migration of the release and every part', () => {
    for (const m of MIGRATIONS) {
      expect(README, m.file).toContain(m.file);
      for (const p of m.parts) expect(fs.existsSync(path.join(PACK, 'parts', `${p}.sql`)), p).toBe(true);
    }
  });

  it('the steps of the README are in the order of the runbook: detect, 0264..0268, deploy, prepare, finalise, 0279', () => {
    const pos = (s: string) => README.indexOf(s);
    const order = ['D1_before_detect', '0264_promo_hardening_foundations', '0265_promo_hardening_functions', '0266_promo_email_abuse_controls', '0267_promo_retention_and_cleanup', '0268_platform_marker_hardening', 'V_after_prepare_existing_codes', 'promo_codes_finalise_hash_only(false)', '0279_promo_hardening_legacy_cleanup'];
    const at = order.map(pos);
    expect(at.every((p) => p >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });
});

describe('the secret generator in the runbook never shows a value', () => {
  const block = /```powershell\n([\s\S]*?)```/.exec(RUNBOOK)?.[1] ?? '';

  it('uses a cryptographic generator, hands each value over on the clipboard, clears it, and writes nothing to the screen', () => {
    expect(block).toContain('RandomNumberGenerator');
    expect(block).toContain('Set-Clipboard');
    expect(block).toMatch(/Set-Clipboard -Value ' '/);
    expect(block).not.toMatch(/Write-Host|Write-Output|Out-File|Add-Content|\| Out-String|echo\b/i);
    expect(block, 'the only text it prints is the instruction and the clearing notice').not.toMatch(/\$v\b(?!\s*\))|\$vals\b/);
  });

  it('NC-D1: a generator that prints the value would be caught', async () => {
    const bad = `${block}\nWrite-Host $b`;
    await expectNamedFailure(() => expect(bad, 'the generator writes nothing to the screen').not.toMatch(/Write-Host/), 'the generator writes nothing to the screen');
  });

  it('names exactly the variables the application reads', () => {
    for (const name of ['PROMO_CODE_DIGEST_SECRET', 'PROMO_IP_HASH_SECRET']) expect(block).toContain(name);
    for (const name of Object.values(PROMO_SECRET_ENV)) expect(RUNBOOK, name).toContain(name);
  });
});

describe('dates in the documents are written day first (no year-month-day text)', () => {
  it('README and RUNBOOK contain no numeric year-first date', () => {
    for (const [name, doc] of [['README', README], ['RUNBOOK', RUNBOOK]] as const) {
      expect(doc.match(/\b(19|20)\d{2}-\d{2}-\d{2}\b/g) ?? [], `${name} has a year-first date`).toEqual([]);
    }
  });
});

describe('what the runbook promises is backed by a test that exists', () => {
  it('every test file the runbook names exists', () => {
    for (const m of RUNBOOK.matchAll(/`(tests\/unit\/[A-Za-z0-9_.]+\.test\.ts)`/g)) expect(fs.existsSync(path.join(REPO_ROOT, m[1])), m[1]).toBe(true);
  });

  it('the runbook states the e-mail decision of 07-10-2026 and the instant stop', () => {
    expect(RUNBOOK).toContain('07-10-2026');
    expect(RUNBOOK).toContain('emergency/STOP_promo_emails.sql');
    expect(RUNBOOK).toContain('PREMIUM_PROMO_EMAIL_ENABLED=true');
  });
});
