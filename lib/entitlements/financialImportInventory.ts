/**
 * Premium Upload Entitlement -- the machine-reviewable inventory of every customer-facing financial upload / import
 * entry point, and of everything deliberately NOT gated.
 *
 * This file is the single list a future developer reads to find the protected estate and the exceptions, and the
 * input to `tests/unit/premiumUploadInventoryContract.test.ts`, which FAILS if
 *   - a customer route that accepts file bytes / creates an import document / starts extraction is missing here, or
 *   - a listed route stops calling the central Premium capability (before it reads the body), or
 *   - an Admin / system route starts calling the consumer capability, or
 *   - a manual-entry route starts depending on it.
 *
 * RULE FOR NEW WORK (documented in docs/entitlements/PREMIUM_UPLOAD_ENTITLEMENT.md): any new customer financial
 * file upload, statement import, connector (Open Banking / CDR / Account Aggregator) or extraction/reprocess route
 * must call `refuseUnlessFinancialImportAllowed` (admission) or `refuseUnlessImportRunMayStart` (processing an
 * already-admitted document) from `@/lib/entitlements/financialDataImport` BEFORE it reads the body, stores a byte,
 * issues a credential, queues a job or calls a provider -- and be added here. Customer data connectors and automated
 * ingestion are Premium unless the Product Owner explicitly changes the policy.
 *
 * Plain data, no imports: safe to read from a test, a script or a doc generator.
 */

export type GuardKind = 'admission' | 'run_start';

export interface GatedRoute {
  /** Stable id; also the `surface` string the route passes to the guard (checked by the contract test). */
  surface: string;
  /** Repository-relative route file. */
  file: string;
  method: 'POST';
  guard: GuardKind;
  /** Product domain, for lock copy / conversion attribution (never a document type or file name). */
  domain: 'income' | 'expenses' | 'liabilities' | 'investments' | 'retirement' | 'insurance' | 'fdh';
  /** What the route does, in one line. */
  what: string;
  /** Where the bytes / document row / job would land if it were allowed. */
  storage: string;
  /** Where the approved result ends up. */
  downstream: string;
  /** The UI that calls it (null = no UI caller; an API-only surface). */
  ui: string | null;
}

const FDH = 'app/api/financial-data-hub';
const AIE = 'app/api/aie';
const II = 'app/api/investment-intelligence';

export const GATED_ROUTES: readonly GatedRoute[] = [
  // ---- Admission: the route that first receives a file / creates the import document ----
  { surface: 'fdh.upload_session.create', file: `${FDH}/documents/upload-sessions/route.ts`, method: 'POST', guard: 'admission', domain: 'income',
    what: 'Creates the document row + single-use upload session (payslip, and any generic FDH document type).', storage: 'fdh_statement_uploads + fdh_upload_sessions rows; no credential issued', downstream: 'Income proposal via payslip review/apply', ui: 'components/income/PayslipImportPanel.tsx' },
  { surface: 'fdh.upload_session.complete', file: `${FDH}/documents/upload-sessions/[sessionId]/complete/route.ts`, method: 'POST', guard: 'admission', domain: 'income',
    what: 'Receives the file bytes and writes them to private storage.', storage: 'private bucket fdh-source-documents', downstream: 'Income proposal via payslip review/apply', ui: 'components/income/PayslipImportPanel.tsx' },
  { surface: 'fdh.bank_csv.upload', file: `${FDH}/bank-csv/upload/route.ts`, method: 'POST', guard: 'admission', domain: 'expenses',
    what: 'Bank statement CSV upload.', storage: 'private bucket fdh-source-documents + fdh_statement_uploads', downstream: 'fdh_transactions -> approved Expenses actuals', ui: 'components/expenses/BankStatementImportPanel.tsx' },
  { surface: 'fdh.bank_pdf.upload', file: `${FDH}/bank-pdf/upload/route.ts`, method: 'POST', guard: 'admission', domain: 'expenses',
    what: 'Bank statement PDF upload.', storage: 'private bucket fdh-source-documents + fdh_statement_uploads', downstream: 'fdh_transactions -> approved Expenses actuals', ui: 'components/expenses/BankStatementImportPanel.tsx' },
  { surface: 'fdh.liability_statement.upload', file: `${FDH}/liability-statement/upload/route.ts`, method: 'POST', guard: 'admission', domain: 'liabilities',
    what: 'Credit card / loan statement upload (shared importer).', storage: 'private bucket fdh-source-documents + fdh_statement_uploads', downstream: 'liability statement evidence -> liability proposal -> Liabilities', ui: 'components/liabilities/LiabilityImportPanel.tsx' },
  { surface: 'fdh.investment_statement.upload', file: `${FDH}/investment-statement/upload/route.ts`, method: 'POST', guard: 'admission', domain: 'investments',
    what: 'Australian investment statement upload.', storage: 'private bucket fdh-source-documents + fdh_statement_uploads', downstream: 'Investment Intelligence canonical positions (publish/apply)', ui: 'components/investments/AuInvestmentStatementImportPanel.tsx' },
  { surface: 'fdh.retirement_statement.upload', file: `${FDH}/retirement-statement/upload/route.ts`, method: 'POST', guard: 'admission', domain: 'retirement',
    what: 'Super / EPF / NPS statement upload.', storage: 'private bucket fdh-source-documents + fdh_statement_uploads', downstream: 'retirement statement evidence -> retirement account summary (apply)', ui: 'components/retirement/RetirementStatementImportPanel.tsx' },
  { surface: 'aie.intake.upload', file: `${AIE}/intake/route.ts`, method: 'POST', guard: 'admission', domain: 'fdh',
    what: 'Generic AIE document intake (diagnostic; Apply structurally refused).', storage: 'AIE quarantine storage + aie_document_intake', downstream: 'none (diagnostic)', ui: null },
  { surface: 'aie.insurance.intake', file: `${AIE}/insurance/intake/route.ts`, method: 'POST', guard: 'admission', domain: 'insurance',
    what: 'AIE insurance document intake.', storage: 'AIE quarantine storage + aie_document_intake', downstream: 'insurance proposal via AIE review', ui: null },
  { surface: 'aie.fdh_bank.intake', file: `${AIE}/fdh-bank/intake/route.ts`, method: 'POST', guard: 'admission', domain: 'expenses',
    what: 'AIE-fronted bank statement intake.', storage: 'AIE quarantine storage + aie_document_intake', downstream: 'fdh_transactions via AIE review', ui: null },
  { surface: 'aie.investment_intelligence.intake', file: `${AIE}/investment-intelligence/intake/route.ts`, method: 'POST', guard: 'admission', domain: 'investments',
    what: 'AIE-fronted Investment Intelligence statement intake.', storage: 'AIE quarantine storage + aie_document_intake', downstream: 'Investment Intelligence via AIE review', ui: null },
  { surface: 'ii.source_document.upload', file: `${II}/source-documents/route.ts`, method: 'POST', guard: 'admission', domain: 'investments',
    what: 'India CAS / folio statement upload (multipart).', storage: 'private bucket for II source documents + ii_source_documents', downstream: 'ii_transactions / holdings (publish)', ui: 'components/investment-intelligence/InvestmentIntelligenceClient.tsx' },
  { surface: 'ii.source_document.replacement', file: `${II}/source-documents/[id]/replacement/route.ts`, method: 'POST', guard: 'admission', domain: 'investments',
    what: 'Controlled replacement copy of an already-uploaded statement whose raw file was deleted (attached to the SAME document; never a second one).', storage: 'private bucket for II source documents + ii_source_documents', downstream: 'ii_transactions / holdings (publish), via the idempotent process route', ui: 'components/investment-intelligence/ReplacementCopyControl.tsx' },
  { surface: 'ii.source_document.parse_fixture', file: `${II}/source-documents/[id]/parse/route.ts`, method: 'POST', guard: 'admission', domain: 'investments',
    what: 'Fixture importer: writes a supplied JSON statement into Investment Intelligence (QA path; not the manual-entry route).', storage: 'ii_source_documents + canonical II tables', downstream: 'ii_transactions / holdings', ui: null },

  // ---- Run start: process / retry / detect / map / confirm for an ALREADY-ADMITTED document ----
  { surface: 'fdh.bank_csv.detect', file: `${FDH}/bank-csv/[documentId]/detect/route.ts`, method: 'POST', guard: 'run_start', domain: 'expenses',
    what: 'Detects the CSV layout of an admitted statement.', storage: 'reads private storage', downstream: 'bank CSV mapping', ui: 'components/expenses/BankStatementImportPanel.tsx' },
  { surface: 'fdh.bank_csv.map', file: `${FDH}/bank-csv/[documentId]/map/route.ts`, method: 'POST', guard: 'run_start', domain: 'expenses',
    what: 'Saves the column mapping of an admitted CSV.', storage: 'mapping row', downstream: 'bank CSV processing', ui: 'components/expenses/BankStatementImportPanel.tsx' },
  { surface: 'fdh.bank_csv.process', file: `${FDH}/bank-csv/[documentId]/process/route.ts`, method: 'POST', guard: 'run_start', domain: 'expenses',
    what: 'Parses an admitted CSV into transactions (retry of a failed document is a new run).', storage: 'reads private storage; writes fdh_transactions', downstream: 'approved Expenses actuals', ui: 'components/expenses/BankStatementImportPanel.tsx' },
  { surface: 'fdh.bank_pdf.process', file: `${FDH}/bank-pdf/[documentId]/process/route.ts`, method: 'POST', guard: 'run_start', domain: 'expenses',
    what: 'Parses an admitted bank PDF (may reach the AI fallback, separately gated).', storage: 'reads private storage; writes fdh_transactions', downstream: 'approved Expenses actuals', ui: 'components/expenses/BankStatementImportPanel.tsx' },
  { surface: 'fdh.bank_pdf.ai_fallback_confirm', file: `${FDH}/bank-pdf/[documentId]/ai-fallback/confirm/route.ts`, method: 'POST', guard: 'run_start', domain: 'expenses',
    what: 'Saves the user-reviewed AI draft of an admitted bank PDF (no provider call).', storage: 'writes fdh_transactions', downstream: 'approved Expenses actuals', ui: 'components/expenses/BankStatementImportPanel.tsx' },
  { surface: 'fdh.payslip.process', file: `${FDH}/payslip/[documentId]/process/route.ts`, method: 'POST', guard: 'run_start', domain: 'income',
    what: 'Parses an admitted payslip (may reach the AI fallback, separately gated).', storage: 'reads private storage; writes payroll evidence', downstream: 'Income proposal', ui: 'components/income/PayslipImportPanel.tsx' },
  { surface: 'fdh.payslip.ai_fallback_confirm', file: `${FDH}/payslip/[documentId]/ai-fallback/confirm/route.ts`, method: 'POST', guard: 'run_start', domain: 'income',
    what: 'Saves the user-reviewed AI draft of an admitted payslip (no provider call).', storage: 'writes payroll evidence', downstream: 'Income proposal', ui: 'components/income/PayslipImportPanel.tsx' },
  { surface: 'fdh.liability_statement.process', file: `${FDH}/liability-statement/[documentId]/process/route.ts`, method: 'POST', guard: 'run_start', domain: 'liabilities',
    what: 'Parses an admitted card / loan statement.', storage: 'reads private storage; writes statement evidence', downstream: 'liability proposal', ui: 'components/liabilities/LiabilityImportPanel.tsx' },
  { surface: 'fdh.liability_statement.ai_fallback_confirm', file: `${FDH}/liability-statement/[documentId]/ai-fallback/confirm/route.ts`, method: 'POST', guard: 'run_start', domain: 'liabilities',
    what: 'Saves the user-reviewed AI draft of an admitted card / loan statement (no provider call).', storage: 'writes statement evidence', downstream: 'liability proposal', ui: 'components/liabilities/LiabilityImportPanel.tsx' },
  { surface: 'fdh.investment_statement.process', file: `${FDH}/investment-statement/[documentId]/process/route.ts`, method: 'POST', guard: 'run_start', domain: 'investments',
    what: 'Parses an admitted AU investment statement.', storage: 'reads private storage; writes statement evidence', downstream: 'Investment Intelligence', ui: 'components/investments/AuInvestmentStatementImportPanel.tsx' },
  { surface: 'fdh.investment_statement.ai_fallback_confirm', file: `${FDH}/investment-statement/[documentId]/ai-fallback/confirm/route.ts`, method: 'POST', guard: 'run_start', domain: 'investments',
    what: 'Saves the user-reviewed AI draft of an admitted AU investment statement (no provider call).', storage: 'writes statement evidence', downstream: 'Investment Intelligence', ui: 'components/investments/AuInvestmentStatementImportPanel.tsx' },
  { surface: 'fdh.retirement_statement.process', file: `${FDH}/retirement-statement/[documentId]/process/route.ts`, method: 'POST', guard: 'run_start', domain: 'retirement',
    what: 'Parses an admitted super / EPF / NPS statement.', storage: 'reads private storage; writes statement evidence', downstream: 'retirement summary (apply)', ui: 'components/retirement/RetirementStatementImportPanel.tsx' },
  { surface: 'fdh.retirement_statement.ai_fallback_confirm', file: `${FDH}/retirement-statement/[documentId]/ai-fallback/confirm/route.ts`, method: 'POST', guard: 'run_start', domain: 'retirement',
    what: 'Saves the user-reviewed AI draft of an admitted retirement statement (no provider call).', storage: 'writes statement evidence', downstream: 'retirement summary (apply)', ui: 'components/retirement/RetirementStatementImportPanel.tsx' },
  { surface: 'aie.investment_intelligence.process', file: `${AIE}/investment-intelligence/intake/[intakeId]/process/route.ts`, method: 'POST', guard: 'run_start', domain: 'investments',
    what: 'Processes an admitted AIE II intake (AI fallback separately gated).', storage: 'reads AIE storage; writes extraction run', downstream: 'Investment Intelligence via AIE review', ui: null },
  { surface: 'ii.source_document.process', file: `${II}/source-documents/[id]/process/route.ts`, method: 'POST', guard: 'run_start', domain: 'investments',
    what: 'Parses an admitted India CAS document; a retry or forceReparse is a new run.', storage: 'reads private storage; writes parse run + canonical II tables', downstream: 'ii_transactions / holdings (publish)', ui: 'components/investment-intelligence/InvestmentIntelligenceClient.tsx' },
];

/**
 * Routes that touch an already-admitted import but are deliberately NOT gated, with the reason. These are the review /
 * correct / approve / apply / delete / privacy actions: they start no new file admission, no new extraction and no
 * provider call, require an existing admitted document or proposal owned by the caller (RLS), and must stay available
 * after a downgrade so a user's data is never stranded behind a paywall, and so privacy rights are never paywalled.
 */
export const REVIEW_CONTINUATION_ROUTES: readonly { file: string; reason: string }[] = [
  { file: `${FDH}/documents/[documentId]/approve/route.ts`, reason: 'approve an already-admitted document (review lifecycle)' },
  { file: `${FDH}/documents/[documentId]/reopen/route.ts`, reason: 'reopen review of an already-admitted document' },
  { file: `${FDH}/payslip/[documentId]/approve/route.ts`, reason: 'approve admitted payslip evidence' },
  { file: `${FDH}/payslip/[documentId]/correct/route.ts`, reason: 'correct admitted payslip evidence' },
  { file: `${FDH}/payslip/[documentId]/proposal/route.ts`, reason: 'derive the proposal from admitted evidence' },
  { file: `${FDH}/income-proposals/[proposalId]/apply/route.ts`, reason: 'apply a proposal that only exists because an admitted run produced it' },
  { file: `${FDH}/liability-proposals/[proposalId]/apply/route.ts`, reason: 'apply a proposal that only exists because an admitted run produced it' },
  { file: `${FDH}/investment-statement/[documentId]/apply/route.ts`, reason: 'apply admitted evidence' },
  { file: `${FDH}/retirement-statement/[documentId]/apply/route.ts`, reason: 'apply admitted evidence' },
  { file: `${FDH}/bank-transactions/[transactionId]/approve/route.ts`, reason: 'approve admitted transactions' },
  { file: `${AIE}/review/runs/[runId]/accept/route.ts`, reason: 'accept an admitted AIE run after review' },
  { file: `${II}/ai-extraction-reviews/[reviewId]/accept/route.ts`, reason: 'accept an admitted AI reading after review' },
  { file: `${II}/source-documents/[id]/discard/route.ts`, reason: 'delete an admitted document (privacy / cleanup is never Premium)' },
];

/**
 * Customer MANUAL-entry routes. They must keep working on Free and must NEVER call the import capability. (A
 * representative, non-exhaustive set: the contract test also scans the whole manual-entry tree by path.)
 */
export const MANUAL_ENTRY_ROUTE_DIRS: readonly string[] = [
  'app/api/income',
  'app/api/expenses',
  'app/api/assets',
  'app/api/liabilities',
  'app/api/investments',
  'app/api/retirement',
  'app/api/insurance',
  'app/api/goals',
  'app/api/smsf',
  'app/api/commitments',
  'app/api/business-entities',
  'app/api/household',
  'app/api/household-members',
  'app/api/investment-intelligence/positions/manual',
];

/** Staff / reference-data / system routes: governed by Admin capabilities or a shared secret, never by the consumer plan. */
export const ADMIN_AND_SYSTEM_EXEMPT_PREFIXES: readonly { prefix: string; reason: string }[] = [
  { prefix: 'app/api/admin/', reason: 'Admin staff: governed by requireAdmin() and the per-capability guards (Resources, Benchmarks, Recommendations, Market Index Data, Risk-free rate, Promo/Premium administration).' },
  { prefix: 'app/api/aie/cron/', reason: 'Scheduled system job (shared-secret authenticated), not a customer.' },
  { prefix: 'app/api/financial-data-hub/documents/cron/', reason: 'Scheduled system job (shared-secret authenticated), not a customer.' },
  { prefix: 'app/api/investment-intelligence/cron/', reason: 'Scheduled system job (shared-secret authenticated), not a customer.' },
  { prefix: 'app/api/reports/cron/', reason: 'Scheduled system job (shared-secret authenticated), not a customer.' },
  { prefix: 'app/api/premium/cron/', reason: 'Scheduled system job (shared-secret authenticated), not a customer.' },
  { prefix: 'app/api/payments/', reason: 'Billing: checkout and verified provider webhooks. These WRITE entitlement state; they never read the import capability.' },
];

/** Counts the PO asked for (page 40): the exact tally, derived from the lists above so it cannot drift. */
export function inventoryCounts() {
  const admission = GATED_ROUTES.filter((r) => r.guard === 'admission').length;
  const runStart = GATED_ROUTES.filter((r) => r.guard === 'run_start').length;
  return {
    gatedRoutes: GATED_ROUTES.length,
    admissionRoutes: admission,
    runStartRoutes: runStart,
    reviewContinuationRoutesExempt: REVIEW_CONTINUATION_ROUTES.length,
    adminAndSystemExemptPrefixes: ADMIN_AND_SYSTEM_EXEMPT_PREFIXES.length,
    manualEntryRouteDirs: MANUAL_ENTRY_ROUTE_DIRS.length,
  };
}
