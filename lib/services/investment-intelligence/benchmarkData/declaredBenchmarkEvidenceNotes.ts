// What the repository's OWN evidence says each held scheme's document declares as its benchmark, used ONLY to
// FLAG a held scheme whose declared benchmark differs from the category benchmark that would apply. It creates
// no mapping, no proposal and no figure; the admin still has to enter the declared benchmark.
//
// Source: docs/investment-intelligence/bench1_phase2/scheme_benchmark_matrix.csv (the 1 October 2026 matrix,
// built from each scheme's own SID / KIM / factsheet; per-scheme evidence is in bench1_phase2/mapping_evidence/).
// Generated from that file, nothing fetched. 'factsheet_only' rows rest on a factsheet or AMC page, not an SID.
// Names are copied as the matrix records them (some are truncated there).

export interface DeclaredBenchmarkEvidenceNote {
  amfiSchemeCode: string;
  declaredName: string;
  evidenceStatus: string;
}

export const DECLARED_BENCHMARK_EVIDENCE_REF = 'bench1_phase2/scheme_benchmark_matrix.csv (1 Oct 2026)';

export const DECLARED_BENCHMARK_EVIDENCE_NOTES: readonly DeclaredBenchmarkEvidenceNote[] = [
  { amfiSchemeCode: '103174', declaredName: 'NIFTY 100 TRI', evidenceStatus: 'verified_scheme_document' },
  { amfiSchemeCode: '112277', declaredName: 'BSE 100 TRI', evidenceStatus: 'verified_scheme_document' },
  { amfiSchemeCode: '100520', declaredName: 'Nifty 500 (shown under \'Benchmark (Total Return Index)\'; Tier I)', evidenceStatus: 'verified_scheme_document' },
  { amfiSchemeCode: '100473', declaredName: 'Nifty Midcap 150 (shown under \'Benchmark (Total Return Index)\')', evidenceStatus: 'verified_scheme_document' },
  { amfiSchemeCode: '100119', declaredName: 'NIFTY 50 Hybrid Composite Debt 50:50 Index (TRI)', evidenceStatus: 'verified_scheme_document' },
  { amfiSchemeCode: '118955', declaredName: 'NIFTY 500 Index (TRI)', evidenceStatus: 'verified_scheme_document' },
  { amfiSchemeCode: '101762', declaredName: 'NIFTY 500 Index (TRI)', evidenceStatus: 'verified_scheme_document' },
  { amfiSchemeCode: '115934', declaredName: 'Domestic price of physical gold', evidenceStatus: 'verified_scheme_document' },
  { amfiSchemeCode: '119018', declaredName: 'NIFTY 100 Total Returns Index (TRI)', evidenceStatus: 'verified_scheme_document' },
  { amfiSchemeCode: '102000', declaredName: 'NIFTY 100 Total Returns Index (TRI)', evidenceStatus: 'verified_scheme_document' },
  { amfiSchemeCode: '105758', declaredName: 'NIFTY MIDCAP 150 (TRI)', evidenceStatus: 'verified_scheme_document' },
  { amfiSchemeCode: '130502', declaredName: 'BSE 250 SmallCap Index (TRI)', evidenceStatus: 'verified_scheme_document' },
  { amfiSchemeCode: '129310', declaredName: 'Nifty 500 TRI', evidenceStatus: 'factsheet_only' },
  { amfiSchemeCode: '104908', declaredName: 'NIFTY Midcap 150 TRI (Tier 1)', evidenceStatus: 'factsheet_only' },
  { amfiSchemeCode: '118834', declaredName: 'Nifty Large Midcap 250 Index (TRI)', evidenceStatus: 'verified_scheme_document' },
  { amfiSchemeCode: '101262', declaredName: 'Nifty Infrastructure TRI', evidenceStatus: 'verified_scheme_document' },
  { amfiSchemeCode: '122639', declaredName: 'Nifty 500 TRI (AMFI Tier I)', evidenceStatus: 'verified_scheme_document' },
  { amfiSchemeCode: '102414', declaredName: 'BSE 500 TRI Index (AMFI Tier I; \'S&P BSE 500 TRI Index\' in the Apr-2023 SID)', evidenceStatus: 'verified_scheme_document' },
  { amfiSchemeCode: '103504', declaredName: 'BSE 100 TRI (AMFI Tier I; \'S&P BSE 100 TRI\' in older docs)', evidenceStatus: 'verified_scheme_document' },
  { amfiSchemeCode: '103408', declaredName: '45% BSE 500 TRI + 40% CRISIL Composite Bond Fund Index + 10% Domestic prices of Gold + 5% Domestic prices of silver', evidenceStatus: 'verified_scheme_document' },
  { amfiSchemeCode: '100740', declaredName: 'Nifty MNC TRI', evidenceStatus: 'factsheet_only' },
];
