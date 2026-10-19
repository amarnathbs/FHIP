/**
 * Builders for the AI "facts" a faithful (and a deliberately faulty) model reading of the corpus documents would return, built from the
 * hand-written corpus expected values (scripts/pdf_routes_corpus.ts) and validated against the REAL adapter schemas, so a builder can never
 * drift from the contract. Used by the service-level tests with a faked provider; the real provider is exercised only on DEV.
 */
import {
  liabilityStatementDocumentFactsSchema,
  type LiabilityStatementDocumentFacts,
} from '@/lib/aie/adapters/liability/schema';
import { retirementDocumentFactsSchema, type RetirementDocumentFacts } from '@/lib/aie/adapters/retirement/schema';
import { auInvestmentDocumentFactsSchema, type AuInvestmentDocumentFacts } from '@/lib/aie/adapters/auInvestment/schema';
import type { InvestmentExpected, LiabilityExpected, RetirementExpected } from '../../../scripts/pdf_routes_corpus';

const dec = (n: number) => n.toFixed(2);
const text = (value: string | null) => ({ value, missingReasonCode: value === null ? ('not_present_on_document' as const) : null });
const date = (value: string | null | undefined) => ({ value: value ?? null, missingReasonCode: value ? null : ('not_present_on_document' as const) });
const moneyF = (n: number | null | undefined) => ({ value: n === null || n === undefined ? null : dec(n), missingReasonCode: n === null || n === undefined ? ('not_present_on_document' as const) : null });

export interface LiabilityFactsTweaks {
  dropActivityAmounts?: number[];
  addActivity?: { activityType: LiabilityStatementDocumentFacts['activities'][number]['activityType']; activityDate: string; amount: string };
  closingBalance?: number | null;
}

export function liabilityFacts(e: LiabilityExpected, tweaks: LiabilityFactsTweaks = {}): LiabilityStatementDocumentFacts {
  const activities = e.activities
    .filter((a) => !(tweaks.dropActivityAmounts ?? []).includes(a.amount))
    .map((a) => ({
      activityType: a.type,
      activityDate: a.date,
      amount: dec(a.amount),
      descriptionRaw: null,
      merchantRaw: null,
      principalComponent: null,
      interestComponent: null,
      feeComponent: null,
    }));
  if (tweaks.addActivity) activities.push({ ...tweaks.addActivity, descriptionRaw: null, merchantRaw: null, principalComponent: null, interestComponent: null, feeComponent: null });
  return liabilityStatementDocumentFactsSchema.parse({
    schemaVersion: '1',
    documentMissingReasonCode: null,
    institutionName: text(e.institution),
    maskedIdentifier: text(`****${e.last4}`),
    statementPeriodStart: date(e.periodStart),
    statementPeriodEnd: date(e.periodEnd),
    statementDate: date(e.statementDate),
    dueDate: date(e.dueDate),
    openingBalance: moneyF(e.opening),
    closingBalance: moneyF(tweaks.closingBalance === undefined ? e.printedClosing : tweaks.closingBalance),
    creditLimit: moneyF(e.creditLimit),
    minimumPayment: moneyF(e.minimumPayment),
    interestRate: { value: e.interestRate === undefined ? null : String(e.interestRate), missingReasonCode: e.interestRate === undefined ? 'not_present_on_document' : null },
    allActivitiesListed: true,
    activities,
  });
}

export interface RetirementFactsTweaks {
  dropActivityAmounts?: number[];
  inventedFeesTotal?: number;
}

export function retirementFacts(e: RetirementExpected, tweaks: RetirementFactsTweaks = {}): RetirementDocumentFacts {
  const credit = new Set(['EMPLOYER_CONTRIBUTION', 'PERSONAL_CONTRIBUTION', 'INVESTMENT_EARNINGS']);
  void credit;
  return retirementDocumentFactsSchema.parse({
    schemaVersion: '1',
    documentMissingReasonCode: null,
    fundName: text(e.fund),
    maskedAccountIdentifier: text(`****${e.last4}`),
    statementDate: date(null),
    statementStartDate: date(e.periodStart),
    statementEndDate: date(e.periodEnd),
    openingBalance: moneyF(e.opening),
    closingBalance: moneyF(e.printedClosing),
    employerContributions: moneyF(e.employer),
    personalContributions: moneyF(e.personal),
    salarySacrifice: moneyF(e.salarySacrifice),
    governmentContributions: moneyF(e.government),
    rolloversIn: moneyF(e.rolloversIn),
    rolloversOut: moneyF(null),
    withdrawals: moneyF(e.withdrawals),
    pensionPayments: moneyF(e.pensionPayments),
    investmentEarnings: moneyF(e.earnings),
    fees: moneyF(tweaks.inventedFeesTotal ?? e.fees),
    insurancePremiums: moneyF(e.insurance),
    tax: moneyF(e.tax),
    activities: e.activities
      .filter((a) => !(tweaks.dropActivityAmounts ?? []).includes(a.amount))
      .map((a) => ({
        activityType: a.type,
        amount: dec(a.amount),
        activityDate: a.date,
        descriptionRaw: null,
        employerNameRaw: null,
        isSummaryTotal: false,
        isYearToDate: false,
      })),
    positions: e.options.map((o) => ({
      optionNameRaw: o.name,
      assetClassRaw: null,
      units: String(o.units),
      unitPrice: String(o.unitPrice),
      marketValue: dec(o.value),
      valuationDate: e.periodEnd,
    })),
  });
}

export interface InvestmentFactsTweaks {
  inventedHolding?: { securityNameRaw: string; quantity: string; marketValue: string };
}

export function investmentFacts(e: InvestmentExpected, tweaks: InvestmentFactsTweaks = {}): AuInvestmentDocumentFacts {
  const holdings: Array<{ securityNameRaw: string; tickerRaw: string | null; isin: string | null; quantity: string; unitPrice: string | null; marketValue: string | null; valuationDate: string | null }> = e.holdings.map((h) => ({
    securityNameRaw: h.name,
    tickerRaw: h.code,
    isin: null,
    quantity: String(h.quantity),
    unitPrice: String(h.price),
    marketValue: dec(h.value),
    valuationDate: e.date ?? null,
  }));
  if (tweaks.inventedHolding) holdings.push({ securityNameRaw: tweaks.inventedHolding.securityNameRaw, tickerRaw: null, isin: null, quantity: tweaks.inventedHolding.quantity, unitPrice: null, marketValue: tweaks.inventedHolding.marketValue, valuationDate: e.date ?? null });
  return auInvestmentDocumentFactsSchema.parse({
    schemaVersion: '1',
    documentMissingReasonCode: null,
    institutionName: text(e.institution),
    statementDate: date(e.date),
    statementPeriodStart: date(e.periodStart),
    statementPeriodEnd: date(e.periodEnd),
    allRowsListed: true,
    holdings,
    transactions: e.transactions.map((t) => ({
      transactionType: t.type as AuInvestmentDocumentFacts['transactions'][number]['transactionType'],
      tradeDate: t.date,
      settlementDate: null,
      securityNameRaw: null,
      tickerRaw: t.code,
      quantity: t.quantity === null ? null : String(t.quantity),
      unitPrice: t.price === null ? null : String(t.price),
      amount: dec(t.amount),
      brokerage: t.brokerage === null ? null : dec(t.brokerage),
    })),
  });
}
