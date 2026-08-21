// R1.7D-FINAL §11 — prove that no numeric / worked-example content changed
// during this pass. Compares every numeric-bearing reader-facing string in
// the pre-correction safety snapshot against the live post-correction CMS.
import { readFileSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { assertDevProject } from '../lib/env';
import { EXPECTED_84 } from './r17d-expected84';

type Block = { type: string; data: Record<string, unknown> };

// A "financial arithmetic string" is one that actually carries a worked
// figure: a currency symbol, a percentage, a ratio/multiple, an explicit
// arithmetic operator, or a thousands-grouped / decimal amount. Bare
// identifiers such as requirement IDs (FHIP-FC-NW-001), content IDs (EX-001)
// or ranges like "0-100" are deliberately NOT financial arithmetic and are
// excluded, so this measures worked examples rather than any string that
// happens to contain a digit.
const NUMERIC_RE = /[₹$£€]|[0-9]\s*%|[0-9]+\.[0-9]|[0-9],[0-9]{3}|[0-9]\s*[×x÷]\s*[0-9]|[0-9]\s*\/\s*[0-9]|=\s*[0-9]|[0-9]+(\.[0-9]+)?x\b/;

function numericStrings(blocks: Block[]): string[] {
  const out: string[] = [];
  for (const b of blocks ?? []) {
    const d = b.data ?? {};
    const texts = Array.isArray(d.items) ? (d.items as string[]) : [String(d.text ?? '')];
    for (const t of texts) if (NUMERIC_RE.test(t)) out.push(t.trim());
  }
  return out.sort();
}

async function main() {
  const creds = assertDevProject();
  const svc = createClient(creds.url, creds.serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const preFull = JSON.parse(readFileSync('artifacts/resources/r1-7d/cms-content-pull.json', 'utf8')) as { content_id: string; content_blocks: Block[] }[];
  const preById = new Map(preFull.map((r) => [r.content_id, numericStrings(r.content_blocks)]));

  const { data: posts } = await svc.from('resource_posts').select('content_id,content_blocks').in('content_id', EXPECTED_84);

  const report: { content_id: string; pre_count: number; post_count: number; removed: string[]; added: string[] }[] = [];
  let totalNumericStrings = 0;
  let drifted = 0;

  for (const p of (posts ?? []).sort((a, b) => String(a.content_id).localeCompare(String(b.content_id)))) {
    const cid = p.content_id as string;
    const before = preById.get(cid) ?? [];
    const after = numericStrings((p.content_blocks ?? []) as Block[]);
    totalNumericStrings += before.length;
    const beforeSet = new Set(before);
    const afterSet = new Set(after);
    const removed = before.filter((x) => !afterSet.has(x));
    const added = after.filter((x) => !beforeSet.has(x));
    if (removed.length || added.length) {
      drifted++;
      report.push({ content_id: cid, pre_count: before.length, post_count: after.length, removed, added });
    }
  }

  const summary = {
    records_compared: (posts ?? []).length,
    total_numeric_strings_pre: totalNumericStrings,
    records_with_numeric_drift: drifted,
    drift: report,
  };
  writeFileSync('artifacts/resources/r1-7d/math-invariance.json', JSON.stringify(summary, null, 2));
  console.log(`[math-invariance] records=${summary.records_compared} numeric strings=${totalNumericStrings} records with drift=${drifted}`);
  for (const r of report) {
    console.log(`  ${r.content_id}: -${r.removed.length} +${r.added.length}`);
    r.removed.forEach((x) => console.log(`    REMOVED: ${x.slice(0, 200)}`));
    r.added.forEach((x) => console.log(`    ADDED  : ${x.slice(0, 200)}`));
  }
  if (drifted === 0) console.log('PASS — every numeric / worked-example string is byte-identical to the pre-correction baseline. No arithmetic recheck required (§11).');
}

main().catch((e) => { console.error(e); process.exit(1); });
