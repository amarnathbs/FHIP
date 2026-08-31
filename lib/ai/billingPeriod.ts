// Module 11.1 — the single client-side definition of "this billing month".
//
// Extracted from lib/ai/audit/aiRuns.ts, where Module 11.0 kept it as a
// module-private helper. It is shared now because the entitlement layer, the
// ledger writer and the admin usage views all have to agree on exactly which
// month a request belongs to — three private copies of this would be three
// chances to disagree.
//
// HONEST LIMITATION. A "billing month" here is the UTC calendar month. This
// codebase has no subscription/billing system at all: no Stripe/Paddle
// integration, no subscriptions table, no period columns, and
// user_entitlements.effective_from/effective_to are written by nothing and
// read by nothing. There is therefore no subscriber anniversary to anchor to.
// This matches ai_usage_ledger.billing_period, which Module 11.0 already
// defined as a UTC calendar month.
//
// The authoritative definition for ENFORCEMENT is the DB function
// ai_billing_period_for(), because the admission RPC must not depend on the
// application server's clock or timezone. This function exists for display,
// for the ledger writer, and for tests; both must produce the same string,
// which the PGlite certification asserts directly.

export function currentBillingPeriod(date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}
