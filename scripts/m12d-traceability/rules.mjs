// M12D — the classification ruleset.
//
// HOW TO READ THIS FILE. Every entry below is a claim I am willing to have
// checked. `impl`/`test`/`live` are real repository paths or real named
// scenarios from the 18 mission documents. `grade` records HOW STRONG the
// evidence is, and is the honest part:
//
//   A  the requirement ID itself is cited at a specific file:line AND that
//      artifact demonstrably addresses this requirement's subject.
//   B  a named artifact was verified (by reading it in this phase) to
//      implement/test this family's subject, but this individual member's
//      conformance was not separately re-proved here.
//   C  a governed Product-Owner decision, deferral, prohibition or
//      scope-exclusion resolves it; the decision is named.
//   D  no artifact found. Honest status UNVERIFIED. Never dressed as CODE.
//
// Statuses: CODE TEST LIVEDEV DECISION DEFERRED PROHIBITED NA UNVERIFIED

export const A = {
  // ---- AIE-1.1 core (all verified by reading the file in this phase) ----
  fsm: 'lib/aie/stateMachine.ts',
  repo: 'lib/aie/db/repository.ts',
  mig140: 'supabase/migrations/0140_aie1_1_shared_document_gateway.sql',
  mig149: 'supabase/migrations/0149_aie1_closure_document_lifecycle_purge.sql',
  mig150: 'supabase/migrations/0150_aie1_closure_cost_admission.sql',
  mig152: 'supabase/migrations/0152_aie1_cost_admission_idempotent_reserve_settle.sql',
  mig144: 'supabase/migrations/0144_aie1_5_review_decision_correction_columns.sql',
  mig153: 'supabase/migrations/0153_pc5_governed_resolution.sql',
  mig155: 'supabase/migrations/0155_pc6_reference_market_data_foundation.sql',
  mig157: 'supabase/migrations/0157_pc7_lookthrough_foundation.sql',
  fileVal: 'lib/aie/validation/fileValidation.ts',
  fingerprint: 'lib/aie/fingerprint.ts',
  txt: 'lib/aie/extraction/textExtraction.ts',
  mask: 'lib/aie/masking/piiMasking.ts',
  token: 'lib/aie/masking/identifierToken.ts',
  gateway: 'lib/aie/provider/gateway.ts',
  openai: 'lib/aie/provider/openaiAieProvider.ts',
  providerFactory: 'lib/aie/provider/providerFactory.ts',
  jsonSchema: 'lib/aie/provider/openaiJsonSchema.ts',
  schemaReg: 'lib/aie/schema/schemaRegistry.ts',
  parserReg: 'lib/aie/classifier/registry.ts',
  orch: 'lib/aie/orchestrator.ts',
  cost: 'lib/aie/cost/costAdmission.ts',
  audit: 'lib/aie/audit.ts',
  purge: 'lib/aie/services/purge.ts',
  storage: 'lib/aie/storage.ts',
  config: 'lib/aie/config.ts',
  flags: 'lib/aie/featureFlags.ts',
  recTypes: 'lib/aie/reconciliation/types.ts',
  malware: 'lib/aie/malware/scanResultHandler.ts',
  pc5If: 'lib/aie/pc5/pc5ExceptionInterface.ts',
  types: 'lib/aie/types.ts',
  // routes
  rIntake: 'app/api/aie/intake/route.ts',
  rIntakeId: 'app/api/aie/intake/[intakeId]/route.ts',
  rInbox: 'app/api/aie/review/inbox/route.ts',
  rRun: 'app/api/aie/review/runs/[runId]/route.ts',
  rAccept: 'app/api/aie/review/runs/[runId]/accept/route.ts',
  rReject: 'app/api/aie/review/runs/[runId]/reject/route.ts',
  rReveal: 'app/api/aie/review/runs/[runId]/reveal/route.ts',
  rDecide: 'app/api/aie/review/items/[itemId]/decide/route.ts',
  rUnresolved: 'app/api/aie/unresolved-items/route.ts',
  rPurgeCron: 'app/api/aie/cron/purge-sweep/route.ts',
  rIiIntake: 'app/api/aie/investment-intelligence/intake/route.ts',
  rIiProcess: 'app/api/aie/investment-intelligence/intake/[intakeId]/process/route.ts',
  rFdhIntake: 'app/api/aie/fdh-bank/intake/route.ts',
  rInsIntake: 'app/api/aie/insurance/intake/route.ts',
  // review domain
  revAccept: 'lib/aie/review/accept.ts',
  revDecide: 'lib/aie/review/decide.ts',
  revReject: 'lib/aie/review/reject.ts',
  revReveal: 'lib/aie/review/reveal.ts',
  revValidation: 'lib/aie/review/validation.ts',
  revRevalidate: 'lib/aie/review/revalidate.ts',
  revProjection: 'lib/aie/review/projection.ts',
  revMerge: 'lib/aie/review/candidateMerge.ts',
  revReasons: 'lib/aie/review/reasonCodes.ts',
  revModules: 'lib/aie/review/moduleRegistry.ts',
  revAria: 'lib/aie/review/ariaLabels.ts',
  revUserState: 'lib/aie/review/userState.ts',
  revFlags: 'lib/aie/review/featureFlags.ts',
  uiInbox: 'components/aie/review/ReviewInbox.tsx',
  uiPanel: 'components/aie/review/RunReviewPanel.tsx',
  uiCorrection: 'components/aie/review/CorrectionForm.tsx',
  uiEvidence: 'components/aie/review/EvidenceReveal.tsx',
  pageInbox: 'app/(app)/aie-review/page.tsx',
  pageRun: 'app/(app)/aie-review/[runId]/page.tsx',
  // adapters
  iiDir: 'lib/aie/adapters/investment-intelligence/',
  fdhDir: 'lib/aie/adapters/fdhBankStatement/',
  insDir: 'lib/aie/adapters/insurance/',
};

export const T = {
  fsm: 'tests/unit/aieStateMachine.test.ts (17 cases)',
  fileVal: 'tests/unit/aieFileValidation.test.ts (18 cases)',
  fingerprint: 'tests/unit/aieFingerprint.test.ts (6 cases)',
  mask: 'tests/unit/aiePiiMasking.test.ts (30 cases)',
  token: 'tests/unit/aieIdentifierTokenOneWay.test.ts (13 cases)',
  tokenTtl: 'tests/unit/aieMaskTokenTtl.test.ts',
  gateway: 'tests/unit/aieAiGateway.test.ts (14 cases)',
  openai: 'tests/unit/aieOpenAiProvider.test.ts',
  providerFactory: 'tests/unit/aieProviderFactoryAndJsonSchema.test.ts',
  schemaReg: 'tests/unit/aieSchemaRegistry.test.ts (10 cases)',
  cost: 'tests/unit/aieCostAdmission.test.ts (9 cases)',
  costPg: 'tests/unit/aieCostAdmissionPglitePostgresProof.test.ts',
  purge: 'tests/unit/aiePurgeService.test.ts (16 cases)',
  purgeStatus: 'tests/unit/m12cAiePurgeStatusContract.test.ts',
  orch: 'tests/unit/aieOrchestrator.test.ts (6 cases)',
  injection: 'tests/unit/aieM2PromptInjection.test.ts (8 cases)',
  adv: 'tests/unit/aie16CertificationAdversarial.test.ts',
  advPdf: 'tests/unit/aie16CertificationAdversarialPdf.test.ts',
  guardduty: 'tests/unit/aieGuardDutyScanResultHandler.test.ts',
  entitlement: 'tests/unit/aiEntitlementEnforcement.test.ts',
  entitlementSvc: 'tests/unit/aiEntitlementServiceAndCapabilities.test.ts',
  pilot: 'tests/unit/aiePilotCohort.test.ts',
  pc5If: 'tests/unit/aiePc5ExceptionInterface.test.ts',
  // II adapter
  iiMatch: 'tests/unit/aieIiAdapterMatching.test.ts',
  iiParse: 'tests/unit/aieIiAdapterParser.test.ts',
  iiProhib: 'tests/unit/aieIiAdapterProhibitions.test.ts',
  iiRecon: 'tests/unit/aieIiAdapterReconciliation.test.ts',
  iiSchema: 'tests/unit/aieIiAdapterSchema.test.ts',
  iiWrite: 'tests/unit/aieIiAdapterWriteGate.test.ts',
  iiDispatch: 'tests/unit/aieM3InvestmentDispatch.test.ts',
  iiFacts: 'tests/unit/aieM3InvestmentDocumentFactsSchema.test.ts',
  iiCorpus: 'tests/unit/aieM3InvestmentCorpusAccuracy.test.ts',
  iiPc4: 'tests/unit/aieM3Pc4SemanticPreservation.test.ts',
  iiDisagree: 'tests/unit/aieM3SourceDisagreement.test.ts',
  // FDH adapter
  fdhParse: 'tests/unit/aieFdhBankStatementParser.test.ts',
  fdhRecon: 'tests/unit/aieFdhBankStatementReconciliation.test.ts',
  fdhOrch: 'tests/unit/aieFdhBankStatementOrchestratorIntegration.test.ts',
  // Insurance adapter
  insParse: 'tests/unit/aieInsuranceAdapterParser.test.ts',
  insRecon: 'tests/unit/aieInsuranceAdapterReconciliation.test.ts',
  insWrite: 'tests/unit/aieInsuranceAdapterWriteGate.test.ts',
  insOrch: 'tests/unit/aieInsuranceAdapterOrchestratorIntegration.test.ts',
  insRoute: 'tests/unit/aieInsuranceIntakeRouteRegistersAdapter.test.ts',
  insE2e: 'tests/unit/aieReviewE2eInsuranceJourney.test.ts',
  // review
  revAccept: 'tests/unit/aieReviewAccept.test.ts',
  revReject: 'tests/unit/aieReviewReject.test.ts',
  revReveal: 'tests/unit/aieReviewReveal.test.ts',
  revValidation: 'tests/unit/aieReviewValidation.test.ts',
  revRevalidate: 'tests/unit/aieReviewRevalidate.test.ts',
  revMerge: 'tests/unit/aieReviewCandidateMerge.test.ts',
  revReasons: 'tests/unit/aieReviewReasonCodesAndModules.test.ts',
  revAria: 'tests/unit/aieReviewAriaLabels.test.ts',
  revUserState: 'tests/unit/aieReviewUserState.test.ts',
  // harnesses
  accHarness: 'tests/support/aieAccuracyHarness.ts',
  privHarness: 'tests/support/aiePrivacyProofHarness.ts',
};

export const L = {
  provider: 'tests/live-dev/aieM2RealProviderProof.live.test.ts + scripts/aiecl_real_openai_provider_live_verify.mjs',
  iiDispatch: 'tests/live-dev/aieM3InvestmentDispatchLiveDev.test.ts',
  maskEgress: 'scripts/aiecl_masking_before_egress_live_dev_check.ts',
  costIdem: 'scripts/aiecl_0152_cost_idempotency_live_dev_verify.mjs',
  costConc: 'scripts/aiecl_concurrent_cost_admission_live_dev_check.ts',
  crossTenant: 'scripts/aiecl_review_route_cross_tenant_live_dev_check.ts',
  pc5If: 'scripts/aiecl_pc5_interface_live_dev_check.ts',
  a11y: 'scripts/aiecl_accessibility_live_dev_check.ts + scripts/aiecl_accessibility_additional_states_live_dev.ts',
  a11yAxe: 'scripts/m12c_pc5_accessibility_live_dev.ts (automated axe pass)',
  insReg: 'scripts/aiecl_insurance_regression_live_dev.ts',
  failState: 'scripts/aiecl_failed_state_ui_live_dev_check.ts',
  accepted: 'scripts/aiecl_accepted_importing_ui_live_dev_check.ts',
  backstop: 'scripts/aiecl_24h_backstop_live_dev.ts',
  rls: 'scripts/aie1_live_dev_rls_real_tables_proof.mjs + scripts/aie1_live_dev_rls_method_proof.mjs',
  migState: 'scripts/aiecl_closure_migration_state_check.mjs',
  syntheticPack: 'scripts/m12c_pc4_synthetic_pack_live_dev.ts (DEV pack S01-S10)',
  ownerRepro: 'scripts/m12c_pc5_owner_mapping_synthetic_repro.ts',
  m12aCorpus: 'scripts/m12a-fdh-bank-certification/results.json (+ oracle.json, results_table.md)',
  m12bCorpus: 'scripts/m12b-insurance-certification/results.json (+ oracle.json, results_table.md)',
  m12bPrivacy: 'scripts/m12b-insurance-certification/privacy_proof.json',
  pc4Probe: 'scripts/m12c_pc4_readonly_probe.mjs',
  pc4Attr: 'scripts/m12c_pc4_residual_attribution_probe.mjs',
  pc4Replay: 'scripts/m12c_pc4_residual_replay_probe.mjs',
  pc4Warn: 'scripts/m12c_pc4_warning_taxonomy_probe.mjs',
};

// Named governing decisions/exclusions (all quoted from real repository documents).
export const D = {
  PC6_LICENCE:
    'PC6 benchmark/risk-free requirements are blocked on a named Product-Owner methodology and index-licensing choice — see docs/investment-intelligence/PC6_MARKET_DATA_CERTIFICATION_2026-09-15.md. Per this mission\'s governing decisions these are DECISION, not FAIL.',
  PC7_LICENCE:
    'PC7 disclosure-data ingestion is blocked on a named Product-Owner disclosure-licensing decision — see docs/investment-intelligence/PC7_LOOKTHROUGH_CERTIFICATION_2026-09-15.md. Per this mission\'s governing decisions these are DECISION, not FAIL.',
  PC8910:
    'PC8/PC9/PC10 were never approved and no authoritative scope was found — docs/investment-intelligence/PC8_PC9_PC10_SCOPE_CLOSURE_2026-09-15.md. Classified DEFERRED with that exact reason rather than orphaned, per this dispatch\'s governing decisions.',
  LABELS:
    'Depends on `labelsSeenRaw` semantics, left deliberately INERT rather than guessed — PO-BLOCKER-3 (docs/investment-intelligence/AIE_INFRA_CLOSURE_REPORT_2026-09-15.md:753). Classified per its own non-load-bearing status, not as a defect.',
  NOPROD:
    'Requires production authority. Every phase of this programme has operated under an explicit BINDING PRODUCTION OVERRIDE (no production migration, no provider traffic, no cohort activation); AIE-1 stands at CONDITIONAL PASS, explicitly NOT production ready (docs/investment-intelligence/AIE1_TERMINAL_CERTIFICATION_2026-09-15.md). DEFERRED until production authority is granted.',
  AWS:
    'Depends on AWS S3/GuardDuty provisioning and AIE_MASK_TOKEN_ENCRYPTION_KEY, which remain unresolved and are being handled in a separate Product-Owner-present track (docs/aie-programme/AIE_1_CLOSURE_AWS_INFRASTRUCTURE.md, AIE_1_PROVISIONING_IAM_POLICY_REQUEST.md).',
  CLASS_DEFER: (cls, why) =>
    `AIE-1.4 document class "${cls}" is DEFERRED by the programme's own class register (docs/aie-programme/AIE_1_CLOSURE_DEFERRED_CLASS_REGISTER.md, row for ${cls}): ${why} No adapter was built, so there is nothing to trace to.`,
  CLASS_PROHIBIT:
    'AIE-1.4 document class "Identity/medical/legal/sensitive" is PROHIBITED by the AIE-1.4 specification itself — a binding non-negotiable exclusion, not a scope gap (docs/aie-programme/AIE_1_CLOSURE_DEFERRED_CLASS_REGISTER.md, row 10). No ingestion path exists or will exist under this mission\'s authority.',
  CLASS_NA:
    'AIE-1.4 treats cross-border/jurisdiction documents as NOT an independent class — resolved by design through the Insurance adapter\'s existing country/currency gate (docs/aie-programme/AIE_1_CLOSURE_DEFERRED_CLASS_REGISTER.md, row 9).',
  OA11:
    'Blocked on operator decision OA-11 — whether real production Investment Intelligence data may be reprocessed (docs/investment-intelligence/M12C_INTEGRITY_HARDENING_CLOSURE_2026-09-15.md). The 4 remaining PC4 residuals are structurally caused by incomplete production data (3 of 5 historical parse runs failed and inserted no rows), not by a code defect.',
  OWNERUI:
    'PC4 owner-mapping instructions are written but blocked on a missing UI screen — operator action recorded in docs/investment-intelligence/M12C_PC4_OWNER_MAPPING_OPERATOR_ACTION.md.',
  GOV01:
    'AIE10-GOV-01 requires named owners (Product Owner, architecture owner, privacy/security reviewer, domain owners, PC5 consumer owner, production-release authority). No such naming exists anywhere in the repository; recorded as an open Product-Owner item (PO-PC5-3 / A7 in docs/investment-intelligence/AIE_II_POST_PC4_FINAL_CERTIFICATION_2026-09-15.md:1728).',
  NOADR:
    'The 18 ADRs the AIE-1.0 contract requires were never authored. No ADR file exists anywhere under docs/. Honest status: UNVERIFIED — the architecture decision it records was in several cases made and implemented, but the required ADR artifact itself does not exist.',
};
