/**
 * M12A section 4 — the accuracy measurement harness.
 *
 * DOMAIN-AGNOSTIC BY CONSTRUCTION, AND THAT IS THE POINT. The next M12 phase
 * has to build the same kind of accuracy corpus for the Insurance adapter, and
 * the dispatch is explicit that it should reuse this rather than build a second
 * one. So nothing in this file knows what a bank statement is. It takes an
 * oracle's expected field set and expected economic items, an observed field
 * set and observed economic items, and a small set of lifecycle facts — and it
 * computes the six numbers the certification is defined in terms of. An
 * Insurance corpus supplies policy fields and premium/benefit line items
 * instead, and every metric below means exactly the same thing.
 *
 * WHAT EACH METRIC MEANS HERE. These definitions are stated once, in code,
 * rather than restated informally per report:
 *
 *   FIELD PRECISION  = correct observed fields / all observed fields.
 *     A field the system asserts that the oracle does not have, or asserts with
 *     the wrong value, is a false positive. Asserting fewer fields cannot
 *     improve precision, because the denominator is what was asserted.
 *
 *   FIELD RECALL     = correct observed fields / all oracle fields.
 *     A field the oracle has and the system never produced is a false negative.
 *
 *   ECONOMIC TRANSACTION PRECISION = observed economic items that match an
 *     oracle item exactly on EVERY economic dimension / all observed items.
 *     "Economic" means money-moving: an item that agrees on date and amount but
 *     disagrees on direction is not a near miss, it is wrong, and it is counted
 *     as wrong.
 *
 *   ECONOMIC TRANSACTION RECALL = matched oracle items / all oracle items.
 *
 *   UNEXPLAINED ECONOMIC OMISSION = an oracle economic item the system did not
 *     produce AND did not account for. A row the system refuses to read is not
 *     an omission if the system SAYS SO — by blocking the run, by raising an
 *     unresolved item, or by refusing the document outright. It is an omission
 *     when money printed on the page disappears and the run stays acceptable.
 *     This is the metric the certification requires to be exactly zero, and it
 *     is deliberately the only one whose definition depends on the lifecycle
 *     rather than on the extracted values alone.
 *
 *   FALSE ACCEPT = a case the oracle says must not be acceptable, that
 *     nonetheless reached an acceptable state.
 *
 *   FALSE CANONICAL WRITE = a canonical write that happened for a case where
 *     no explicit acceptance was performed, or for a case the oracle says must
 *     never be written at all. Required to be exactly zero.
 */

export interface FieldObservation {
  fieldName: string;
  /** Normalised to a string for comparison; `null` means "asserted as absent". */
  value: string | null;
}

/** One money-moving item. Every property is part of the identity. */
export interface EconomicItem {
  key: string | number;
  date: string | null;
  amount: number;
  direction: string;
  balance: number | null;
}

export interface CaseMeasurementInput {
  caseId: string;
  scenario: string;
  expectedFields: FieldObservation[];
  observedFields: FieldObservation[];
  expectedEconomic: EconomicItem[];
  observedEconomic: EconomicItem[];
  /**
   * Oracle keys the system did not produce but which it DID account for —
   * supplied by the caller from the system's own reported behaviour (run
   * blocked, unresolved item raised, document refused), never assumed.
   */
  omissionsAccountedFor: (string | number)[];
  /** Oracle's verdict: may this case ever be acceptable? */
  oracleAcceptable: boolean;
  /** Did the system actually reach an acceptable state? */
  observedAcceptable: boolean;
  /** Did any canonical write occur at all for this case? */
  canonicalWriteOccurred: boolean;
  /** Was an explicit acceptance genuinely performed before that write? */
  explicitAcceptPerformed: boolean;
}

export interface CaseMeasurement {
  caseId: string;
  scenario: string;
  fieldTruePositives: number;
  fieldFalsePositives: number;
  fieldFalseNegatives: number;
  fieldPrecision: number | null;
  fieldRecall: number | null;
  economicMatched: number;
  economicObserved: number;
  economicExpected: number;
  economicPrecision: number | null;
  economicRecall: number | null;
  unexplainedOmissions: (string | number)[];
  falseAccept: boolean;
  falseCanonicalWrite: boolean;
  /** Every concrete disagreement, so a failure is readable without a debugger. */
  fieldDisagreements: { fieldName: string; expected: string | null; observed: string | null | undefined }[];
  economicDisagreements: { key: string | number; expected: EconomicItem | null; observed: EconomicItem | null }[];
}

export interface CorpusMeasurement {
  caseCount: number;
  cases: CaseMeasurement[];
  fieldPrecision: number | null;
  fieldRecall: number | null;
  economicPrecision: number | null;
  economicRecall: number | null;
  /** cases falsely accepted / cases the oracle says must not be acceptable */
  falseAcceptRate: number | null;
  falseAcceptCount: number;
  falseAcceptDenominator: number;
  /** cases with a canonical write that should not have had one / all cases */
  falseCanonicalWriteRate: number;
  falseCanonicalWriteCount: number;
  totalUnexplainedOmissions: number;
}

function ratio(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null; // undefined, not 1.0 — never flattered
  return numerator / denominator;
}

function sameEconomicItem(a: EconomicItem, b: EconomicItem): boolean {
  return a.date === b.date && a.amount === b.amount && a.direction === b.direction && a.balance === b.balance;
}

export function measureCase(input: CaseMeasurementInput): CaseMeasurement {
  const observedByName = new Map(input.observedFields.map((f) => [f.fieldName, f.value]));
  const expectedByName = new Map(input.expectedFields.map((f) => [f.fieldName, f.value]));

  let fieldTruePositives = 0;
  const fieldDisagreements: CaseMeasurement['fieldDisagreements'] = [];

  for (const [fieldName, expectedValue] of expectedByName) {
    if (!observedByName.has(fieldName)) {
      fieldDisagreements.push({ fieldName, expected: expectedValue, observed: undefined });
      continue;
    }
    const observedValue = observedByName.get(fieldName)!;
    if (observedValue === expectedValue) fieldTruePositives += 1;
    else fieldDisagreements.push({ fieldName, expected: expectedValue, observed: observedValue });
  }
  for (const [fieldName, observedValue] of observedByName) {
    if (!expectedByName.has(fieldName)) {
      fieldDisagreements.push({ fieldName, expected: null, observed: observedValue });
    }
  }

  const fieldFalsePositives = observedByName.size - fieldTruePositives;
  const fieldFalseNegatives = expectedByName.size - fieldTruePositives;

  const expectedEconomicByKey = new Map(input.expectedEconomic.map((e) => [e.key, e]));
  const observedEconomicByKey = new Map(input.observedEconomic.map((e) => [e.key, e]));
  let economicMatched = 0;
  const economicDisagreements: CaseMeasurement['economicDisagreements'] = [];

  for (const [key, expected] of expectedEconomicByKey) {
    const observed = observedEconomicByKey.get(key) ?? null;
    if (observed && sameEconomicItem(expected, observed)) economicMatched += 1;
    else economicDisagreements.push({ key, expected, observed });
  }
  for (const [key, observed] of observedEconomicByKey) {
    if (!expectedEconomicByKey.has(key)) economicDisagreements.push({ key, expected: null, observed });
  }

  const accountedFor = new Set(input.omissionsAccountedFor.map(String));
  const unexplainedOmissions = [...expectedEconomicByKey.keys()].filter((key) => {
    const observed = observedEconomicByKey.get(key);
    const produced = observed !== undefined && sameEconomicItem(expectedEconomicByKey.get(key)!, observed);
    return !produced && !accountedFor.has(String(key));
  });

  const falseAccept = !input.oracleAcceptable && input.observedAcceptable;
  const falseCanonicalWrite = input.canonicalWriteOccurred && (!input.explicitAcceptPerformed || !input.oracleAcceptable);

  return {
    caseId: input.caseId,
    scenario: input.scenario,
    fieldTruePositives,
    fieldFalsePositives,
    fieldFalseNegatives,
    fieldPrecision: ratio(fieldTruePositives, observedByName.size),
    fieldRecall: ratio(fieldTruePositives, expectedByName.size),
    economicMatched,
    economicObserved: observedEconomicByKey.size,
    economicExpected: expectedEconomicByKey.size,
    economicPrecision: ratio(economicMatched, observedEconomicByKey.size),
    economicRecall: ratio(economicMatched, expectedEconomicByKey.size),
    unexplainedOmissions,
    falseAccept,
    falseCanonicalWrite,
    fieldDisagreements,
    economicDisagreements,
  };
}

export function measureCorpus(cases: CaseMeasurement[], oracleAcceptableFlags: boolean[]): CorpusMeasurement {
  const sum = (pick: (c: CaseMeasurement) => number) => cases.reduce((acc, c) => acc + pick(c), 0);

  const fieldTp = sum((c) => c.fieldTruePositives);
  const fieldObserved = fieldTp + sum((c) => c.fieldFalsePositives);
  const fieldExpected = fieldTp + sum((c) => c.fieldFalseNegatives);

  const economicMatched = sum((c) => c.economicMatched);
  const economicObserved = sum((c) => c.economicObserved);
  const economicExpected = sum((c) => c.economicExpected);

  const falseAcceptDenominator = oracleAcceptableFlags.filter((a) => !a).length;
  const falseAcceptCount = cases.filter((c) => c.falseAccept).length;
  const falseCanonicalWriteCount = cases.filter((c) => c.falseCanonicalWrite).length;

  return {
    caseCount: cases.length,
    cases,
    fieldPrecision: ratio(fieldTp, fieldObserved),
    fieldRecall: ratio(fieldTp, fieldExpected),
    economicPrecision: ratio(economicMatched, economicObserved),
    economicRecall: ratio(economicMatched, economicExpected),
    falseAcceptRate: ratio(falseAcceptCount, falseAcceptDenominator),
    falseAcceptCount,
    falseAcceptDenominator,
    falseCanonicalWriteRate: cases.length === 0 ? 0 : falseCanonicalWriteCount / cases.length,
    falseCanonicalWriteCount,
    totalUnexplainedOmissions: sum((c) => c.unexplainedOmissions.length),
  };
}

export function formatPercent(value: number | null): string {
  if (value === null) return 'n/a';
  return `${(value * 100).toFixed(2)}%`;
}

/** A markdown table of one corpus run — pasted verbatim into the closure
 * report rather than retyped, so the report and the run cannot drift. */
export function formatCorpusTable(result: CorpusMeasurement): string {
  const header =
    '| Case | Scenario | Field P | Field R | Econ P | Econ R | Unexplained omissions | False accept | False canonical write |\n' +
    '|---|---|---|---|---|---|---|---|---|';
  const rows = result.cases.map(
    (c) =>
      `| ${c.caseId} | ${c.scenario} | ${formatPercent(c.fieldPrecision)} | ${formatPercent(c.fieldRecall)} | ` +
      `${formatPercent(c.economicPrecision)} | ${formatPercent(c.economicRecall)} | ${c.unexplainedOmissions.length} | ` +
      `${c.falseAccept ? '**YES**' : 'no'} | ${c.falseCanonicalWrite ? '**YES**' : 'no'} |`,
  );
  const totals =
    `| **ALL ${result.caseCount}** | — | **${formatPercent(result.fieldPrecision)}** | **${formatPercent(result.fieldRecall)}** | ` +
    `**${formatPercent(result.economicPrecision)}** | **${formatPercent(result.economicRecall)}** | ` +
    `**${result.totalUnexplainedOmissions}** | **${formatPercent(result.falseAcceptRate)}** | ` +
    `**${formatPercent(result.falseCanonicalWriteRate)}** |`;
  return [header, ...rows, totals].join('\n');
}
