import { requireCountryConfirmedUser as requireUser, ok } from '@/lib/api';

// Investment Intelligence R6-FINAL — cost/TER intelligence surface
// (spec Section 18).
//
// HONEST GAP, NOT A FABRICATED NUMBER: no real Total Expense Ratio (TER)
// reference-data table exists in this schema as of this dispatch (checked:
// migrations 0031-0060 create no such table; exitLoad.ts's buildTerContext()
// takes `terPct` as a caller-supplied number with no data source behind it —
// see docs/investment-intelligence/R6P1_IMPLEMENTATION_REPORT.md's
// known-limitations section, item 2, and R6_FINAL_PRE_DEV_CLOSURE_REPORT.md).
// Per the spec's own explicit rule ("do not infer TER from returns, do not
// fill with category averages"), the correct behaviour when there is no
// real TER data source is to say so plainly — never fabricate a number.
// This is a genuine, disclosed scope gap for a future phase, not something
// this dispatch invents a migration to fill.

export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  return ok({
    available: false,
    reason: 'TER (Total Expense Ratio) intelligence is not yet operational — no TER reference-data source exists in this schema. Figures are never inferred from returns or filled with category averages; they are only shown once a real TER data source is built.',
  });
}
