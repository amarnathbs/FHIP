// R1.7 — readiness classification (spec §63). Recorded in the manifest and
// report only — never written as a resource_posts.status value.

export type ReadinessBucket =
  | 'READY_METADATA'
  | 'NEEDS_BODY'
  | 'NEEDS_AUTHOR'
  | 'NEEDS_VIDEO'
  | 'NEEDS_TAXONOMY_RESOLUTION'
  | 'NEEDS_CONTEXT_REVIEW'
  | 'NEEDS_CTA_REVIEW';

export function classifyReadiness(params: {
  contentType: string;
  hasUnresolvedTaxonomy: boolean;
  ctaResolved: boolean;
}): ReadinessBucket[] {
  const buckets: ReadinessBucket[] = ['READY_METADATA'];
  if (params.contentType !== 'video') buckets.push('NEEDS_BODY');
  if (params.contentType === 'video') buckets.push('NEEDS_VIDEO');
  buckets.push('NEEDS_AUTHOR'); // no author resolvable in this import for any row (spec §40 — see report)
  if (params.hasUnresolvedTaxonomy) buckets.push('NEEDS_TAXONOMY_RESOLUTION');
  buckets.push('NEEDS_CONTEXT_REVIEW'); // workbook has no mappable context_key hints at all (see report)
  if (!params.ctaResolved) buckets.push('NEEDS_CTA_REVIEW');
  return buckets;
}
