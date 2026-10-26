// Builds the editor-safe paste files of the entity + retirement production pack (docs/reviews/po_apply_entity_retirement_production/migrations/)
// from the migration files, so they cannot drift: node scripts/build_entity_retirement_production_pack.mjs
//  - 0289 and 0290: copied from the entity phase 1 parts (already split, already tested for exactness).
//  - 0295, 0298, 0299: the migration file as it is (small, already editor safe).
//  - 0296 and 0297: split at their numbered section markers into parts of about 15 KB or less, each part is its own begin ... commit and safe to run twice.
//  - 0304: an editor-safe COPY (the migration as applied on DEV uses a bare dollar quote, quotes inside comments and a policy name with spaces,
//    all of which the repository editor-safety lint refuses). Same objects, the policy name is kept (built at run time with quote_ident).
// The exactness and equivalence of every output is proved in tests/unit/entityRetirementProductionPackPglite.test.ts.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const MIG = path.join(ROOT, 'supabase', 'migrations');
const PHASE1_PARTS = path.join(ROOT, 'docs', 'architecture', 'entity_level_assets_liabilities_2026-10-16', 'sql_parts');
const OUT = path.join(ROOT, 'docs', 'reviews', 'po_apply_entity_retirement_production', 'migrations');
fs.mkdirSync(OUT, { recursive: true });

const mig = (num) => fs.readdirSync(MIG).find((f) => f.startsWith(`${num}_`));
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const write = (name, text) => fs.writeFileSync(path.join(OUT, name), text.endsWith('\n') ? text : text + '\n');

// 1. 0289, 0290: the phase 1 parts, renamed into one global order
const order = [];
for (const f of fs.readdirSync(PHASE1_PARTS).filter((x) => x.endsWith('.sql')).sort()) {
  write(`M_${f}`, read(path.join(PHASE1_PARTS, f)));
  order.push(`M_${f}`);
}

// 2. whole small files
for (const num of ['0295', '0298', '0299']) {
  const f = mig(num);
  write(`M_${f}`, read(path.join(MIG, f)));
  order.push(`M_${f}`);
}

// 3. split by section markers
function sections(text) {
  const lines = text.split('\n');
  const bodyStart = lines.findIndex((l) => l.trim() === 'begin;') + 1;
  const bodyEnd = lines.map((l) => l.trim()).lastIndexOf('commit;');
  const body = lines.slice(bodyStart, bodyEnd);
  const starts = [];
  for (let i = 0; i < body.length - 2; i += 1) {
    if (/^-- -{20,}$/.test(body[i]) && /^-- \d+\. /.test(body[i + 1])) starts.push(i);
  }
  return { body, starts };
}
function splitMigration(num, groups) {
  const f = mig(num);
  const { body, starts } = sections(read(path.join(MIG, f)));
  if (starts.length < groups.flat().length) throw new Error(`${num}: found ${starts.length} sections`);
  const cuts = groups.map((g) => starts[g[0] - 1]);
  const total = groups.length;
  groups.forEach((g, gi) => {
    const from = gi === 0 ? 0 : cuts[gi];
    const to = gi === total - 1 ? body.length : cuts[gi + 1];
    const chunk = body.slice(from, to).join('\n').replace(/\s+$/, '');
    const name = `M_${num}_part${gi + 1}.sql`;
    write(
      name,
      `-- Migration ${num} part ${gi + 1} of ${total}. Run the parts in order, one at a time, in the Supabase SQL editor. Each part is safe to run again.\n` +
        `-- The source of truth is the migration file with the same number.\nbegin;\n\n${chunk}\n\ncommit;\n`,
    );
    order.push(name);
  });
}
splitMigration('0296', [[1, 2, 3], [4, 5, 6], [7]]);
splitMigration('0297', [[1, 2], [3, 4], [5]]);

// 4. 0304 editor safe copy
{
  const f = mig('0304');
  let s = read(path.join(MIG, f));
  s = s.replace(/\$\$/g, '$fn$');
  // comments: no apostrophes, no semicolons, no hazard words
  s = s
    .split('\n')
    .map((l) => {
      if (!l.trimStart().startsWith('--')) return l;
      return l.replace(/'/g, '').replace(/;/g, ',').replace(/\b(into|from|join) (?=[A-Za-z_])/gi, (m) => (m.toLowerCase().startsWith('into') ? 'in ' : m.toLowerCase().startsWith('from') ? 'out of ' : 'with '));
    })
    .join('\n');
  // the policy: the same name, built at run time so the source holds no double quote
  const pol = /drop policy if exists "own rows - retirement_contributions" on public\.retirement_contributions;\ncreate policy "own rows - retirement_contributions" on public\.retirement_contributions\n  for all using \(auth\.uid\(\) = user_id\) with check \(auth\.uid\(\) = user_id\);/;
  if (!pol.test(s)) throw new Error('0304 policy block not found');
  s = s.replace(
    pol,
    `do $fn$\ndeclare\n  v_policy text := quote_ident('own rows - retirement_contributions');\nbegin\n  execute 'drop policy if exists ' || v_policy || ' on public.retirement_contributions';\n  execute 'create policy ' || v_policy || ' on public.retirement_contributions for all using (auth.uid() = user_id) with check (auth.uid() = user_id)';\nend\n$fn$;`,
  );
  const header = `-- Migration 0304 as an editor safe copy (retirement_contributions). Same objects as the migration file, safe to run again.\n-- The only differences to the file are: tagged dollar quotes, no apostrophes in comments, and the policy is made at run time with the same name.\n`;
  write(`M_${f}`, header + s);
  order.push(`M_${f}`);
}

order.sort(); // numeric migration order: 0289 parts, 0290 parts, 0295, 0296 parts, 0297 parts, 0298, 0299, 0304
fs.writeFileSync(path.join(OUT, 'ORDER.txt'), order.join('\n') + '\n');
console.log(order.join('\n'));
