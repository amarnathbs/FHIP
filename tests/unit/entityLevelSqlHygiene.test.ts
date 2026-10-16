// Every SQL file the PO pastes into the Supabase SQL editor for the entity-level work must be free of the editor hazard
// (the words into / from / join followed by a word inside a comment or a string). Negative control: the detector fires on a
// deliberately bad sample, and does not fire on the same words in real code.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { findSqlEditorHazards } from './support/sqlEditorHazard';

const ROOT = path.resolve(__dirname, '..', '..');
const FILES = [
  'supabase/migrations/0289_smsf_fund_liabilities.sql',
  'supabase/migrations/0290_smsf_either_or_mode_rule_and_switch_rpcs.sql',
  ...fs
    .readdirSync(path.join(ROOT, 'docs/architecture/entity_level_assets_liabilities_2026-10-16'))
    .filter((f) => f.endsWith('.sql'))
    .map((f) => `docs/architecture/entity_level_assets_liabilities_2026-10-16/${f}`),
];

describe('SQL editor hazard (into/from/join + word in a comment or string)', () => {
  it('NEGATIVE CONTROL: the detector fires on comments and strings, not on code', () => {
    expect(findSqlEditorHazards("-- copy from the old table\nselect 1;")).toHaveLength(1);
    expect(findSqlEditorHazards("select 'moved into the fund';")).toHaveLength(1);
    expect(findSqlEditorHazards('/* join x */ select 1;')).toHaveLength(1);
    expect(findSqlEditorHazards("select a from b join c on true; insert into t values ('ok');")).toHaveLength(0);
    expect(findSqlEditorHazards("select 'it''s fine';\n-- fine")).toHaveLength(0);
  });
  for (const f of FILES) {
    it(`${f} is clean`, () => {
      const sql = fs.readFileSync(path.join(ROOT, f), 'utf8');
      expect(findSqlEditorHazards(sql)).toEqual([]);
    });
  }
});
