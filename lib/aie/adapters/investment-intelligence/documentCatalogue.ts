/**
 * AIE-1.2 — the honest, initial certified document catalogue (mandatory
 * execution sequence step 4: "freeze an honest initial certified document
 * catalogue based on what this codebase can ALREADY deterministically
 * parse today ... do not claim broker/platform support you have not built
 * and tested against real fixture corpora").
 *
 * This is deliberately a STATIC, hand-maintained list, not a computed one —
 * `PARSER_REGISTRY` (lib/services/investment-intelligence/parsers/registry.ts)
 * already enumerates the real registered parsers; this file exists to state,
 * in one place, which of them this AIE-1.2 pass actually re-verified end to
 * end THROUGH the AIE gateway (not just "a parser object technically
 * exists"), and to name everything else as explicitly deferred rather than
 * silently implying broader support by omission.
 */

export type IiAdapterCertificationStatus = 'certified' | 'deferred';

export interface IiAdapterDocumentClassEntry {
  /** Matches `InvestmentDocumentParser.parserCode` / `ii_sources.source_key` where one exists. */
  parserCode: string | null;
  sourceKey: string | null;
  label: string;
  status: IiAdapterCertificationStatus;
  /** Why this status was chosen — cited evidence, not a claim. */
  rationale: string;
}

/**
 * CERTIFIED here means: a real `InvestmentDocumentParser` already exists in
 * this codebase (lib/services/investment-intelligence/parsers/registry.ts's
 * `PARSER_REGISTRY`), has its own real, previously-certified fixture-backed
 * test suite (memory: Investment Intelligence R2 "FULL PASS", II-FS1
 * "UNCONDITIONAL FULL PASS"), and this pass additionally wraps it as a
 * registered AIE classifier/parser (see `parserAdapter.ts`) and exercises it
 * through the real AIE orchestrator with new fixtures (see
 * `tests/unit/aieIiAdapter*.test.ts`). It does NOT mean AIE-1.6 production
 * certification — that is explicitly out of this phase's authority.
 */
export const IiAdapterDocumentCatalogue: IiAdapterDocumentClassEntry[] = [
  {
    parserCode: 'cams_detailed_v1',
    sourceKey: 'cams',
    label: 'CAMS Consolidated Account Statement (CAS)',
    status: 'certified',
    rationale:
      'Real deterministic parser (camsParser.ts) with its own certified fixture suite (Investment Intelligence R2/R6/FS1 passes, project memory). Wrapped as an AIE RegisteredParser this pass and exercised end-to-end through the real AIE orchestrator (tests/unit/aieIiAdapterParser.test.ts).',
  },
  {
    parserCode: 'kfintech_detailed_v1',
    sourceKey: 'kfintech',
    label: 'KFintech Consolidated Account Statement (CAS)',
    status: 'certified',
    rationale:
      'Real deterministic parser (kfintechParser.ts), same registry and detection mechanism as CAMS above, same AIE wrapping and orchestrator exercise.',
  },
  {
    parserCode: 'cams_folio_details_v1',
    sourceKey: 'cams',
    label: 'CAMS Individual Folio Details statement (II-FS1)',
    status: 'certified',
    rationale:
      'Real deterministic parser (camsFolioStatementParser.ts), certified FULL PASS as II-FS1 (project memory, terminal). Wrapped identically — this parser is registered in the same PARSER_REGISTRY and reached through the same `detectSource`/`parseDocumentWithParser` path the AIE wrapper calls.',
  },
  // --- Explicitly deferred. Not a promise, not attempted this pass. -------
  {
    parserCode: null,
    sourceKey: null,
    label: 'Broker/demat contract notes and holding statements (e.g. Zerodha, ICICI Direct, CDSL/NSDL demat statements)',
    status: 'deferred',
    rationale:
      'No InvestmentDocumentParser exists for any brokerage-specific layout in this codebase today. Building one without a real, redaction-safe fixture corpus from an actual broker would be exactly the "claiming certification for an unsupported broker based on one lucky example" this phase\'s own prohibitions forbid.',
  },
  {
    parserCode: null,
    sourceKey: null,
    label: 'Non-Indian brokerage/investment platform statements (AU/other jurisdictions)',
    status: 'deferred',
    rationale:
      'Every registered II parser targets the Indian RTA (CAMS/KFintech) mutual-fund CAS format specifically. No AU or other-jurisdiction investment statement parser exists in this codebase.',
  },
  {
    parserCode: null,
    sourceKey: null,
    label: 'PMS (Portfolio Management Service) / NPS statements',
    status: 'deferred',
    rationale: 'No registered parser targets either format; not attempted this pass.',
  },
];

export function isDocumentClassCertified(parserCode: string): boolean {
  return IiAdapterDocumentCatalogue.some((e) => e.parserCode === parserCode && e.status === 'certified');
}
