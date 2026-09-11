/**
 * AIE-1.4 — Insurance adapter: the honest, initial certified document
 * catalogue (mandatory execution sequence step 3/eligibility gate:
 * "freeze IMPLEMENT_NOW scope" + AIE14-INS-01: "Classify policy schedule,
 * renewal notice, premium notice, product disclosure and claim document
 * separately").
 *
 * ELIGIBILITY CONTEXT (see docs/aie-programme/AIE_1_4_IMPLEMENTATION.md for
 * the full scorecard across all nine AIE-1.4 candidate document classes).
 * Insurance was the ONE class picked IMPLEMENT_NOW this pass because:
 *   - it already has a real, mature, RLS-protected canonical table
 *     (`insurance_policies`, migrations 0003/0004/0008) and an already-live
 *     write service (`makeRegistry('insurance_policies')`,
 *     lib/services/registry.ts) reached today only via manual entry
 *     (app/api/insurance/route.ts) — i.e. a real canonical destination with
 *     NO existing PDF ingestion path, exactly the gap AIE-1.4 exists to
 *     fill.
 *   - unlike payslip/income (FDH-9, already merged to main with its own
 *     mature deterministic parser+reconciliation+privacy pipeline under
 *     lib/financial-data-hub/payslip/**), loans/liabilities (FDH-10, see
 *     lib/financial-data-hub/liability/adapters/**) and retirement/SMSF
 *     (FDH-12, per project memory still DEV-only with a hard stop before
 *     merge/production — see lib/financial-data-hub/retirement/**),
 *     Insurance has NO competing/duplicate ingestion pipeline already built
 *     elsewhere in this repository — building an AIE adapter here does not
 *     risk the "second parser/exception system" this phase's own
 *     prohibitions forbid.
 *
 * BOUNDED SCOPE, NOT A FALSE PROMISE. `insurance_policies`'s real schema
 * (lib/validation/insurance.ts) is a SINGLE flat row per policy: it has NO
 * column for a masked policy number, no distinct policy-owner/insured-
 * person/beneficiary role columns (its own `owner` column is a HOUSEHOLD
 * ROLE enum — self/spouse/joint/child/family_trust/company/smsf/other — not
 * a legal insured/beneficiary name), no excess column, and no structured
 * exclusions/endorsements or multi-coverage-component breakdown. AIE14-
 * INS-03/06/07/08/09 (distinct owner/insured/beneficiary roles, excess,
 * exclusions-as-structured-text, multi-component handling+reconciliation)
 * are therefore DESIGN_ONLY this pass: the parser below extracts what
 * EVIDENCE it can for these (masked policy number, owner/insured/
 * beneficiary NAME strings, exclusions free text) as AIE field candidates
 * for display/audit ONLY — none of it is written to the canonical table,
 * because no column exists to hold it, and this pass has no authority to
 * add one to the ALREADY-LIVE `insurance_policies` table. A future pass
 * that gets Product Owner sign-off to extend the schema is expected to
 * widen `ALLOWED_AI_COMPLETABLE_FIELDS` / the canonical write mapping
 * in `write.ts`, not invent a second table.
 */

export type InsuranceAdapterCertificationStatus = 'certified' | 'deferred';

export interface InsuranceDocumentClassEntry {
  /** Matches the `documentSubClass` field candidate parser.ts emits. */
  subClass: string;
  label: string;
  status: InsuranceAdapterCertificationStatus;
  /** Why this status was chosen — cited evidence, not a claim. */
  rationale: string;
}

/**
 * CERTIFIED here means: this pass's parser (parser.ts) deterministically
 * extracts and this adapter's reconciliation rule (reconciliation.ts)
 * evaluates the class end-to-end through the real AIE orchestrator, proven
 * by a synthetic fixture corpus (tests/support/buildAieInsuranceFixtureText.ts)
 * and real tests (tests/unit/aieInsuranceAdapter*.test.ts). It does NOT mean
 * AIE-1.6 production certification, and it does NOT mean any real insurer's
 * exact layout was tested — see this file's own header on the "bounded
 * generic structure" decision (ELIG-05) parser.ts documents.
 */
export const InsuranceDocumentCatalogue: InsuranceDocumentClassEntry[] = [
  {
    subClass: 'policy_schedule',
    label: 'Insurance policy schedule (new/renewed cover summary)',
    status: 'certified',
    rationale:
      'Bounded generic label:value layout deterministically parsed and reconciled this pass (parser.ts + reconciliation.ts), exercised through the real AIE orchestrator with synthetic fixtures. No specific real insurer\'s exact layout was sourced or tested — see ELIG-05 note in parser.ts.',
  },
  {
    subClass: 'renewal_notice',
    label: 'Insurance renewal notice',
    status: 'certified',
    rationale: 'Same bounded generic layout and field set as policy_schedule; distinguished only by header keyword for display/audit purposes.',
  },
  {
    subClass: 'premium_notice',
    label: 'Insurance premium notice',
    status: 'certified',
    rationale: 'Same bounded generic layout and field set as policy_schedule/renewal_notice.',
  },
  // --- Explicitly deferred. Not a promise, not attempted this pass. -------
  {
    subClass: 'product_disclosure_statement',
    label: 'Product Disclosure Statement (PDS) / policy wording document',
    status: 'deferred',
    rationale:
      'A PDS is long-form legal/product text, not a structured label:value schedule — no deterministic field-extraction approach exists for it in this codebase, and AIE14-INS-11 ("do not determine insurance adequacy/suitability") makes an AI-summarised PDS an especially high-risk shortcut this pass explicitly avoids. The parser detects and names this sub-class so it fails safely as an explicit unresolved item rather than being silently mis-parsed as a policy schedule.',
  },
  {
    subClass: 'claim_document',
    label: 'Insurance claim document/correspondence',
    status: 'deferred',
    rationale:
      'No canonical "insurance claim" model exists anywhere in this repository (only `insurance_policies` — a cover record, not a claim ledger) — AIE14-ELIG-06 ("prohibit certification where no stable canonical destination exists") applies directly. Detected and named so it fails safely rather than being coerced into a policy-schedule shape it does not have.',
  },
  {
    subClass: 'unclassified_insurance_document',
    label: 'Insurance-domain text that does not match any known sub-class header',
    status: 'deferred',
    rationale: 'Genuinely ambiguous input — never guessed into one of the certified sub-classes above.',
  },
];

export function isInsuranceDocumentClassCertified(subClass: string): boolean {
  return InsuranceDocumentCatalogue.some((e) => e.subClass === subClass && e.status === 'certified');
}
