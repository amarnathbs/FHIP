/**
 * FAMILY RETIREMENT FORECAST (PO-D24-01, 21-10-2026). PURE: no I/O.
 *
 * The existing retirement forecast stays PERSONAL-ONLY (PO decision 16-10-2026: the SMSF fund row is not a personal balance and its
 * contributions are kept out of the household contribution, LR-6). This module adds a SEPARATE view for a person who has an SMSF:
 *
 *     Family retirement position = Personal retirement + SMSF retirement economic value
 *
 * It does NOT change the personal forecast: the personal figures here are produced by running the existing calculator on the very
 * input the personal run uses, unchanged. The family run is the same calculator on the same input with exactly two numbers added:
 *   opening balance   + the SMSF component (below)
 *   monthly flow      + the SMSF contribution flow (below)
 * Same assumptions, same timing (the personal retirement age and the WP-D retirementTiming resolver), same target method.
 *
 * THE SMSF COMPONENT (counted once, never twice):
 *   - opening value: the fund's ONE canonical net (lib/engines/entityBalanceSheet.ts): itemised funds are assets less liabilities (the
 *     derived Detailed value, smsf_fund_counted_net), a fund recorded as a net value only is its typed net. NEVER Summary plus Detailed,
 *     and the fund's own account row in the Retirement register is never added on top of its holdings. Not clamped: a fund that owes more
 *     than it owns reduces the family position, and the view says so.
 *   - monthly flow: the SMSF contributions only (retirement_contributions rows with destination smsf and status active, resolved by the
 *     same series rules that derive the fund account's contribution figures, or the account's own figures when the ledger holds nothing
 *     for that kind of contribution). The family flow is personal flow plus this flow, combined exactly once (LR-FI-3).
 */
import { runRetirementForecast, type RetirementCalculatorInput, type RetirementStatus } from './retirementCalculator';

export type SmsfContributionSource =
  /** Every counted contribution came from the contribution ledger (and/or the fund account's figures for kinds the ledger holds nothing for). */
  | 'ledger_and_account'
  /** The contribution ledger is not available yet, so only the fund account's own figures were read. */
  | 'account_only'
  | 'none';

export interface FamilySmsfFund {
  id: string;
  name: string;
  recording: 'itemised' | 'net_only';
  /** The fund's one canonical net in the forecast's reporting currency (never clamped). */
  netReporting: number;
  /** Monthly SMSF contributions counted for this fund, in the reporting currency. */
  monthlyContribution: number;
}

export interface FamilySmsfComponentInput {
  funds: FamilySmsfFund[];
  /** Lines of the funds that could not be converted and were left out (counted, never zeroed silently). */
  unconvertedCount: number;
  /** Contributions with an unknown frequency (left out of the flow, never read as monthly). */
  unknownFrequencyCount: number;
  contributionSource: SmsfContributionSource;
}

export interface FamilyPositionFigures {
  opening: number;
  monthlyFlow: number;
  balanceAtRetirement: number | null;
  requiredCorpus: number | null;
  fundingGap: number | null;
  readinessPct: number | null;
  status: RetirementStatus | null;
}

export interface FamilyRetirementViewAvailable {
  available: true;
  currency: string;
  /** The personal forecast, exactly as the personal run computes it. */
  personal: FamilyPositionFigures;
  /** The SMSF component on its own (opening and flow; balance at retirement is that component grown on the same assumptions). */
  smsf: {
    opening: number;
    monthlyFlow: number;
    balanceAtRetirement: number | null;
    funds: FamilySmsfFund[];
    contributionSource: SmsfContributionSource;
    unconvertedCount: number;
    unknownFrequencyCount: number;
  };
  /** Personal + SMSF, one calculation. */
  family: FamilyPositionFigures;
  timing: { monthsUntilRetirement: number | null; retirementAge: number; retirementAgeSource: string | null };
  /** Plain-language notes the screen shows under the figures. */
  notes: string[];
}

export interface FamilyRetirementViewUnavailable {
  available: false;
  reason: 'no_smsf';
}

export type FamilyRetirementView = FamilyRetirementViewAvailable | FamilyRetirementViewUnavailable;

const cents = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

interface Summary {
  balanceAtRetirement: number | null;
  requiredCorpus: number | null;
  fundingGap: number | null;
  readinessPct: number | null;
  status: RetirementStatus | null;
  monthsUntilRetirement: number | null;
}

function summarise(input: RetirementCalculatorInput): Summary {
  const run = runRetirementForecast({ ...input, members: undefined });
  const c = (run.explanations[0]?.calculationInputs ?? {}) as Partial<Summary>;
  return {
    balanceAtRetirement: c.balanceAtRetirement ?? null,
    requiredCorpus: c.requiredCorpus ?? null,
    fundingGap: c.fundingGap ?? null,
    readinessPct: c.readinessPct ?? null,
    status: c.status ?? null,
    monthsUntilRetirement: c.monthsUntilRetirement ?? null,
  };
}

/**
 * `personalInput` is the calculator input the PERSONAL run uses (never modified here). `smsf` is null when the person has no SMSF:
 * the family view is then unavailable and nothing is shown.
 */
export function buildFamilyRetirementView(personalInput: RetirementCalculatorInput, smsf: FamilySmsfComponentInput | null): FamilyRetirementView {
  if (!smsf || smsf.funds.length === 0) return { available: false, reason: 'no_smsf' };

  const smsfOpening = cents(smsf.funds.reduce((s, f) => s + f.netReporting, 0));
  const smsfFlow = cents(smsf.funds.reduce((s, f) => s + f.monthlyContribution, 0));
  const personalOpening = personalInput.currentBalance;
  const personalFlow = personalInput.monthlyContribution;

  const personal = summarise(personalInput);
  const smsfOnly = summarise({ ...personalInput, currentBalance: smsfOpening, monthlyContribution: smsfFlow });
  const family = summarise({ ...personalInput, currentBalance: cents(personalOpening + smsfOpening), monthlyContribution: cents(personalFlow + smsfFlow) });

  const notes: string[] = [
    'Your personal retirement forecast above is unchanged and stays personal. This family view adds your SMSF to it so you can see the whole retirement picture.',
    smsf.funds.some((f) => f.recording === 'itemised')
      ? 'An SMSF recorded with its own assets and liabilities is counted at its derived value (assets less liabilities). The fund account row is never added on top of its holdings.'
      : 'An SMSF recorded as a net value only is counted at that net value.',
    'SMSF contributions grow the SMSF part and personal contributions grow the personal part. Each contribution is counted once.',
  ];
  if (smsfOpening < 0) notes.push('Your SMSF owes more than it holds, so it reduces the family position. This is shown as it is, not rounded up to zero.');
  if (smsf.unconvertedCount > 0) notes.push(`${smsf.unconvertedCount} SMSF line${smsf.unconvertedCount === 1 ? '' : 's'} in an unsupported currency ${smsf.unconvertedCount === 1 ? 'was' : 'were'} left out and not counted as zero.`);
  if (smsf.unknownFrequencyCount > 0) notes.push(`${smsf.unknownFrequencyCount} SMSF contribution${smsf.unknownFrequencyCount === 1 ? ' has' : 's have'} no frequency, so ${smsf.unknownFrequencyCount === 1 ? 'it is' : 'they are'} left out of the monthly flow instead of being assumed monthly.`);
  if (smsf.contributionSource === 'account_only') notes.push('SMSF contributions were read from the fund account only, because the contribution history is not available yet.');
  if (smsf.contributionSource === 'none') notes.push('No SMSF contribution is recorded, so the SMSF part is projected on its balance alone.');
  if (personal.monthsUntilRetirement === null) notes.push('Retirement timing could not be worked out, so balances are shown at the end of the forecast period.');

  const figures = (s: Summary, opening: number, flow: number): FamilyPositionFigures => ({
    opening: cents(opening),
    monthlyFlow: cents(flow),
    balanceAtRetirement: s.balanceAtRetirement,
    requiredCorpus: s.requiredCorpus,
    fundingGap: s.fundingGap,
    readinessPct: s.readinessPct,
    status: s.status,
  });

  return {
    available: true,
    currency: personalInput.currency,
    personal: figures(personal, personalOpening, personalFlow),
    smsf: {
      opening: smsfOpening,
      monthlyFlow: smsfFlow,
      balanceAtRetirement: smsfOnly.balanceAtRetirement,
      funds: smsf.funds,
      contributionSource: smsf.contributionSource,
      unconvertedCount: smsf.unconvertedCount,
      unknownFrequencyCount: smsf.unknownFrequencyCount,
    },
    family: figures(family, personalOpening + smsfOpening, personalFlow + smsfFlow),
    timing: { monthsUntilRetirement: family.monthsUntilRetirement, retirementAge: personalInput.retirementAge, retirementAgeSource: personalInput.retirementAgeSource ?? null },
    notes,
  };
}
