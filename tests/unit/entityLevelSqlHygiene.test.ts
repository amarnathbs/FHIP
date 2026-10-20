// Every SQL file the PO pastes into the Supabase SQL editor for the entity-level work must pass the repository's editor-safety lint
// (tests/unit/support/sqlEditorHazards.ts): ASCII only, no bare dollar quote, no percent sign, no double quote in code, no semicolon or
// quote inside a comment, no semicolon or double quote inside a string, and no into / from / join followed by a word inside a comment or
// string. Negative control: the lint fires on a deliberately bad sample.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { hazards } from './support/sqlEditorHazards';

const ROOT = path.resolve(__dirname, '..', '..');
const PACK = 'docs/architecture/entity_level_assets_liabilities_2026-10-16';

function sqlFilesUnder(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sqlFilesUnder(`${dir}/${e.name}`) : e.name.endsWith('.sql') ? [`${dir}/${e.name}`] : []));
}

const FILES = ['supabase/migrations/0289_smsf_fund_liabilities.sql', 'supabase/migrations/0290_smsf_either_or_mode_rule_and_switch_rpcs.sql', ...sqlFilesUnder(PACK)];

describe('SQL editor safety for the entity-level SQL', () => {
  it('NEGATIVE CONTROL: the lint fires on a deliberately bad sample', () => {
    const bad = hazards("-- copy from the old table; ok?\nselect 'moved into the fund; x';\ndo $$ begin raise exception 'a %', 1; end $$;");
    expect(bad.length).toBeGreaterThanOrEqual(4);
  });
  it('covers the migrations and every file of the pack', () => {
    expect(FILES.length).toBeGreaterThanOrEqual(6);
  });
  for (const f of FILES) {
    it(`${f} is editor-safe`, () => {
      expect(hazards(fs.readFileSync(path.join(ROOT, f), 'utf8'))).toEqual([]);
    });
  }
});
