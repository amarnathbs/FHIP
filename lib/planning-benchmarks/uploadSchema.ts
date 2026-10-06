// Planning Benchmarks staged upload - THE single schema definition (F5).
//
// Everything that describes an upload file lives here and nowhere else: the three upload kinds, their
// columns (name, required, type, closed enum, plain-language description), the template version markers,
// the example rows and the limits. The CSV template, the XLSX template, the template "Read me" sheet, the
// parser/validator and the screen's help text are all GENERATED from this one object, so they cannot
// drift apart (a unit test proves it).
//
// Pure module: no database, no network, no clock.
//
// Dates inside a FILE are asked for day first (dd/mm/yyyy); the database order (year first, dashes) and a real
// Excel date cell are also accepted by the validator. Every piece of text a person reads is day-first.

export const UPLOAD_KINDS = ['values', 'target_ranges', 'cohorts'] as const;
export type UploadKind = (typeof UPLOAD_KINDS)[number];

export function isUploadKind(v: unknown): v is UploadKind {
  return typeof v === 'string' && (UPLOAD_KINDS as readonly string[]).includes(v);
}

/** The version marker. It is the value of the first column, `template_version`, on EVERY data row. */
export const TEMPLATE_VERSION: Record<UploadKind, string> = Object.freeze({
  values: 'FHIP-PB-VALUES-1',
  target_ranges: 'FHIP-PB-RANGES-1',
  cohorts: 'FHIP-PB-COHORTS-1',
});

export const KIND_LABEL: Record<UploadKind, string> = Object.freeze({
  values: 'Observed values',
  target_ranges: 'Planning target ranges',
  cohorts: 'Cohorts',
});

export const KIND_PURPOSE: Record<UploadKind, string> = Object.freeze({
  values:
    'Measured figures (a median, a mean, a threshold or a rate) for one dataset. A figure that is already live for the same metric, cohort and statistic is replaced only if the number differs; the old figure is kept as history.',
  target_ranges:
    'Planning bands (for example critical, healthy, strong) for a metric. Bands for the same metric, country, life stage and household type are replaced as a set.',
  cohorts:
    'Population groups that values refer to. New cohorts are added; a cohort that already exists with different details is refused (cohorts cannot be edited here).',
});

// Closed enumerations. These mirror the database CHECK constraints of migration 0011 and are enforced a
// second time inside the database.
export const STATISTIC_TYPES = ['mean', 'median', 'p10', 'p20', 'p25', 'p50', 'p75', 'p80', 'p90', 'target_min', 'target_max', 'threshold', 'rate', 'share'] as const;
export const UNITS = ['currency', 'percentage', 'months', 'ratio', 'count', 'years', 'days'] as const;
export const DIRECTIONS = ['higher_better', 'lower_better', 'target_range'] as const;
export const EVIDENCE_LEVELS = ['official_statistical', 'regulatory', 'research_informed', 'platform_derived'] as const;
export const URBAN_RURAL = ['urban', 'rural', 'metro', 'regional'] as const;

export type ColumnType = 'text' | 'code' | 'integer' | 'number' | 'boolean' | 'date' | 'enum' | 'country';

export interface ColumnDef {
  name: string;
  required: boolean;
  type: ColumnType;
  enumValues?: readonly string[];
  /** Plain-language description (shown in the Read me sheet and on the screen). Day-first, no year-first examples. */
  description: string;
  maxLength?: number;
  min?: number;
  max?: number;
}

const marker = (kind: UploadKind): ColumnDef => ({
  name: 'template_version',
  required: true,
  type: 'text',
  description: `The version marker of this template. It must be exactly ${TEMPLATE_VERSION[kind]} on every row. Do not change it: a file from a different template generation is refused.`,
  maxLength: 40,
});

const PROVENANCE_DESCRIPTION = {
  source_release: 'The publisher release the figure comes from, as published (title and edition).',
  observation_period_start: 'First day of the period the figure describes. A date (see the date rule).',
  observation_period_end: 'Last day of the period the figure describes. Leave blank for an open-ended rule.',
  source_file: 'The file or page you took the figure from.',
  source_locator: 'Where in that file: table, sheet and cell, or page.',
  retrieval_date: 'The day you downloaded or read the source. A date, not in the future.',
} as const;

export const UPLOAD_SCHEMA: Record<UploadKind, { columns: ColumnDef[]; examples: Record<string, string>[] }> = {
  values: {
    columns: [
      marker('values'),
      { name: 'dataset_name', required: true, type: 'text', maxLength: 200, description: 'Name of an existing dataset, exactly as shown on the Datasets tab. One file targets one dataset.' },
      { name: 'dataset_version', required: true, type: 'text', maxLength: 40, description: 'Version of that dataset, exactly as shown on the Datasets tab.' },
      { name: 'cohort_code', required: false, type: 'code', maxLength: 64, description: 'Code of an existing cohort, or blank for a country-wide figure.' },
      { name: 'metric_code', required: true, type: 'code', maxLength: 80, description: 'Code of one of the registered metrics. New metrics cannot be created by an upload.' },
      { name: 'statistic_type', required: true, type: 'enum', enumValues: STATISTIC_TYPES, description: 'Which statistic the number is. A closed list.' },
      { name: 'value_numeric', required: true, type: 'number', description: 'The figure. Plain digits with a decimal point, at most 4 decimals, no thousands separators and no percent sign. Percentages are percentage points (56.2, not 0.562).' },
      { name: 'unit', required: true, type: 'enum', enumValues: UNITS, description: 'Must equal the unit the metric is defined in. A closed list.' },
      { name: 'original_currency', required: false, type: 'code', maxLength: 3, description: 'Three-letter currency (AUD, INR). Required when the unit is currency; must be blank otherwise.' },
      { name: 'base_date', required: false, type: 'date', description: 'The as-at or reference date of the figure. A date, not in the future.' },
      { name: 'effective_from', required: false, type: 'date', description: 'The day the figure starts to apply. A date, not in the future. Blank means the day it is activated.' },
      { name: 'is_derived', required: true, type: 'boolean', description: 'true when FHIP calculated the figure from published numbers, false when it is published as is.' },
      { name: 'derivation_method', required: false, type: 'text', maxLength: 1000, description: 'How a derived figure was calculated. Required when is_derived is true.' },
      { name: 'confidence_score', required: false, type: 'number', min: 0, max: 100, description: 'Optional confidence from 0 to 100.' },
      { name: 'source_release', required: true, type: 'text', maxLength: 200, description: PROVENANCE_DESCRIPTION.source_release },
      { name: 'observation_period_start', required: true, type: 'date', description: PROVENANCE_DESCRIPTION.observation_period_start },
      { name: 'observation_period_end', required: false, type: 'date', description: PROVENANCE_DESCRIPTION.observation_period_end },
      { name: 'source_file', required: true, type: 'text', maxLength: 200, description: PROVENANCE_DESCRIPTION.source_file },
      { name: 'source_locator', required: true, type: 'text', maxLength: 300, description: PROVENANCE_DESCRIPTION.source_locator },
      { name: 'retrieval_date', required: true, type: 'date', description: PROVENANCE_DESCRIPTION.retrieval_date },
    ],
    examples: [
      {
        template_version: TEMPLATE_VERSION.values,
        dataset_name: 'EXAMPLE DATASET - REPLACE ME',
        dataset_version: '1.0',
        cohort_code: '',
        metric_code: 'EXAMPLE_METRIC_REPLACE_ME',
        statistic_type: 'median',
        value_numeric: '100.5',
        unit: 'percentage',
        original_currency: '',
        base_date: '30/06/2020',
        effective_from: '',
        is_derived: 'false',
        derivation_method: '',
        confidence_score: '',
        source_release: 'Example release title',
        observation_period_start: '01/07/2019',
        observation_period_end: '30/06/2020',
        source_file: 'example.xlsx',
        source_locator: 'Table 1, cell B2',
        retrieval_date: '01/10/2026',
      },
      {
        template_version: TEMPLATE_VERSION.values,
        dataset_name: 'EXAMPLE DATASET - REPLACE ME',
        dataset_version: '1.0',
        cohort_code: 'EXAMPLE_COHORT_REPLACE_ME',
        metric_code: 'EXAMPLE_METRIC_REPLACE_ME',
        statistic_type: 'mean',
        value_numeric: '250000',
        unit: 'currency',
        original_currency: 'AUD',
        base_date: '',
        effective_from: '',
        is_derived: 'true',
        derivation_method: 'Example: published total divided by published count',
        confidence_score: '80',
        source_release: 'Example release title',
        observation_period_start: '01/07/2019',
        observation_period_end: '',
        source_file: 'example.xlsx',
        source_locator: 'Table 2, cell C3',
        retrieval_date: '01/10/2026',
      },
    ],
  },
  target_ranges: {
    columns: [
      marker('target_ranges'),
      { name: 'dataset_name', required: true, type: 'text', maxLength: 200, description: 'Name of the existing dataset these bands belong to (its source must match the source_name column).' },
      { name: 'dataset_version', required: true, type: 'text', maxLength: 40, description: 'Version of that dataset.' },
      { name: 'metric_code', required: true, type: 'code', maxLength: 80, description: 'Code of one of the registered metrics.' },
      { name: 'source_name', required: true, type: 'text', maxLength: 100, description: 'Name of the source the bands are cited from, as shown on the Sources tab. It must be the source of the dataset.' },
      { name: 'country_code', required: false, type: 'country', maxLength: 2, description: 'Two-letter country (AU, IN), or blank for all countries.' },
      { name: 'life_stage', required: false, type: 'text', maxLength: 60, description: 'Life stage the band applies to, or blank for all.' },
      { name: 'household_type', required: false, type: 'text', maxLength: 60, description: 'Household type the band applies to, or blank for all.' },
      { name: 'band_label', required: true, type: 'text', maxLength: 60, description: 'Wording shown for the band (for example critical, healthy, strong).' },
      { name: 'band_tier', required: true, type: 'integer', min: 1, max: 4, description: 'Whole number 1 to 4: 1 is the weakest band, 4 the strongest.' },
      { name: 'lower_bound', required: false, type: 'number', description: 'Lower edge of the band. Blank when the band has no lower edge. At most 4 decimals.' },
      { name: 'upper_bound', required: false, type: 'number', description: 'Upper edge of the band. Blank when the band has no upper edge. At most 4 decimals.' },
      { name: 'direction', required: true, type: 'enum', enumValues: DIRECTIONS, description: 'Whether higher is better, lower is better, or the band is a target range. A closed list.' },
      { name: 'explanation', required: false, type: 'text', maxLength: 2000, description: 'Plain-language explanation shown with the band.' },
      { name: 'evidence_level', required: true, type: 'enum', enumValues: EVIDENCE_LEVELS, description: 'How strong the evidence behind the band is. A closed list.' },
      { name: 'model_version', required: true, type: 'text', maxLength: 60, description: 'Label of the model or release the bands come from.' },
      { name: 'effective_from', required: false, type: 'date', description: 'The day the bands start to apply. A date, not in the future. Blank means the day they are activated.' },
      { name: 'source_release', required: true, type: 'text', maxLength: 200, description: PROVENANCE_DESCRIPTION.source_release },
      { name: 'observation_period_start', required: true, type: 'date', description: PROVENANCE_DESCRIPTION.observation_period_start },
      { name: 'observation_period_end', required: false, type: 'date', description: PROVENANCE_DESCRIPTION.observation_period_end },
      { name: 'source_file', required: true, type: 'text', maxLength: 200, description: PROVENANCE_DESCRIPTION.source_file },
      { name: 'source_locator', required: true, type: 'text', maxLength: 300, description: PROVENANCE_DESCRIPTION.source_locator },
      { name: 'retrieval_date', required: true, type: 'date', description: PROVENANCE_DESCRIPTION.retrieval_date },
    ],
    examples: [
      {
        template_version: TEMPLATE_VERSION.target_ranges,
        dataset_name: 'EXAMPLE DATASET - REPLACE ME',
        dataset_version: '1.0',
        metric_code: 'EXAMPLE_METRIC_REPLACE_ME',
        source_name: 'EXAMPLE_SOURCE_REPLACE_ME',
        country_code: 'AU',
        life_stage: '',
        household_type: 'single',
        band_label: 'modest',
        band_tier: '2',
        lower_bound: '0',
        upper_bound: '110000',
        direction: 'target_range',
        explanation: 'Example explanation',
        evidence_level: 'official_statistical',
        model_version: 'example-1',
        effective_from: '',
        source_release: 'Example release title',
        observation_period_start: '01/02/2026',
        observation_period_end: '',
        source_file: 'example.pdf',
        source_locator: 'Page 3',
        retrieval_date: '01/10/2026',
      },
      {
        template_version: TEMPLATE_VERSION.target_ranges,
        dataset_name: 'EXAMPLE DATASET - REPLACE ME',
        dataset_version: '1.0',
        metric_code: 'EXAMPLE_METRIC_REPLACE_ME',
        source_name: 'EXAMPLE_SOURCE_REPLACE_ME',
        country_code: 'AU',
        life_stage: '',
        household_type: 'single',
        band_label: 'comfortable',
        band_tier: '4',
        lower_bound: '630000',
        upper_bound: '',
        direction: 'target_range',
        explanation: 'Example explanation',
        evidence_level: 'official_statistical',
        model_version: 'example-1',
        effective_from: '',
        source_release: 'Example release title',
        observation_period_start: '01/02/2026',
        observation_period_end: '',
        source_file: 'example.pdf',
        source_locator: 'Page 3',
        retrieval_date: '01/10/2026',
      },
    ],
  },
  cohorts: {
    columns: [
      marker('cohorts'),
      { name: 'dataset_name', required: true, type: 'text', maxLength: 200, description: 'Name of the existing dataset the cohorts belong to.' },
      { name: 'dataset_version', required: true, type: 'text', maxLength: 40, description: 'Version of that dataset.' },
      { name: 'cohort_code', required: true, type: 'code', maxLength: 64, description: 'Unique cohort code: letters, digits and underscores.' },
      { name: 'country_code', required: false, type: 'country', maxLength: 2, description: 'Two-letter country (AU, IN).' },
      { name: 'region_code', required: false, type: 'text', maxLength: 60, description: 'Region, state or territory.' },
      { name: 'urban_rural', required: false, type: 'enum', enumValues: URBAN_RURAL, description: 'urban, rural, metro or regional. A closed list.' },
      { name: 'age_band', required: false, type: 'text', maxLength: 60, description: 'Age band code, for example the code the Twin matches against.' },
      { name: 'income_band', required: false, type: 'text', maxLength: 60, description: 'Income band code.' },
      { name: 'household_type', required: false, type: 'text', maxLength: 60, description: 'Household type code.' },
      { name: 'life_stage', required: false, type: 'text', maxLength: 60, description: 'Life stage code.' },
      { name: 'housing_tenure', required: false, type: 'text', maxLength: 60, description: 'Housing tenure code.' },
      { name: 'employment_type', required: false, type: 'text', maxLength: 60, description: 'Employment type code.' },
      { name: 'dependant_band', required: false, type: 'text', maxLength: 60, description: 'Dependant band code.' },
      { name: 'financial_dna_code', required: false, type: 'text', maxLength: 60, description: 'Financial DNA code.' },
      { name: 'cross_border_flag', required: false, type: 'boolean', description: 'true or false. Blank means false.' },
      { name: 'cohort_tier', required: true, type: 'integer', min: 1, max: 5, description: 'Whole number 1 to 5: how specific the cohort is.' },
      { name: 'sample_size', required: false, type: 'integer', min: 0, description: 'Number of observations behind the cohort, if published.' },
      { name: 'cohort_description', required: true, type: 'text', maxLength: 500, description: 'Plain-language description of the group.' },
      { name: 'source_release', required: true, type: 'text', maxLength: 200, description: PROVENANCE_DESCRIPTION.source_release },
      { name: 'source_file', required: true, type: 'text', maxLength: 200, description: PROVENANCE_DESCRIPTION.source_file },
      { name: 'source_locator', required: true, type: 'text', maxLength: 300, description: PROVENANCE_DESCRIPTION.source_locator },
    ],
    examples: [
      {
        template_version: TEMPLATE_VERSION.cohorts,
        dataset_name: 'EXAMPLE DATASET - REPLACE ME',
        dataset_version: '1.0',
        cohort_code: 'EXAMPLE_COHORT_REPLACE_ME',
        country_code: 'AU',
        region_code: '',
        urban_rural: '',
        age_band: 'AGE_25_34',
        income_band: '',
        household_type: '',
        life_stage: '',
        housing_tenure: '',
        employment_type: '',
        dependant_band: '',
        financial_dna_code: '',
        cross_border_flag: 'false',
        cohort_tier: '4',
        sample_size: '',
        cohort_description: 'Example households with a reference person aged 25 to 34',
        source_release: 'Example release title',
        source_file: 'example.xlsx',
        source_locator: 'Table 10, row 9',
      },
    ],
  },
};

export function columnNames(kind: UploadKind): string[] {
  return UPLOAD_SCHEMA[kind].columns.map((c) => c.name);
}

export const UPLOAD_LIMITS = Object.freeze({
  /** Same ceiling as the Market Index upload (5 MB). */
  maxBytes: 5 * 1024 * 1024,
  /** The largest registered dataset is 198 values or 196 bands; 5,000 leaves generous room. */
  maxRows: 5000,
  /** At most this many issues are returned to the screen (the full count is always reported). */
  maxIssuesReturned: 200,
});

/** Where the data goes in the XLSX template. The operator still picks the sheet explicitly on upload. */
export const XLSX_DATA_SHEET = 'Data';
export const XLSX_README_SHEET = 'Read me';

/** The plain-language rules shown next to the template downloads and in the Read me sheet. No year-first example. */
export const UPLOAD_RULES: string[] = [
  'Row 1 is the header row. Do not rename, reorder or delete columns, and do not add columns.',
  'One file loads one dataset, and one kind of data (observed values, planning target ranges or cohorts).',
  'Keep the template_version column exactly as given on every row.',
  'Dates: write them day first, as 30/06/2020 (day, month, then a four-digit year, joined by slashes or dashes). A real Excel date cell is accepted. The database order year first with dashes is still accepted in a file, but month-first dates and two-digit years are refused.',
  'Numbers: plain digits with a decimal point and at most 4 decimals. No thousands separators, no currency symbols, no percent signs. Percentages are percentage points (56.2, not 0.562).',
  'The unit must be the unit the metric is defined in. If it is not, the row is refused.',
  'Excel files: the data must be on a sheet you choose explicitly when you upload. Cells must hold values, not formulas. Hidden sheets and hidden rows are listed and are not processed unless you say so.',
  'Maximum 5 MB and 5,000 data rows per file. Files are checked, then staged. Nothing is live until an authorised administrator activates the staged upload.',
];
