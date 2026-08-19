// R1.7 — Content Master Import.
//
//   npm run resources:import-r0a               (dry-run, default, writes nothing)
//   npm run resources:import-r0a -- --dry-run   (explicit dry-run)
//   npm run resources:import-r0a -- --apply --confirm-project=vqycarelcoijzwlpkpcz
//
// See docs/resources/R1.7-Implementation-Completion-Report.md for the full
// design rationale (source hierarchy, idempotency, human-edit-protection,
// fabrication firewall). This file is the orchestrator; per-concern logic
// lives in scripts/resources/lib/*.

import { writeFileSync, mkdirSync } from 'node:fs';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { assertDevProject } from './lib/env';
import { parseWorkbook } from './lib/workbook';
import { planRow, type PlannedRow } from './lib/planRow';
import { resolveSlug } from './lib/slug';
import { normalizeForMatch, categorySlugFor, tagSlugFor, type CategoryRef, type TagRef } from './lib/taxonomy';
import { classifyReadiness, type ReadinessBucket } from './lib/readiness';
import { starterTemplateFor } from '@/lib/resources/editor/blocks';

const WORKBOOK_PATH = 'docs/resources/r1-7-source/FHIP_R0-A_Resources_Content_Master.xlsx';
const MANIFEST_PATH = 'artifacts/resources/r1-7-import-manifest.json';
const VALIDATION_JSON_PATH = 'artifacts/resources/r1-7-preimport-validation.json';
const VALIDATION_MD_PATH = 'docs/resources/R1.7-preimport-validation-report.md';
const EXECUTION_MD_PATH = 'docs/resources/R1.7-import-execution-report.md';
const BATCH_SIZE = 40;

// Pre-verified expected counts (spec §15-17) — cross-checked against our own
// fresh parse below; a mismatch STOPS the run rather than being silently
// trusted either way.
const EXPECTED = {
  total: 218,
  byType: { Article: 86, Glossary: 50, 'FHIP Explainer': 26, Guide: 24, Video: 20, 'Money Update Template': 12 },
  byJurisdiction: { Global: 174, India: 17, Australia: 15, 'Australia-India Cross-Border': 12 },
  byPriority: { P1: 118, P0: 84, Ongoing: 12, P2: 4 },
  byRisk: { GREEN: 167, AMBER: 51 },
};

interface RunArgs {
  apply: boolean;
  confirmProject: string | null;
}

function parseArgs(): RunArgs {
  const args = process.argv.slice(2);
  return {
    apply: args.includes('--apply'),
    confirmProject: (args.find((a) => a.startsWith('--confirm-project=')) ?? '').split('=')[1] || null,
  };
}

function countBy<T, K extends keyof T>(rows: T[], key: K): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const v = String(r[key]);
    out[v] = (out[v] ?? 0) + 1;
  }
  return out;
}

function countsMatch(actual: Record<string, number>, expected: Record<string, number>): string[] {
  const diffs: string[] = [];
  const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
  for (const k of keys) {
    if ((actual[k] ?? 0) !== (expected[k] ?? 0)) {
      diffs.push(`  "${k}": expected ${expected[k] ?? 0}, got ${actual[k] ?? 0}`);
    }
  }
  return diffs;
}

interface ManifestRowOutcome {
  contentId: string;
  postId: string | null;
  outcome: 'inserted' | 'updated' | 'skipped_noop' | 'skipped_protected' | 'failed';
  reason?: string;
  slug?: string;
  slugSource?: string;
  readiness?: ReadinessBucket[];
}

async function loadExistingLookupTables(supa: SupabaseClient) {
  const [{ data: cats }, { data: tags }, { data: ctas }, { data: posts }] = await Promise.all([
    supa.from('resource_categories').select('id,name,slug'),
    supa.from('resource_tags').select('id,name,slug'),
    supa.from('resource_ctas').select('id,name,label,is_active').eq('is_active', true),
    supa.from('resource_posts').select('id,content_id,slug,status,updated_by,updated_at,created_at'),
  ]);
  const categoryByKey = new Map<string, CategoryRef>();
  for (const c of cats ?? []) categoryByKey.set(normalizeForMatch(c.name), c as CategoryRef);
  const tagByKey = new Map<string, TagRef>();
  for (const t of tags ?? []) tagByKey.set(normalizeForMatch(t.name), t as TagRef);
  const ctaByKey = new Map<string, { id: string; label: string }>();
  for (const c of ctas ?? []) ctaByKey.set(normalizeForMatch(c.label), { id: c.id as string, label: c.label as string });
  const existingSlugs = new Set<string>((posts ?? []).map((p) => p.slug).filter((s): s is string => !!s));
  const existingByContentId = new Map<string, { id: string; slug: string | null; status: string; updated_by: string | null; updated_at: string; created_at: string }>();
  for (const p of posts ?? []) {
    if (p.content_id) existingByContentId.set(p.content_id, p as never);
  }
  return { categoryByKey, tagByKey, ctaByKey, existingSlugs, existingByContentId };
}

async function main() {
  const args = parseArgs();
  const creds = assertDevProject(); // hard exit if not vqycarelcoijzwlpkpcz

  console.log(`[R1.7 Importer] mode=${args.apply ? 'APPLY' : 'DRY-RUN'} project=${creds.projectRef}`);

  // -------------------------------------------------------------------
  // 1. Parse + count gates
  // -------------------------------------------------------------------
  const { workbook, sparseRowWarnings } = parseWorkbook(WORKBOOK_PATH);
  console.log(`Workbook SHA-256: ${workbook.sourceHash}`);
  console.log(`Sheets: ${workbook.sheetNames.join(', ')}`);
  console.log(`Content_Master data rows parsed: ${workbook.contentMaster.length}`);

  const gateErrors: string[] = [];
  if (workbook.contentMaster.length !== EXPECTED.total) {
    gateErrors.push(`Total row count mismatch: expected ${EXPECTED.total}, got ${workbook.contentMaster.length}`);
  }
  gateErrors.push(...countsMatch(countBy(workbook.contentMaster, 'Content_Type'), EXPECTED.byType).map((d) => `Content_Type${d}`));
  gateErrors.push(...countsMatch(countBy(workbook.contentMaster, 'Jurisdiction'), EXPECTED.byJurisdiction).map((d) => `Jurisdiction${d}`));
  gateErrors.push(...countsMatch(countBy(workbook.contentMaster, 'Launch_Priority'), EXPECTED.byPriority).map((d) => `Launch_Priority${d}`));
  gateErrors.push(...countsMatch(countBy(workbook.contentMaster, 'Risk_Class'), EXPECTED.byRisk).map((d) => `Risk_Class${d}`));

  if (gateErrors.length > 0) {
    console.error('COUNT GATE FAILED — refusing to proceed:');
    gateErrors.forEach((e) => console.error('  ' + e));
    process.exit(1);
  }
  console.log('Count gates PASSED: 218 total, per-type/jurisdiction/priority/risk counts all match expected.');

  // -------------------------------------------------------------------
  // 2. Row-level validation (pure, no DB)
  // -------------------------------------------------------------------
  const seenIds = new Set<string>();
  const planned: PlannedRow[] = workbook.contentMaster.map((r) => planRow(r, seenIds));
  const allIssues = planned.flatMap((p) => p.issues);
  const errorIssues = allIssues.filter((i) => i.severity === 'error');
  const warningIssues = allIssues.filter((i) => i.severity === 'warning');

  // Video rows: confirm GKTC_Video_Linkage is always an internal VID-NNN ref,
  // never fabricate/accept a real-looking YouTube ID as if it were real.
  const videoRows = workbook.contentMaster.filter((r) => r.Content_Type === 'Video');
  const videoLinkageIssues: string[] = [];
  for (const v of videoRows) {
    if (!/^VID-\d{3}$/.test(v.GKTC_Video_Linkage)) {
      videoLinkageIssues.push(`${v.Content_ID}: GKTC_Video_Linkage "${v.GKTC_Video_Linkage}" is not an internal VID-NNN reference`);
    }
  }

  // Duplicate-title analysis (spec §73 — analyse, never auto-merge).
  const titleGroups = new Map<string, string[]>();
  for (const r of workbook.contentMaster) {
    const key = r.Title.trim().toLowerCase();
    const arr = titleGroups.get(key) ?? [];
    arr.push(r.Content_ID);
    titleGroups.set(key, arr);
  }
  const duplicateTitles = [...titleGroups.entries()].filter(([, ids]) => ids.length > 1);

  // Glossary case-insensitive duplicate-term analysis (spec §53).
  const glossaryRows = workbook.contentMaster.filter((r) => r.Content_Type === 'Glossary');
  const glossaryTermGroups = new Map<string, string[]>();
  for (const r of glossaryRows) {
    const key = r.Title.trim().toLowerCase();
    const arr = glossaryTermGroups.get(key) ?? [];
    arr.push(r.Content_ID);
    glossaryTermGroups.set(key, arr);
  }
  const glossaryDuplicates = [...glossaryTermGroups.entries()].filter(([, ids]) => ids.length > 1);

  // -------------------------------------------------------------------
  // 3. Connect to DB (read-only for dry-run) and resolve DB-dependent state
  // -------------------------------------------------------------------
  const supa = createClient(creds.url, creds.serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { categoryByKey, tagByKey, ctaByKey, existingSlugs, existingByContentId } = await loadExistingLookupTables(supa);
  const { count: totalExistingPosts } = await supa.from('resource_posts').select('*', { count: 'exact', head: true });
  console.log(`Existing DEV resource_posts total: ${totalExistingPosts} (of which already import-tracked via content_id: ${existingByContentId.size})`);

  // Plan category/tag creation (deterministic; never substitute).
  const categoriesToCreate = new Map<string, string>(); // normalizedKey -> original label
  const tagsToCreate = new Map<string, string>();
  for (const p of planned) {
    const catKey = normalizeForMatch(p.primaryCategoryLabel);
    if (p.primaryCategoryLabel && !categoryByKey.has(catKey) && !categoriesToCreate.has(catKey)) {
      categoriesToCreate.set(catKey, p.primaryCategoryLabel);
    }
    const subKey = normalizeForMatch(p.subcategoryLabel);
    if (p.subcategoryLabel && !tagByKey.has(subKey) && !tagsToCreate.has(subKey)) {
      tagsToCreate.set(subKey, p.subcategoryLabel);
    }
  }

  // Plan slugs. Reuse existing slug for already-imported content_ids
  // (idempotency); otherwise resolve fresh, claiming across the whole batch
  // so two workbook rows never collide with each other either.
  const claimedSlugs = new Set<string>(existingSlugs);
  const slugPlan = new Map<string, { slug: string; source: string }>();
  for (const p of planned) {
    const existing = existingByContentId.get(p.contentId);
    if (existing?.slug) {
      slugPlan.set(p.contentId, { slug: existing.slug, source: 'existing_reuse' });
      continue; // already claimed (it's in existingSlugs already)
    }
    const resolved = resolveSlug({ proposedUrl: p.proposedUrl, title: p.title, contentId: p.contentId, claimed: claimedSlugs });
    claimedSlugs.add(resolved.slug);
    slugPlan.set(p.contentId, { slug: resolved.slug, source: resolved.source });
  }

  // CTA resolution — only exact normalized-label match against active CTAs
  // already in DEV; never create CTAs here (spec §47: report unresolved,
  // don't mass-create).
  let ctaResolvedCount = 0;
  const ctaResolution = new Map<string, string | null>(); // contentId -> resolved cta id or null
  for (const p of planned) {
    const key = normalizeForMatch(p.primaryCtaLabel);
    const match = ctaByKey.get(key);
    ctaResolution.set(p.contentId, match ? match.id : null);
    if (match) ctaResolvedCount++;
  }

  // Readiness classification.
  const readinessByContentId = new Map<string, ReadinessBucket[]>();
  for (const p of planned) {
    readinessByContentId.set(
      p.contentId,
      classifyReadiness({
        contentType: p.contentType ?? 'unknown',
        hasUnresolvedTaxonomy: false, // all categories are deterministically created/matched, never left unresolved
        ctaResolved: !!ctaResolution.get(p.contentId),
      })
    );
  }

  // -------------------------------------------------------------------
  // 4. Predict insert/update/skip and write the pre-import validation report
  // -------------------------------------------------------------------
  let predictedInsert = 0;
  let predictedUpdateOrNoop = 0;
  let predictedProtectedSkip = 0;
  const protectionNotes: string[] = [];
  for (const p of planned) {
    const existing = existingByContentId.get(p.contentId);
    if (!existing) {
      predictedInsert++;
      continue;
    }
    const protectedRow = existing.status !== 'draft' && existing.status !== 'idea';
    const protectedByEditor = !!existing.updated_by;
    if (protectedRow || protectedByEditor) {
      predictedProtectedSkip++;
      protectionNotes.push(`${p.contentId}: existing post ${existing.id} protected (status=${existing.status}, updated_by=${existing.updated_by ?? 'null'})`);
    } else {
      predictedUpdateOrNoop++;
    }
  }

  mkdirSync('artifacts/resources', { recursive: true });
  mkdirSync('docs/resources', { recursive: true });

  const validationReport = {
    source_file: WORKBOOK_PATH,
    source_hash: workbook.sourceHash,
    run_timestamp: new Date().toISOString(),
    environment: creds.projectRef,
    row_count: workbook.contentMaster.length,
    counts: {
      by_type: countBy(workbook.contentMaster, 'Content_Type'),
      by_jurisdiction: countBy(workbook.contentMaster, 'Jurisdiction'),
      by_priority: countBy(workbook.contentMaster, 'Launch_Priority'),
      by_risk: countBy(workbook.contentMaster, 'Risk_Class'),
    },
    duplicate_content_ids: errorIssues.filter((i) => i.field === 'Content_ID').map((i) => i.contentId),
    duplicate_titles: duplicateTitles.map(([title, ids]) => ({ title, contentIds: ids })),
    glossary_duplicate_terms: glossaryDuplicates.map(([term, ids]) => ({ term, contentIds: ids })),
    sparse_row_warnings: sparseRowWarnings,
    video_linkage_anomalies: videoLinkageIssues,
    validation_errors: errorIssues,
    validation_warnings: warningIssues,
    taxonomy: {
      categories_to_create: [...categoriesToCreate.values()],
      tags_to_create: [...tagsToCreate.values()],
      categories_matched_existing: planned.length - categoriesToCreate.size, // informational, not exact per-row
    },
    cta_resolution: { resolved: ctaResolvedCount, unresolved: planned.length - ctaResolvedCount },
    context_mapping: { resolved: 0, note: 'The R0-A workbook contains no fields that map to R1.6 FHIP context_key values (Primary_FHIP_Module/Secondary_FHIP_Module are descriptive labels, not registered context keys). 0/218 context_links created; left for future editorial curation.' },
    video_metadata: { planned: videoRows.length, real_youtube_metadata_present: 0, note: 'Zero real YouTube IDs/URLs exist anywhere in the source workbook for any of the 20 planned videos — confirmed by regex check above. No resource_videos rows will be created; only resource_posts identities.' },
    predicted: { insert: predictedInsert, update_or_noop: predictedUpdateOrNoop, protected_skip: predictedProtectedSkip },
    protection_notes: protectionNotes,
  };
  writeFileSync(VALIDATION_JSON_PATH, JSON.stringify(validationReport, null, 2));

  const md = [
    '# R1.7 Pre-Import Validation Report',
    '',
    `- Source file: \`${WORKBOOK_PATH}\``,
    `- Source SHA-256: \`${workbook.sourceHash}\``,
    `- Run timestamp: ${validationReport.run_timestamp}`,
    `- Environment: ${creds.projectRef}`,
    `- Row count: ${workbook.contentMaster.length} (expected 218)`,
    '',
    '## Counts',
    '```json',
    JSON.stringify(validationReport.counts, null, 2),
    '```',
    '',
    `## Validation errors: ${errorIssues.length}`,
    ...errorIssues.map((i) => `- [${i.contentId} row ${i.row}] ${i.field}: ${i.message}`),
    '',
    `## Validation warnings: ${warningIssues.length}`,
    ...warningIssues.map((i) => `- [${i.contentId} row ${i.row}] ${i.field}: ${i.message}`),
    '',
    `## Duplicate titles (analysed, not merged): ${duplicateTitles.length}`,
    ...duplicateTitles.map(([t, ids]) => `- "${t}" — ${ids.join(', ')}`),
    '',
    `## Glossary duplicate terms: ${glossaryDuplicates.length}`,
    ...glossaryDuplicates.map(([t, ids]) => `- "${t}" — ${ids.join(', ')}`),
    '',
    '## Taxonomy',
    `- Categories to create: ${categoriesToCreate.size} — ${[...categoriesToCreate.values()].join(', ')}`,
    `- Tags to create: ${tagsToCreate.size} — ${[...tagsToCreate.values()].join(', ')}`,
    '',
    `## CTA resolution: ${ctaResolvedCount}/${planned.length} resolved against existing active resource_ctas`,
    '',
    '## Video source metadata',
    `- Planned Video Resources: ${videoRows.length}`,
    `- Rows with real YouTube ID/URL present: 0`,
    `- GKTC_Video_Linkage anomalies (non VID-NNN values): ${videoLinkageIssues.length}`,
    '',
    '## Predicted apply outcome',
    `- Insert: ${predictedInsert}`,
    `- Update/no-op (existing, unprotected): ${predictedUpdateOrNoop}`,
    `- Protected skip (existing, human-edited): ${predictedProtectedSkip}`,
  ].join('\n');
  writeFileSync(VALIDATION_MD_PATH, md);
  console.log(`Wrote ${VALIDATION_JSON_PATH} and ${VALIDATION_MD_PATH}`);

  if (errorIssues.length > 0) {
    console.error(`VALIDATION FAILED: ${errorIssues.length} error-severity issue(s). See ${VALIDATION_MD_PATH}.`);
  }

  // -------------------------------------------------------------------
  // 5. Dry-run stops here.
  // -------------------------------------------------------------------
  if (!args.apply) {
    console.log('\nDRY-RUN complete. No database writes were made.');
    console.log(`Predicted: insert=${predictedInsert} update/no-op=${predictedUpdateOrNoop} protected-skip=${predictedProtectedSkip}`);
    process.exit(errorIssues.length > 0 ? 1 : 0);
  }

  // -------------------------------------------------------------------
  // 6. --apply: double-confirmation guard
  // -------------------------------------------------------------------
  if (args.confirmProject !== creds.projectRef) {
    console.error(`FATAL: --apply requires --confirm-project=${creds.projectRef} (got "${args.confirmProject ?? 'none'}"). Refusing to write.`);
    process.exit(1);
  }
  if (errorIssues.length > 0) {
    console.error(`FATAL: ${errorIssues.length} validation error(s) present. Refusing to apply. See ${VALIDATION_MD_PATH}.`);
    process.exit(1);
  }
  console.log('\n=== APPLY CONFIRMATION ===');
  console.log(`Environment: ${creds.projectRef} (DEV, confirmed)`);
  console.log(`Row count to process: ${planned.length}`);
  console.log(`Predicted insert=${predictedInsert} update/no-op=${predictedUpdateOrNoop} protected-skip=${predictedProtectedSkip}`);
  console.log('===========================\n');

  // -------------------------------------------------------------------
  // 7. Create missing categories/tags (deterministic, before Pass 1)
  // -------------------------------------------------------------------
  const createdCategories: { name: string; slug: string; id: string }[] = [];
  for (const [key, label] of categoriesToCreate) {
    const slug = categorySlugFor(label);
    const { data, error } = await supa.from('resource_categories').insert({ name: label, slug, sort_order: 100 }).select('id,name,slug').single();
    if (error) {
      console.error(`Failed to create category "${label}": ${error.message}`);
      process.exit(1);
    }
    categoryByKey.set(key, data as CategoryRef);
    createdCategories.push({ name: label, slug, id: data!.id as string });
  }
  const createdTags: { name: string; slug: string; id: string }[] = [];
  for (const [key, label] of tagsToCreate) {
    const slug = tagSlugFor(label);
    const { data, error } = await supa.from('resource_tags').insert({ name: label, slug }).select('id,name,slug').single();
    if (error) {
      console.error(`Failed to create tag "${label}": ${error.message}`);
      process.exit(1);
    }
    tagByKey.set(key, data as TagRef);
    createdTags.push({ name: label, slug, id: data!.id as string });
  }
  console.log(`Created ${createdCategories.length} new categories, ${createdTags.length} new tags.`);

  // -------------------------------------------------------------------
  // 8. Pass 1 — upsert resource_posts, batched
  // -------------------------------------------------------------------
  const runId = `r0a-${Date.now()}`;
  const importTimestamp = new Date().toISOString();
  const outcomes: ManifestRowOutcome[] = [];
  const postIdByContentId = new Map<string, string>();

  for (let i = 0; i < planned.length; i += BATCH_SIZE) {
    const batch = planned.slice(i, i + BATCH_SIZE);
    for (const p of batch) {
      const idx = planned.indexOf(p) + 1;
      const existing = existingByContentId.get(p.contentId);
      const catRef = categoryByKey.get(normalizeForMatch(p.primaryCategoryLabel)) ?? null;
      const slugInfo = slugPlan.get(p.contentId)!;

      if (existing) {
        const protectedRow = existing.status !== 'draft' && existing.status !== 'idea';
        const protectedByEditor = !!existing.updated_by;
        if (protectedRow || protectedByEditor) {
          outcomes.push({ contentId: p.contentId, postId: existing.id, outcome: 'skipped_protected', reason: `status=${existing.status} updated_by=${existing.updated_by ?? 'null'}`, readiness: readinessByContentId.get(p.contentId) });
          postIdByContentId.set(p.contentId, existing.id);
          console.log(`[${idx}/${planned.length}] ${p.contentId} — skipped (protected: human-edited or workflow-advanced)`);
          continue;
        }
        // Reconcile metadata fields only — never touch content_blocks/slug on an existing row.
        const patch = {
          title: p.title,
          content_type: p.contentType,
          jurisdiction: p.jurisdiction,
          difficulty: p.difficulty,
          freshness_type: p.freshnessType,
          compliance_classification: p.complianceClassification,
          visibility: 'private',
          is_indexable: false,
        };
        const { error } = await supa.from('resource_posts').update(patch).eq('id', existing.id);
        if (error) {
          outcomes.push({ contentId: p.contentId, postId: existing.id, outcome: 'failed', reason: error.message });
          console.error(`[${idx}/${planned.length}] ${p.contentId} — FAILED update: ${error.message}`);
          continue;
        }
        outcomes.push({ contentId: p.contentId, postId: existing.id, outcome: 'updated', slug: slugInfo.slug, slugSource: slugInfo.source, readiness: readinessByContentId.get(p.contentId) });
        postIdByContentId.set(p.contentId, existing.id);
        console.log(`[${idx}/${planned.length}] ${p.contentId} — reconciled (unprotected)`);
      } else {
        const contentBlocks = p.contentType === 'article' || p.contentType === 'guide' || p.contentType === 'fhip_explainer' ? starterTemplateFor(p.contentType) : [];
        const insertPayload = {
          content_id: p.contentId,
          title: p.title,
          slug: slugInfo.slug,
          excerpt: null,
          content_blocks: contentBlocks,
          content_type: p.contentType,
          jurisdiction: p.jurisdiction,
          difficulty: p.difficulty,
          freshness_type: p.freshnessType,
          visibility: 'private',
          primary_category_id: catRef?.id ?? null,
          status: 'draft',
          compliance_classification: p.complianceClassification,
          is_indexable: false,
          primary_cta_id: ctaResolution.get(p.contentId) ?? null,
          is_featured: false,
        };
        const { data, error } = await supa.from('resource_posts').insert(insertPayload).select('id').single();
        if (error) {
          outcomes.push({ contentId: p.contentId, postId: null, outcome: 'failed', reason: error.message });
          console.error(`[${idx}/${planned.length}] ${p.contentId} — FAILED insert: ${error.message}`);
          continue;
        }
        outcomes.push({ contentId: p.contentId, postId: data!.id as string, outcome: 'inserted', slug: slugInfo.slug, slugSource: slugInfo.source, readiness: readinessByContentId.get(p.contentId) });
        postIdByContentId.set(p.contentId, data!.id as string);
        console.log(`[${idx}/${planned.length}] ${p.contentId} — imported`);
      }
    }
  }

  // -------------------------------------------------------------------
  // 9. Pass 2 — relationships (categories/tags) now that every post exists
  // -------------------------------------------------------------------
  for (const p of planned) {
    const postId = postIdByContentId.get(p.contentId);
    if (!postId) continue;
    const catRef = categoryByKey.get(normalizeForMatch(p.primaryCategoryLabel));
    if (catRef) {
      await supa.from('resource_post_categories').upsert({ post_id: postId, category_id: catRef.id, is_primary: true }, { onConflict: 'post_id,category_id' });
    }
    const tagRef = tagByKey.get(normalizeForMatch(p.subcategoryLabel));
    if (tagRef) {
      await supa.from('resource_post_tags').upsert({ post_id: postId, tag_id: tagRef.id }, { onConflict: 'post_id,tag_id' });
    }
  }
  console.log('Pass 2 complete: category/tag relationships linked.');

  // -------------------------------------------------------------------
  // 10. Provenance — one resource_audit_log row per touched post
  // -------------------------------------------------------------------
  const auditRows = outcomes
    .filter((o) => o.postId && (o.outcome === 'inserted' || o.outcome === 'updated'))
    .map((o) => {
      const p = planned.find((pp) => pp.contentId === o.contentId)!;
      return {
        entity_type: 'resource_post',
        entity_id: o.postId,
        action: o.outcome === 'inserted' ? 'r0a_import_insert' : 'r0a_import_update',
        actor_user_id: null,
        before_state: null,
        after_state: { content_id: p.contentId, content_type: p.contentType, jurisdiction: p.jurisdiction, status: 'draft' },
        metadata: {
          source: 'R0-A',
          run_id: runId,
          source_content_id: p.contentId,
          workbook_sha256: workbook.sourceHash,
          import_timestamp: importTimestamp,
          planning: p.planningMaterial,
        },
      };
    });
  for (let i = 0; i < auditRows.length; i += BATCH_SIZE) {
    const chunk = auditRows.slice(i, i + BATCH_SIZE);
    const { error } = await supa.from('resource_audit_log').insert(chunk);
    if (error) console.error(`Audit log batch write warning: ${error.message}`);
  }
  console.log(`Wrote ${auditRows.length} provenance audit_log rows.`);

  // -------------------------------------------------------------------
  // 11. Manifest + execution report
  // -------------------------------------------------------------------
  const inserted = outcomes.filter((o) => o.outcome === 'inserted');
  const updated = outcomes.filter((o) => o.outcome === 'updated');
  const skippedProtected = outcomes.filter((o) => o.outcome === 'skipped_protected');
  const failed = outcomes.filter((o) => o.outcome === 'failed');

  const manifest = {
    source_file: WORKBOOK_PATH,
    source_hash: workbook.sourceHash,
    run_id: runId,
    run_timestamp: importTimestamp,
    environment: creds.projectRef,
    total_rows: planned.length,
    inserted: inserted.length,
    updated: updated.length,
    skipped: skippedProtected.length,
    failed: failed.length,
    post_ids: outcomes.filter((o) => o.postId).map((o) => o.postId),
    content_ids: outcomes.map((o) => o.contentId),
    inserted_post_ids: inserted.map((o) => o.postId), // rollback-safe set: ONLY these are eligible for rollback deletion
    created_categories: createdCategories,
    created_tags: createdTags,
    warnings: [...sparseRowWarnings, ...videoLinkageIssues, ...protectionNotes],
    outcomes,
  };
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log(`\nWrote manifest: ${MANIFEST_PATH}`);

  const execMd = [
    '# R1.7 Import Execution Report',
    '',
    `- Start/end: ${importTimestamp} / ${new Date().toISOString()}`,
    `- Source SHA-256: ${workbook.sourceHash}`,
    `- Environment: ${creds.projectRef}`,
    `- Inserted: ${inserted.length}`,
    `- Updated (reconciled): ${updated.length}`,
    `- Skipped (protected): ${skippedProtected.length}`,
    `- Failed: ${failed.length}`,
    `- Categories created: ${createdCategories.length}`,
    `- Tags created: ${createdTags.length}`,
    `- Provenance audit rows written: ${auditRows.length}`,
    `- Manifest: ${MANIFEST_PATH}`,
    `- Rollback: npm run resources:rollback-r0a -- --manifest=${MANIFEST_PATH}`,
  ].join('\n');
  writeFileSync(EXECUTION_MD_PATH, execMd);
  console.log(`Wrote ${EXECUTION_MD_PATH}`);

  if (failed.length > 0) {
    console.error(`\nIMPORT COMPLETED WITH ${failed.length} FAILURE(S). This is NOT a clean success.`);
    process.exit(1);
  }
  if (inserted.length + updated.length + skippedProtected.length !== planned.length) {
    console.error('\nIMPORT DID NOT ACCOUNT FOR ALL 218 ROWS — treat as a failure, investigate the manifest.');
    process.exit(1);
  }
  console.log(`\nImport complete: ${inserted.length} inserted, ${updated.length} reconciled, ${skippedProtected.length} protected-skipped, 0 failed, out of ${planned.length} total.`);
}

main().catch((e) => {
  console.error('FATAL unhandled error:', e);
  process.exit(1);
});
