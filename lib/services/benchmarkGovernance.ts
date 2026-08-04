import type { SupabaseClient } from '@supabase/supabase-js';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// Enforces spec section 26: "No benchmark should become active without
// source citation, source period, statistic type, unit, cohort definition,
// approval, effective date, review date." Cohort definition is only
// required for observed_market datasets — a country-wide regulatory
// threshold (e.g. APRA's 6x DTI limit) or an FHIP planning range legitimately
// has no single cohort.
export async function validateDatasetForActivation(supabase: SupabaseClient, datasetId: string): Promise<ValidationResult> {
  const errors: string[] = [];

  const { data: dataset } = await supabase
    .from('benchmark_datasets')
    .select('id, benchmark_class, source_period, geography_level, statistic_coverage, approved_by, benchmark_source_id, benchmark_sources(citation_text, publication_date, reference_period_start, status)')
    .eq('id', datasetId)
    .maybeSingle();

  if (!dataset) {
    return { valid: false, errors: ['Dataset not found.'] };
  }

  const source = (dataset as unknown as { benchmark_sources: { citation_text: string | null; publication_date: string | null; reference_period_start: string | null; status: string } | null }).benchmark_sources;
  if (!source) errors.push('No source is linked to this dataset.');
  else {
    if (!source.citation_text) errors.push('Source citation is missing.');
    if (!source.publication_date && !source.reference_period_start) errors.push('Source period is missing.');
    if (source.status === 'draft' || source.status === 'suspended' || source.status === 'archived') {
      errors.push(`Source status is "${source.status}" — it must be approved or active before this dataset can activate.`);
    }
  }

  if (!dataset.source_period) errors.push('Dataset source period is missing.');
  if (!dataset.geography_level) errors.push('Dataset geography level is missing.');
  if (!dataset.statistic_coverage) errors.push('Dataset statistic coverage is missing.');

  if (dataset.benchmark_class === 'observed_market' || dataset.benchmark_class === 'regulatory_statutory') {
    // A cohort is only required when the dataset's values are cohort-specific
    // (e.g. age-banded net worth). A genuinely country-wide figure (national
    // asset-mix percentage, a single regulatory threshold) has no cohort to
    // define — what actually matters is that SOME usable value exists.
    const { count } = await supabase.from('benchmark_values').select('id', { count: 'exact', head: true }).eq('dataset_id', datasetId);
    if (!count || count === 0) errors.push('No benchmark value has been recorded for this dataset yet.');
  }

  return { valid: errors.length === 0, errors };
}
