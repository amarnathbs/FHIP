// R1.7C — related-content links. Loads ONLY explicit, source-authored
// "Related guide / explainer" / "Related @GKTC" references found verbatim
// in the DOCX drafts (never a fuzzy semantic-similarity graph). Every
// relationship in p0-related-content-map.csv was verified by exact
// Content-ID + title substring match against the real source text before
// this script runs. Both sides of every relationship are Draft P0 posts,
// so nothing here can expose a Draft to the public regardless.
//
//   npm run resources:p0:related-dry-run
//   npm run resources:p0:related-apply -- --confirm-project=vqycarelcoijzwlpkpcz

import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { assertDevProject } from '../lib/env';

const CSV_PATH = 'D:/FHIP/content/consolidated/p0-related-content-map.csv';

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    apply: args.includes('--apply'),
    confirmProject: (args.find((a) => a.startsWith('--confirm-project=')) ?? '').split('=')[1] || null,
  };
}

function parseCsv(text: string): { content_id: string; related_content_id: string }[] {
  const lines = text.trim().split('\n').slice(1); // skip header
  const rows: { content_id: string; related_content_id: string }[] = [];
  for (const line of lines) {
    // simple CSV split good enough here — fields never contain commas inside quotes for these two columns specifically
    const m = line.match(/^([^,]+),([^,]+),/);
    if (m) rows.push({ content_id: m[1], related_content_id: m[2] });
  }
  return rows;
}

async function main() {
  const args = parseArgs();
  const creds = assertDevProject();
  if (args.apply && args.confirmProject !== 'vqycarelcoijzwlpkpcz') {
    console.error('FATAL: --apply requires --confirm-project=vqycarelcoijzwlpkpcz. Refusing.');
    process.exit(1);
  }
  console.log(`[R1.7C Related-Content Loader] mode=${args.apply ? 'APPLY' : 'DRY-RUN'} project=${creds.projectRef}`);

  const rows = parseCsv(readFileSync(CSV_PATH, 'utf-8'));
  console.log(`Parsed ${rows.length} candidate relationships from ${CSV_PATH}`);

  const supa = createClient(creds.url, creds.serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const allIds = Array.from(new Set(rows.flatMap((r) => [r.content_id, r.related_content_id])));
  const { data: posts, error } = await supa.from('resource_posts').select('id,content_id,status,visibility').in('content_id', allIds);
  if (error) { console.error(error); process.exit(1); }
  const byContentId = new Map((posts ?? []).map((p) => [p.content_id as string, p]));

  let created = 0, skippedExisting = 0, blockedMissing = 0, blockedNotDraft = 0;
  for (const r of rows) {
    const source = byContentId.get(r.content_id);
    const related = byContentId.get(r.related_content_id);
    if (!source || !related) { blockedMissing++; continue; }
    // Extra safety: never link if either side is somehow not Draft/private
    // (would only matter post-publication -- defense in depth, not expected
    // to trigger given both are the same freshly-loaded P0 batch).
    if (source.status !== 'draft' || related.status !== 'draft') { blockedNotDraft++; continue; }

    if (args.apply) {
      const { error: insErr, data: insData } = await supa
        .from('resource_related_content')
        .upsert({ source_post_id: source.id, related_post_id: related.id, relationship_type: 'related' }, { onConflict: 'source_post_id,related_post_id,relationship_type', ignoreDuplicates: true })
        .select();
      if (insErr) { console.error(`FAILED ${r.content_id}->${r.related_content_id}: ${insErr.message}`); continue; }
      if (insData && insData.length > 0) created++; else skippedExisting++;
    } else {
      created++; // dry-run: would-create count
    }
  }

  console.log('--- Summary ---');
  console.log(JSON.stringify({ mode: args.apply ? 'apply' : 'dry-run', total_candidates: rows.length, created, skipped_already_exists: skippedExisting, blocked_missing_post: blockedMissing, blocked_not_draft: blockedNotDraft }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
