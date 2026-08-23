// Investment Intelligence R6-P1 — the single shared disclaimer for every
// tax-simulation surface. Enforced structurally: every exported orchestrator
// result in this module (`computeDisposalTax`, `aggregateTaxYear`, the
// exit-load calculator) attaches this constant rather than a docstring
// mention, matching the SIMULATION_DISCLAIMER precedent in
// `sip/sipOrchestrator.ts`. Any new API route or UI surface that renders a
// number from this engine MUST render `TAX_SIMULATION_DISCLAIMER` (or the
// `disclaimer` field the engine already attaches) verbatim next to it.
//
// Scope boundary (R6-P1 spec, "Explicit scope boundaries"): this engine
// never produces a filed-return-equivalent number, never performs e-filing,
// and is never a substitute for a Chartered Accountant / tax professional.

export const TAX_SIMULATION_DISCLAIMER =
  'This is an estimate for planning purposes only, not tax advice and not a filed-return figure. ' +
  'Indian capital-gains tax rules are complex and change with each Finance Act. ' +
  'Verify every number with a Chartered Accountant or tax professional before relying on it, ' +
  'and never file a return based solely on this simulation.';

/** Attached whenever the household/profile residency status is unknown or
 * flagged non-resident — this release only models resident-Indian rules. */
export const NRI_SCOPE_DISCLAIMER =
  'Resident-taxpayer estimate only — NRI-specific rules (differential TDS, DTAA/treaty ' +
  'considerations, Section 195) are not modelled in this release. If you are an NRI, ' +
  'this simulation does not apply to you — consult a tax professional.';

/** Structural mechanism, currently dormant: attaches whenever a rule
 * version's `ruleDefinition.placeholder` flag is true. As of the R6-FINAL
 * closure (2026-08-22) the 2025 Act row was certified against primary/
 * corroborated sources (see ruleVersions.ts + R6_TAX_LEGAL_SOURCE_REGISTER.md)
 * and no longer carries `placeholder: true` — so `placeholderRuleUsed` is
 * false for every disposal today. The flag/disclaimer plumbing is kept in
 * place (not deleted) so a future Finance Act amendment that genuinely
 * cannot be verified in time can be flagged the same way again without an
 * engine change — see Section 9 of the R6-FINAL spec ("RULE_NOT_CERTIFIED /
 * REVIEW_REQUIRED" pattern). */
export const PLACEHOLDER_RULE_DISCLAIMER =
  'PLACEHOLDER — pending final Income-tax Act, 2025 rules. This disposal falls on or after ' +
  '1 April 2026 when the 2025 Act is in force, but its specific rates/thresholds were not yet ' +
  'publicly finalised at the time this engine was built, so the pre-transition (1961 Act, as ' +
  'amended) structure is reused as a documented placeholder. Do not treat these numbers as ' +
  'authoritative for a 2025-Act-era disposal.';

export interface Disclaimed {
  disclaimer: string;
}

/** Attach the standard disclaimer (and, conditionally, the NRI/placeholder
 * riders) to any engine result object. */
export function withTaxDisclaimer<T extends object>(
  result: T,
  opts: { nriFlagged?: boolean; placeholderRuleUsed?: boolean } = {}
): T & Disclaimed & { residencyNote?: string; ruleVersionNote?: string } {
  return {
    ...result,
    disclaimer: TAX_SIMULATION_DISCLAIMER,
    ...(opts.nriFlagged ? { residencyNote: NRI_SCOPE_DISCLAIMER } : {}),
    ...(opts.placeholderRuleUsed ? { ruleVersionNote: PLACEHOLDER_RULE_DISCLAIMER } : {}),
  };
}
