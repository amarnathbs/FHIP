/**
 * AIE-1.1 — deterministic classifier/parser registry (REG-01..12).
 *
 * REUSE NOTE. Discovery found several well-established PER-DOMAIN adapter
 * registries already (`lib/financial-data-hub/bank-csv/adapters/registry.ts`,
 * `bank-pdf/adapters/registry.ts`, `liability/adapters/registry.ts`,
 * `retirement/adapters/registry.ts`, `investment/adapters/registry.ts`) but
 * NO single generic "detect document type/institution/format" registry
 * spanning all document kinds — each is independently built per FDH
 * sub-domain, and none of them share a common interface. AIE-1.1 owns that
 * missing shared layer; the per-domain registries above are NOT replaced by
 * this (they stay a FUTURE adapter's own internal detail — e.g. AIE-1.3's
 * bank-statement adapter is expected to WRAP the existing bank-csv/bank-pdf
 * registries behind this generic interface, not discard them).
 */

import type { AieDeterministicOutcome, AieFieldCandidate, AieSourceModuleHint } from '../types';

export interface DeterministicParserResult {
  outcome: AieDeterministicOutcome;
  documentClass?: string;
  candidates: AieFieldCandidate[];
  /** Field names the parser could not extract but knows are legitimately
   * requestable from an AI fallback (REG-06: "declare required/optional
   * fields + AI-eligible gaps per parser/schema"). */
  aiEligibleGaps: string[];
  failureReason?: string;
}

export interface RegisteredParser {
  adapterId: string;
  version: string;
  moduleHint: AieSourceModuleHint;
  /**
   * REG-02: "deterministic sniffing using safe artifacts (not filename
   * alone)." Given already-extracted local text (never raw bytes — sniffing
   * happens after local text extraction in the pipeline), returns a
   * confidence-free boolean claim. Ambiguous multi-parser claims become a
   * classification-uncertainty unresolved item at the orchestrator level
   * (REG-03), never a silent pick.
   */
  sniff: (extractedText: string) => boolean;
  parse: (extractedText: string) => DeterministicParserResult;
}

class AieParserRegistry {
  private readonly parsers: RegisteredParser[] = [];

  register(parser: RegisteredParser): void {
    if (this.parsers.some((p) => p.adapterId === parser.adapterId && p.version === parser.version)) {
      throw new Error(`aie parser registry: ${parser.adapterId}@${parser.version} already registered`);
    }
    this.parsers.push(parser);
  }

  /** REG-03: priority/tie-break — an ambiguous claim (more than one parser
   * sniffing true) is reported as such rather than silently resolved by
   * array order. */
  sniffAll(extractedText: string): RegisteredParser[] {
    return this.parsers.filter((p) => p.sniff(extractedText));
  }

  list(): readonly RegisteredParser[] {
    return this.parsers;
  }
}

export const aieParserRegistry = new AieParserRegistry();

export type SniffOutcome =
  | { kind: 'none_matched' }
  | { kind: 'unambiguous'; parser: RegisteredParser }
  | { kind: 'ambiguous'; parsers: RegisteredParser[] };

export function sniffDocument(extractedText: string): SniffOutcome {
  const matches = aieParserRegistry.sniffAll(extractedText);
  if (matches.length === 0) return { kind: 'none_matched' };
  if (matches.length === 1) return { kind: 'unambiguous', parser: matches[0] };
  return { kind: 'ambiguous', parsers: matches };
}
