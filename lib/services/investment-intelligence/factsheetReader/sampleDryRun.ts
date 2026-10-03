// "Dry run on a stored sample": run the extraction and change-detection on TEXT you already hold, with no network
// request and no database. PURE. This is how the reader's rules are exercised offline (unit tests and
// scripts/factsheet_reader_sample_dry_run.ts) against the synthetic fixtures in
// tests/fixtures/factsheet-benchmark-reader/, which mimic the benchmark sections of the four research funds.
//
// It reads and decides; it records nothing.

import type { CatalogueEntryLite } from '../benchmarkData/benchmarkNameMatcher';
import { decideObservation, type ExistingMapping, type ObservationDecision, type StoredVersion } from './decision';
import { extractWithPatterns } from './patternExtractor';
import { FACTSHEET_SOURCE_SEED, sourceFromSeed, type FactsheetSourceSeed } from './sourceRegistry';
import type { AiOutcome } from './aiExtractor';
import type { PatternOutcome } from './types';

/**
 * The verified catalogue entries named in bench1_phase2/catalogue_manifest.json (official names as seeded). The ids
 * are synthetic: this list exists for offline tests and the sample tool, never for a live decision.
 */
export const SAMPLE_CATALOGUE: readonly CatalogueEntryLite[] = [
  ['IN_NIFTY_100_TRI', 'NIFTY 100 TRI'],
  ['IN_BSE_100_TRI', 'BSE 100 TRI'],
  ['IN_NIFTY_500_TRI', 'Nifty 500 TRI'],
  ['IN_NIFTY_MIDCAP_150_TRI', 'Nifty Midcap 150 TRI'],
  ['IN_BSE_500_TRI', 'BSE 500 TRI'],
  ['IN_BSE_250_SMALLCAP_TRI', 'BSE 250 SmallCap TRI'],
  ['IN_NIFTY_LARGEMIDCAP_250_TRI', 'Nifty LargeMidcap 250 TRI'],
  ['IN_NIFTY_INFRASTRUCTURE_TRI', 'Nifty Infrastructure TRI'],
  ['IN_NIFTY_MNC_TRI', 'Nifty MNC TRI'],
  ['IN_NIFTY50_HYBRID_COMP_DEBT_5050_TRI', 'NIFTY 50 Hybrid Composite Debt 50:50 Index TRI'],
].map(([key, name]) => ({ benchmarkId: `sample-${key}`, benchmarkKey: key, officialName: name, returnVariant: 'total_return' as const, verified: true, active: true }));

export interface SampleDryRunInput {
  text: string;
  /** A registry source key from FACTSHEET_SOURCE_SEED (the scheme name and document type come from it). */
  sourceKey: string;
  catalogue?: readonly CatalogueEntryLite[];
  previous?: StoredVersion | null;
  existingMappings?: readonly ExistingMapping[];
  retrievedAt?: string;
  ai?: AiOutcome | null;
  instrumentId?: string;
  seeds?: readonly FactsheetSourceSeed[];
}

export interface SampleDryRunResult {
  pattern: PatternOutcome;
  decision: ObservationDecision;
  /** Plain lines for a human reading the tool's output. */
  summary: string[];
}

export function dryRunOnSample(input: SampleDryRunInput): SampleDryRunResult {
  const seed = (input.seeds ?? FACTSHEET_SOURCE_SEED).find((s) => s.sourceKey === input.sourceKey);
  if (!seed) throw new Error(`Unknown source key: ${input.sourceKey}`);
  const source = sourceFromSeed(seed, `sample-${seed.sourceKey}`);
  const pattern = extractWithPatterns({ text: input.text, schemeName: source.documentSchemeName, scope: source.documentScope });
  const decision = decideObservation({
    instrumentId: input.instrumentId ?? '00000000-0000-4000-8000-000000000001',
    source,
    sourceTitle: null,
    retrievedAt: input.retrievedAt ?? '2026-10-03T00:00:00.000Z',
    documentChecksum: 'sample-checksum',
    pattern,
    ai: input.ai ?? null,
    aiModel: null,
    catalogue: input.catalogue ?? SAMPLE_CATALOGUE,
    previous: input.previous ?? null,
    existingMappings: input.existingMappings ?? [],
  });
  const summary: string[] = [];
  if (pattern.status === 'found') {
    const e = pattern.extraction;
    summary.push(`Tier-1 benchmark: ${e.tier1?.raw}`);
    if (e.additional.length) summary.push(`Additional benchmark(s): ${e.additional.map((a) => a.raw).join('; ')}`);
    summary.push(`Effective date stated: ${e.effectiveFromStated ? e.effectiveFromStated.iso : 'none'}`);
    summary.push(`Document date: ${e.documentDate ? `${e.documentDate.iso} (${e.documentDate.precision})` : 'not found'}`);
  } else {
    summary.push(`Pattern pass: ${pattern.status} (${pattern.reason})`);
  }
  summary.push(`Decision: ${decision.action} / ${decision.outcome}${'reviewRequired' in decision ? (decision.reviewRequired ? ' (review queue)' : '') : ''}`);
  if (decision.action === 'new_version') summary.push(`Recorded as: ${decision.version.benchmarkKind}, catalogue state ${decision.version.catalogueState}, effective from ${decision.version.effectiveFrom} (${decision.version.effectiveFromBasis})`);
  return { pattern, decision, summary };
}
