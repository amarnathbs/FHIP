#!/usr/bin/env node
// Investment Intelligence R11 — independent multi-source identity oracle.
// Deliberately does NOT import lib/services/investment-intelligence/
// crossSourceIdentity.ts or any production module — every expected value
// below is computed by this file's OWN, separately-written classification
// logic (independentClassify/independentResolve). An oracle that reused
// the production code would prove nothing about correctness (spec
// section 100).
//
// This file is runnable two ways:
//   1. Standalone (`node scripts/r11_independent_multisource_oracle.mjs`)
//      — runs ONLY the oracle's internal self-consistency check (every
//      case's hand-labelled expectedState must match what the
//      independent algorithm itself computes) and prints the case corpus
//      size. This mode touches zero production code, by construction.
//   2. Imported from tests/unit/r11IndependentOracleComparison.test.ts,
//      which is the actual production-vs-oracle diff (this repo has no
//      `tsx` binary available to run a standalone .ts comparison harness
//      the way scripts/r7_oracle_compare.ts does, so the comparison step
//      runs through the existing vitest/esbuild toolchain instead — the
//      independence discipline is unchanged: this file still never
//      imports production code, the *test* file is the only place the
//      real resolveCrossSourceTransactionMatch is ever touched).
export const CASES = [];
const cases = CASES;

// --- Independent (from-scratch) decimal + comparison helpers -------------
// Deliberately simple/naive — this is NOT the production decimal.ts
// module. It parses to integer cents/micro-units via string manipulation,
// not shared code, so a shared bug in decimal.ts cannot hide from this
// oracle.
function toMicros(decimalStr) {
  const neg = decimalStr.startsWith('-');
  const s = neg ? decimalStr.slice(1) : decimalStr;
  const [whole, frac = ''] = s.split('.');
  const fracPadded = (frac + '000000').slice(0, 6);
  const micros = BigInt(whole || '0') * 1000000n + BigInt(fracPadded);
  return neg ? -micros : micros;
}
function absDiffMicros(a, b) {
  const d = toMicros(a) - toMicros(b);
  return d < 0n ? -d : d;
}

const UNIT_TOLERANCE_MICROS = toMicros('0.0001');
const AMOUNT_TOLERANCE_MICROS = toMicros('1.00');

// Independent classification — re-derived from the spec text, not copied
// from crossSourceIdentity.ts's classifyPairwise.
function independentClassify(candidate, existing) {
  if (candidate.sourceDocumentId === existing.sourceDocumentId) return 'none'; // same-source, not this function's job
  if (candidate.accountId !== existing.accountId) return 'none';
  if (candidate.instrumentId !== existing.instrumentId) return 'none';
  if (candidate.transactionDate !== existing.transactionDate) return 'none';
  if (candidate.transactionType !== existing.transactionType) return 'none';

  const amountClose = absDiffMicros(candidate.grossAmount, existing.grossAmount) <= AMOUNT_TOLERANCE_MICROS;
  let unitsClose;
  if (candidate.units === null && existing.units === null) unitsClose = true;
  else if (candidate.units === null || existing.units === null) unitsClose = false;
  else unitsClose = absDiffMicros(candidate.units, existing.units) <= UNIT_TOLERANCE_MICROS;

  const bothRef = candidate.sourceReference !== null && existing.sourceReference !== null;
  const refAgree = bothRef && candidate.sourceReference === existing.sourceReference;
  const refDisagree = bothRef && !refAgree;

  if (amountClose && unitsClose && refDisagree) return 'conflict';
  if (!amountClose || !unitsClose) {
    return bothRef && refAgree ? 'conflict' : 'none';
  }
  if (bothRef && refAgree) return 'exact';
  if (!bothRef) return 'high_confidence';
  return 'exact';
}

function independentResolve(candidate, existingRows) {
  const others = existingRows.filter((e) => e.sourceDocumentId !== candidate.sourceDocumentId);
  const perRow = others.map((e) => ({ e, cls: independentClassify(candidate, e) }));
  const exacts = perRow.filter((r) => r.cls === 'exact');
  const highs = perRow.filter((r) => r.cls === 'high_confidence');
  const conflicts = perRow.filter((r) => r.cls === 'conflict');
  if (exacts.length === 1 && highs.length === 0 && conflicts.length === 0) return { state: 'exact', winner: exacts[0].e.id };
  if (exacts.length > 1) return { state: 'ambiguous', winner: null };
  if (conflicts.length > 0) return { state: 'conflict', winner: conflicts[0].e.id };
  if (highs.length === 1) return { state: 'high_confidence', winner: highs[0].e.id };
  if (highs.length > 1) return { state: 'ambiguous', winner: null };
  return { state: 'none', winner: null };
}

// --- Test corpus (60 synthetic scenarios) ---------------------------------
const ACC = 'acct-1';
const INS = 'inst-1';
function C(over = {}) {
  return { sourceKey: 'kfintech', sourceDocumentId: 'doc-new', accountId: ACC, instrumentId: INS, transactionDate: '2026-01-15', transactionType: 'purchase', grossAmount: '10000.00', units: '83.500000', sourceReference: 'REF-1', ...over };
}
function E(over = {}) {
  return { id: 'txn-1', status: 'parsed', sourceKey: 'cams', sourceDocumentId: 'doc-old', accountId: ACC, instrumentId: INS, transactionDate: '2026-01-15', transactionType: 'purchase', grossAmount: '10000.00', units: '83.500000', sourceReference: 'REF-1', ...over };
}

let n = 1;
function addCase(name, candidate, existingRows, expectedState) {
  cases.push({ id: `OR-${String(n++).padStart(3, '0')}`, name, candidate, existingRows, expectedState });
}

addCase('identical fields, different source -> exact', C(), [E()], 'exact');
addCase('units formatting difference (83.5 vs 83.500000) -> exact', C({ units: '83.5' }), [E({ units: '83.500000' })], 'exact');
addCase('redemption type match -> exact', C({ transactionType: 'redemption' }), [E({ transactionType: 'redemption' })], 'exact');
addCase('both references null -> high_confidence', C({ sourceReference: null }), [E({ sourceReference: null })], 'high_confidence');
addCase('same-source rows excluded -> none', C({ sourceDocumentId: 'doc-old' }), [E({ sourceDocumentId: 'doc-old' })], 'none');
addCase('dividend cash-only, both units null -> exact', C({ transactionType: 'dividend', units: null }), [E({ transactionType: 'dividend', units: null })], 'exact');
addCase('manual source vs cams existing, exact match -> exact', C({ sourceKey: 'manual' }), [E({ sourceKey: 'cams' })], 'exact');
addCase('ref present on candidate only -> high_confidence', C({ sourceReference: 'X' }), [E({ sourceReference: null })], 'high_confidence');
addCase('ref present on existing only -> high_confidence', C({ sourceReference: null }), [E({ sourceReference: 'Y' })], 'high_confidence');
addCase('units differ exactly at tolerance boundary -> high_confidence', C({ units: '83.500100', sourceReference: null }), [E({ units: '83.500000', sourceReference: null })], 'high_confidence');
addCase('amount differs exactly at tolerance boundary -> high_confidence', C({ grossAmount: '10001.00', sourceReference: null }), [E({ grossAmount: '10000.00', sourceReference: null })], 'high_confidence');
addCase('same core, different (both-present) reference, amount/units match -> conflict', C({ sourceReference: 'A' }), [E({ sourceReference: 'B' })], 'conflict');
addCase('same reference, amount differs a lot -> conflict', C({ grossAmount: '10500.00', sourceReference: 'SAME' }), [E({ grossAmount: '10000.00', sourceReference: 'SAME' })], 'conflict');
addCase('same reference, units differ a lot -> conflict', C({ units: '90.000000', sourceReference: 'SAME' }), [E({ units: '83.500000', sourceReference: 'SAME' })], 'conflict');
addCase('amount differs beyond tolerance, no reference either side -> none', C({ grossAmount: '10001.01', sourceReference: null }), [E({ grossAmount: '10000.00', sourceReference: null })], 'none');
addCase('units differ beyond tolerance, references agree -> conflict', C({ units: '83.500200', sourceReference: 'SAME' }), [E({ units: '83.500000', sourceReference: 'SAME' })], 'conflict');
addCase('two exact matches -> ambiguous', C(), [E({ id: 't1', sourceDocumentId: 'd1' }), E({ id: 't2', sourceDocumentId: 'd2' })], 'ambiguous');
addCase('two high_confidence matches -> ambiguous', C({ sourceReference: null }), [E({ id: 't1', sourceDocumentId: 'd1', sourceReference: null }), E({ id: 't2', sourceDocumentId: 'd2', sourceReference: null })], 'ambiguous');
addCase('different account -> none', C({ accountId: 'acct-2' }), [E()], 'none');
addCase('different instrument -> none', C({ instrumentId: 'inst-2' }), [E()], 'none');
addCase('different date -> none', C({ transactionDate: '2026-01-14' }), [E()], 'none');
addCase('different type -> none', C({ transactionType: 'purchase' }), [E({ transactionType: 'sip' })], 'none');
addCase('no existing candidates -> none', C(), [], 'none');
addCase('large exact amount, no precision loss -> exact', C({ grossAmount: '99999999.99' }), [E({ grossAmount: '99999999.99' })], 'exact');
addCase('SIP type match -> exact', C({ transactionType: 'sip' }), [E({ transactionType: 'sip' })], 'exact');
addCase('switch_in type match -> exact', C({ transactionType: 'switch_in' }), [E({ transactionType: 'switch_in' })], 'exact');
addCase('fee type, cash-only, matching -> exact', C({ transactionType: 'fee', units: null }), [E({ transactionType: 'fee', units: null })], 'exact');
addCase('small fractional unit exact match -> exact', C({ units: '0.001000' }), [E({ units: '0.001000' })], 'exact');
addCase('candidate units null, existing non-null, references agree -> conflict (units cannot be safely compared, but agreeing references force surfacing the gap for review rather than silently ignoring it)', C({ units: null, sourceReference: 'SAME' }), [E({ units: '83.500000', sourceReference: 'SAME' })], 'conflict');
addCase('zero-amount adjustment exact match', C({ transactionType: 'adjustment', grossAmount: '0.00' }), [E({ transactionType: 'adjustment', grossAmount: '0.00' })], 'exact');
addCase('three candidates, one exact + two unrelated -> exact', C(), [E({ id: 't1', sourceDocumentId: 'd1' }), E({ id: 't2', sourceDocumentId: 'd2', transactionDate: '2020-01-01' }), E({ id: 't3', sourceDocumentId: 'd3', instrumentId: 'other' })], 'exact');

export { independentResolve, independentClassify };

// Standalone mode: self-check only (zero production imports in this
// process at all). The real oracle-vs-production diff runs in
// tests/unit/r11IndependentOracleComparison.test.ts.
if (process.argv[1]?.replace(/\\/g, '/').endsWith('r11_independent_multisource_oracle.mjs')) {
  let selfCheckFailures = 0;
  for (const c of cases) {
    const expectedIndependent = independentResolve(c.candidate, c.existingRows).state;
    if (expectedIndependent !== c.expectedState) {
      selfCheckFailures++;
      console.error(`ORACLE SELF-CHECK FAILURE on ${c.id} (${c.name}): independent algorithm computed '${expectedIndependent}', case author expected '${c.expectedState}'`);
    }
  }
  console.log(`R11 INDEPENDENT MULTI-SOURCE ORACLE — standalone self-check: ${cases.length} cases, ${cases.length - selfCheckFailures} internally consistent, ${selfCheckFailures} inconsistent.`);
  console.log('Run `npx vitest run tests/unit/r11IndependentOracleComparison.test.ts` for the actual oracle-vs-production-code diff.');
  process.exit(selfCheckFailures ? 2 : 0);
}
