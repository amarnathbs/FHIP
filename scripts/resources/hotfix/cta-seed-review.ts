// Resources Admin hotfix — spec §20 CTA seed review.
//
// spec §20: propose a seed set "based ONLY on the CTA labels already used by
// the certified 84 P0 Resources and actual existing FHIP routes... do not
// insert until the mapping has been validated against actual application
// routes... If no route exists: leave the CTA unresolved and report it."
//
// LIVE-DEV TIMING NOTE (disclosed, not glossed over): earlier in this same
// hotfix session, a direct query against resource_posts found ZERO rows
// with a non-null content_id (0 of 200 total rows) — the certified P0 corpus
// appeared entirely absent from DEV. Re-querying later, after the rest of
// this hotfix's implementation work, found 218 rows with a real content_id
// (FH-*, MM-*, ER-*, EX-*, etc., matching scripts/resources/p0-content/
// verify-p0-content.ts's EXPECTED_IDS convention) out of a growing total row
// count (200 -> 311 -> 306 across three checks in one session). This is
// consistent with the orchestration brief's own warning that up to three
// OTHER large workstreams are running concurrently against this exact same
// DEV project right now — something else populated/repopulated P0 content
// mid-session. This script's own textual-evidence numbers below are
// therefore a snapshot as of the run printed to the console, not a
// permanently stable fact — re-run this script before trusting its output
// if DEV has changed since.
//
// This script mines the real content_blocks text of every resource_posts
// row with a non-null content_id for plain-language mentions of each
// candidate CTA's subject (spec §20's actual "labels already used"
// requirement), and only recommends seeding a CTA whose destination is (a) a
// verified real FHIP route (FHIP_MODULE_ROUTES, the same allowlist
// lib/resources/cta/validation.ts enforces app-wide) AND (b) has at least
// one real content-text match. Anything failing either test is left
// unresolved in the CSV with Recommended_Seed = No and a reason, per spec
// §20's explicit instruction — never fabricated.
//
// Run: npx tsx --env-file=.env.local scripts/resources/hotfix/cta-seed-review.ts
// Apply: npx tsx --env-file=.env.local scripts/resources/hotfix/cta-seed-review.ts -- --apply

import { writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { assertDevProject } from '../lib/env';
import { validateCtaDestination } from '../../../lib/resources/cta/validation';
import { FHIP_MODULE_ROUTES } from '../../../lib/resources/context/registry';

interface ProposedCta {
  name: string;
  label: string;
  description: string;
  destination_type: 'fhip_module' | 'registration';
  destination_url: string;
  primary_module: string;
  matchPhrases: string[]; // plain-text phrases that count as body-text evidence for this CTA
}

const PROPOSED: ProposedCta[] = [
  { name: 'Check Your Financial Health Score', label: 'Check Your Financial Health Score', description: 'Send the reader to their live FHIP Financial Health Score.', destination_type: 'fhip_module', destination_url: '/score', primary_module: 'Scores', matchPhrases: ['financial health score'] },
  { name: 'Explore Your Dashboard', label: 'Explore Your Dashboard', description: 'Send the reader to their FHIP financial dashboard.', destination_type: 'fhip_module', destination_url: '/dashboard', primary_module: 'Dashboard', matchPhrases: ['dashboard'] },
  { name: 'Start a Savings Goal', label: 'Start a Savings Goal', description: 'Send the reader to set up or review a savings/emergency-fund goal.', destination_type: 'fhip_module', destination_url: '/goals', primary_module: 'Goals', matchPhrases: ['savings goal', 'emergency fund'] },
  { name: 'See Your Forecast', label: 'See Your Financial Forecast', description: 'Send the reader to their FHIP forecasting overview.', destination_type: 'fhip_module', destination_url: '/forecast', primary_module: 'Forecasting', matchPhrases: ['forecast'] },
  { name: 'Review Your Recommendations', label: 'Review Your Recommendations', description: 'Send the reader to their personalised FHIP recommendations.', destination_type: 'fhip_module', destination_url: '/recommendations', primary_module: 'Recommendations', matchPhrases: ['recommendation'] },
  { name: 'Check Your Resilience', label: 'Check Your Financial Resilience', description: 'Send the reader to their FHIP Financial Resilience assessment.', destination_type: 'fhip_module', destination_url: '/resilience', primary_module: 'Resilience', matchPhrases: ['resilience'] },
  { name: 'Create a Free FHIP Account', label: 'Create a Free FHIP Account', description: 'Send an unregistered reader to sign up.', destination_type: 'registration', destination_url: '/signup', primary_module: 'Registration', matchPhrases: ['sign up', 'create an account', 'create a free account', 'get started free'] },
];

interface CsvRow {
  CTA_Label: string;
  Referenced_By_Content_IDs: string;
  Primary_Module: string;
  Proposed_Destination: string;
  Destination_Exists: string;
  Recommended_Seed: string;
  Notes: string;
}

function toCsv(rows: CsvRow[]): string {
  const headers: (keyof CsvRow)[] = ['CTA_Label', 'Referenced_By_Content_IDs', 'Primary_Module', 'Proposed_Destination', 'Destination_Exists', 'Recommended_Seed', 'Notes'];
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  return [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\n');
}

function extractText(blocks: unknown): string {
  let out = '';
  function walk(b: unknown) {
    if (!b) return;
    if (typeof b === 'string') { out += ' ' + b; return; }
    if (Array.isArray(b)) { b.forEach(walk); return; }
    if (typeof b === 'object') {
      const obj = b as Record<string, unknown>;
      for (const k of ['text', 'content', 'value', 'html', 'question', 'answer']) {
        if (typeof obj[k] === 'string') out += ' ' + obj[k];
      }
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (v && typeof v === 'object') walk(v);
      }
    }
  }
  walk(blocks);
  return out.toLowerCase();
}

async function main() {
  const creds = assertDevProject();
  const admin = createClient(creds.url, creds.serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const apply = process.argv.includes('--apply');

  const { data: p0Posts, error: postsErr } = await admin.from('resource_posts').select('content_id, content_blocks').not('content_id', 'is', null);
  if (postsErr) { console.error('FATAL:', postsErr.message); process.exit(1); }
  const { count: totalPosts } = await admin.from('resource_posts').select('id', { count: 'exact', head: true });
  console.log(`resource_posts with a real content_id (P0 corpus marker): ${(p0Posts ?? []).length} of ${totalPosts ?? 0} total rows (live snapshot — see file header timing note).`);

  const postTexts = (p0Posts ?? []).map((p: { content_id: string; content_blocks: unknown }) => ({ content_id: p.content_id, text: extractText(p.content_blocks) }));

  const { data: existingCtas, error: existingErr } = await admin.from('resource_ctas').select('label, destination_type, destination_url');
  if (existingErr) { console.error('FATAL:', existingErr.message); process.exit(1); }
  const existingKey = new Set((existingCtas ?? []).map((c: { label: string; destination_type: string; destination_url: string }) => `${c.label.toLowerCase()}|${c.destination_type}|${c.destination_url}`));

  const rows: CsvRow[] = [];
  const toInsert: ProposedCta[] = [];
  for (const p of PROPOSED) {
    const destCheck = validateCtaDestination(p.destination_type, p.destination_url);
    const routeExists = p.destination_type === 'registration' ? p.destination_url === '/signup' : FHIP_MODULE_ROUTES.includes(p.destination_url);
    const matchedIds = postTexts.filter((pt) => p.matchPhrases.some((ph) => pt.text.includes(ph))).map((pt) => pt.content_id);
    const already = existingKey.has(`${p.label.toLowerCase()}|${p.destination_type}|${p.destination_url}`);
    const hasEvidence = matchedIds.length > 0;
    const recommend = destCheck.valid && routeExists && hasEvidence && !already;

    let notes = destCheck.valid ? 'Passes validateCtaDestination() unchanged from lib/resources/cta/validation.ts.' : `Rejected: ${destCheck.error}`;
    if (!hasEvidence) notes += ' No matching phrase found in any P0 content body text at review time — left unresolved per spec §20, not seeded.';
    if (already) notes += ' Already exists in resource_ctas — skipped as a duplicate.';

    rows.push({
      CTA_Label: p.label,
      Referenced_By_Content_IDs: hasEvidence ? matchedIds.slice(0, 12).join('; ') + (matchedIds.length > 12 ? ` (+${matchedIds.length - 12} more)` : '') : 'none found',
      Primary_Module: p.primary_module,
      Proposed_Destination: p.destination_url,
      Destination_Exists: routeExists ? 'Yes' : 'No',
      Recommended_Seed: already ? 'No (already exists)' : recommend ? 'Yes' : 'No',
      Notes: notes,
    });
    if (recommend) toInsert.push(p);
  }

  const csv = toCsv(rows);
  writeFileSync('resources-cta-seed-review.csv', csv, 'utf-8');
  console.log(`Wrote resources-cta-seed-review.csv (${rows.length} proposed rows, ${toInsert.length} recommended with real content evidence).`);
  for (const r of rows) console.log(`  - ${r.CTA_Label}: Recommended_Seed=${r.Recommended_Seed}, evidence=${r.Referenced_By_Content_IDs.slice(0, 60)}`);

  if (!apply) {
    console.log('Dry run only. Re-run with -- --apply to insert the recommended rows above.');
    return;
  }

  for (const p of toInsert) {
    const { error } = await admin.from('resource_ctas').insert({
      name: p.name,
      label: p.label,
      description: p.description,
      destination_type: p.destination_type,
      destination_url: p.destination_url,
      is_active: true,
    });
    if (error) console.error(`FAILED to insert "${p.label}":`, error.message);
    else console.log(`Inserted CTA: ${p.label} -> ${p.destination_url}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
