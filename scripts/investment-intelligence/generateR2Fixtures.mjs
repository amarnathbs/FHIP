#!/usr/bin/env node
// Investment Intelligence R2 — golden fixture generator (spec section 36).
//
// Produces synthetic, de-identified CAMS-style and KFintech-style CAS
// "extracted text" fixtures (the exact string shape
// lib/services/investment-intelligence/pdfExtraction.ts hands to the
// parser layer) plus an independently-authored `.expected.json` sidecar
// per fixture, describing the exact values the fixture SHOULD parse to.
//
// IMPORTANT — this generator does NOT import or call the actual parser
// (camsParser.ts / kfintechParser.ts / transactionTypeMapping.ts) to
// produce the expected values. Every expected value below is authored
// directly by hand, independently of the parsing code, specifically so
// that tests/unit/iiR2GoldenFixtures.test.ts comparing parser OUTPUT
// against these `.expected.json` files is a real test of the parser, not
// a tautology. (The one narrow exception, documented in
// R2_GOLDEN_FIXTURE_CATALOG.md, is transaction-TYPE classification, where
// the fixture author necessarily has the same RULES table in mind when
// choosing both the statement wording and the expected canonical type —
// mitigated by including an explicit rule-precedence adversarial case,
// CAMS-007/KFIN-007, where a naive/wrong rule order would misclassify.)
//
// Run: node scripts/investment-intelligence/generateR2Fixtures.mjs

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', 'lib', 'fixtures', 'investment-intelligence', 'r2-cas');

function formatIndianAmount(value, dp = 2) {
  const negative = value < 0;
  const abs = Math.abs(value);
  const [intPart, fracPart = ''] = abs.toFixed(dp).split('.');
  let other = intPart.length > 3 ? intPart.slice(0, -3) : '';
  const lastThree = intPart.length > 3 ? intPart.slice(-3) : intPart;
  if (other !== '') other = other.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  const grouped = other === '' ? lastThree : `${other},${lastThree}`;
  return (negative ? '-' : '') + grouped + (dp > 0 ? `.${fracPart}` : '');
}

function formatPlain(value, dp = 3) {
  const negative = value < 0;
  const abs = Math.abs(value);
  return (negative ? '-' : '') + abs.toFixed(dp);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dmyCams(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${String(d).padStart(2, '0')}-${MONTHS[m - 1]}-${y}`;
}
function dmyKfin(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
}

// --------------------------------------------------------------------------
// CAMS renderer
// --------------------------------------------------------------------------
function renderCams(scenario) {
  const lines = [];
  lines.push('CAMS Consolidated Account Statement');
  lines.push(`Statement Period : ${dmyCams(scenario.periodStart)} To ${dmyCams(scenario.periodEnd)}`);
  lines.push('');
  for (const folio of scenario.folios) {
    lines.push(`Folio No: ${folio.folioNumber}`);
    lines.push(`PAN: ${folio.pan}`);
    lines.push(`Name: ${folio.name}`);
    lines.push(`Holding Mode: ${folio.holdingMode ?? 'SI'}`);
    lines.push('');
    for (const scheme of folio.schemes) {
      lines.push(`AMC Name: ${scheme.amc}`);
      lines.push(`Scheme Name: ${scheme.schemeName}`);
      lines.push(`ISIN: ${scheme.isin ?? ''}`);
      lines.push(`AMFI Code: ${scheme.amfiCode ?? ''}`);
      lines.push('Registrar: CAMS');
      lines.push('');
      if (scheme.transactions.length > 0) {
        lines.push('Date          Description                              Amount(Rs.)      Units         NAV(Rs.)      Unit Balance');
        for (const t of scheme.transactions) {
          const ref = t.ref ? ` [Ref: ${t.ref}]` : '';
          const amountStr = t.indianFormat ? formatIndianAmount(t.amount) : formatPlain(t.amount, 2);
          // Fields are separated by a GUARANTEED gap (2 spaces) rather than
          // fixed-width column padding — a long description (e.g. "STP Out
          // To Nippon India Small Cap Fund") must never visually collide
          // with the amount column, which a naive padEnd(N) would do once
          // the description exceeds N characters. Real CAMS/KFintech PDFs
          // vary column widths per statement anyway; the parser's regex
          // only requires whitespace-separated fields, not fixed alignment.
          const descPadded = t.description.length < 38 ? t.description.padEnd(38) : `${t.description}  `;
          lines.push(`${dmyCams(t.date)}   ${descPadded}${amountStr}  ${formatPlain(t.units, 3)}  ${formatPlain(t.nav, 4)}  ${formatPlain(t.balanceAfter, 3)}${ref}`);
        }
        lines.push('');
      }
      if (scheme.closing) {
        const c = scheme.closing;
        const valueStr = c.indianFormat ? formatIndianAmount(c.value) : formatPlain(c.value, 2);
        lines.push(`Closing Unit Balance as on ${dmyCams(c.asOf)} : ${formatPlain(c.units, 3)} Units   Valuation : Rs. ${valueStr}   NAV as on ${dmyCams(c.asOf)} : Rs. ${formatPlain(c.nav, 4)}`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

// --------------------------------------------------------------------------
// KFintech renderer
// --------------------------------------------------------------------------
function renderKfintech(scenario) {
  const lines = [];
  lines.push('KFINTECH Consolidated Account Statement');
  lines.push(`Period : ${dmyKfin(scenario.periodStart)} to ${dmyKfin(scenario.periodEnd)}`);
  lines.push('');
  for (const folio of scenario.folios) {
    lines.push(`Folio No : ${folio.folioNumber}`);
    lines.push(`PAN : ${folio.pan}`);
    lines.push(`Investor Name : ${folio.name}`);
    lines.push(`Mode of Holding : ${folio.holdingMode ?? 'Single'}`);
    lines.push('');
    for (const scheme of folio.schemes) {
      lines.push(`AMC Name : ${scheme.amc}`);
      lines.push(`Scheme : ${scheme.schemeName}`);
      lines.push(`ISIN : ${scheme.isin ?? ''}`);
      lines.push(`AMFI Code : ${scheme.amfiCode ?? ''}`);
      lines.push('RTA : KFINTECH');
      lines.push('');
      if (scheme.transactions.length > 0) {
        lines.push('Txn Date     Transaction Type            Amount        Units      Price(NAV)   Balance Units');
        for (const t of scheme.transactions) {
          const ref = t.ref ? ` [Ref: ${t.ref}]` : '';
          const amountStr = t.indianFormat ? formatIndianAmount(t.amount) : formatPlain(t.amount, 2);
          const descPadded = t.description.length < 28 ? t.description.padEnd(28) : `${t.description}  `;
          lines.push(`${dmyKfin(t.date)}   ${descPadded}${amountStr}  ${formatPlain(t.units, 3)}  ${formatPlain(t.nav, 4)}  ${formatPlain(t.balanceAfter, 3)}${ref}`);
        }
        lines.push('');
      }
      if (scheme.closing) {
        const c = scheme.closing;
        const valueStr = c.indianFormat ? formatIndianAmount(c.value) : formatPlain(c.value, 2);
        lines.push(`Closing Balance : ${formatPlain(c.units, 3)} units as on ${dmyKfin(c.asOf)}   Market Value : Rs ${valueStr}   NAV : Rs ${formatPlain(c.nav, 4)}`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

// --------------------------------------------------------------------------
// Scenario -> expected.json shape (independent of parser code)
// --------------------------------------------------------------------------
function buildExpected(scenario, sourceKey) {
  const accounts = scenario.folios.map((f) => ({ folioNumber: f.folioNumber, holderName: f.name, holdingModeRaw: f.holdingMode ?? (sourceKey === 'cams' ? 'SI' : 'Single') }));
  const transactions = [];
  const holdings = [];
  for (const folio of scenario.folios) {
    for (const scheme of folio.schemes) {
      for (const t of scheme.transactions) {
        transactions.push({
          folioNumber: folio.folioNumber,
          scheme: scheme.schemeName,
          isin: scheme.isin || null,
          amfiSchemeCode: scheme.amfiCode || null,
          transactionDateIso: t.date,
          canonicalType: t.expectedType,
          amount: t.amount.toFixed(2),
          units: t.units.toFixed(6).replace(/0+$/, '').replace(/\.$/, '.000000').slice(0, t.units.toFixed(3).length + 3) || t.units.toFixed(3),
          nav: t.nav.toFixed(4),
          sourceReference: t.ref || null,
        });
      }
      if (scheme.closing) {
        holdings.push({
          folioNumber: folio.folioNumber,
          scheme: scheme.schemeName,
          asOfDateIso: scheme.closing.asOf,
          units: scheme.closing.units.toFixed(3),
          value: scheme.closing.value.toFixed(2),
          nav: scheme.closing.nav.toFixed(4),
        });
      }
    }
  }
  return {
    fixtureId: scenario.id,
    title: scenario.title,
    sourceKey,
    sourceConfidenceAtLeast: 0.9,
    documentTypeDetected: 'cas_statement',
    formatVersionDetected: 'detailed_v1',
    statementPeriodStartIso: scenario.periodStart,
    statementPeriodEndIso: scenario.periodEnd,
    accounts,
    transactionCount: transactions.length,
    transactions,
    holdingCount: holdings.length,
    holdings,
    notes: scenario.notes ?? null,
  };
}

// Simpler, exact unit formatting (avoid the fragile toFixed manipulation above).
function fmtUnits(n) {
  return n.toFixed(3);
}

function buildExpectedClean(scenario, sourceKey) {
  const accounts = scenario.folios.map((f) => ({ folioNumber: f.folioNumber, holderName: f.name, holdingModeRaw: f.holdingMode ?? (sourceKey === 'cams' ? 'SI' : 'Single') }));
  const transactions = [];
  const holdings = [];
  for (const folio of scenario.folios) {
    for (const scheme of folio.schemes) {
      for (const t of scheme.transactions) {
        transactions.push({
          folioNumber: folio.folioNumber,
          scheme: scheme.schemeName,
          isin: scheme.isin || null,
          amfiSchemeCode: scheme.amfiCode || null,
          transactionDateIso: t.date,
          canonicalType: t.expectedType,
          amount: t.amount.toFixed(2),
          units: fmtUnits(t.units),
          nav: t.nav.toFixed(4),
          sourceReference: t.ref || null,
        });
      }
      if (scheme.closing) {
        holdings.push({
          folioNumber: folio.folioNumber,
          scheme: scheme.schemeName,
          asOfDateIso: scheme.closing.asOf,
          units: fmtUnits(scheme.closing.units),
          value: scheme.closing.value.toFixed(2),
          nav: scheme.closing.nav.toFixed(4),
        });
      }
    }
  }
  return {
    fixtureId: scenario.id,
    title: scenario.title,
    sourceKey,
    documentTypeDetected: 'cas_statement',
    formatVersionDetected: 'detailed_v1',
    statementPeriodStartIso: scenario.periodStart,
    statementPeriodEndIso: scenario.periodEnd,
    accounts,
    transactionCount: transactions.length,
    transactions,
    holdingCount: holdings.length,
    holdings,
    notes: scenario.notes ?? null,
  };
}

void buildExpected; // superseded by buildExpectedClean — kept only to document the iteration, unused

// --------------------------------------------------------------------------
// Scenario definitions
// --------------------------------------------------------------------------
import { CAMS_SCENARIOS } from './fixtureScenariosCams.mjs';
import { KFIN_SCENARIOS } from './fixtureScenariosKfintech.mjs';

function writeFixture(dir, scenario, renderer, sourceKey) {
  mkdirSync(dir, { recursive: true });
  const text = renderer(scenario);
  const expected = buildExpectedClean(scenario, sourceKey);
  writeFileSync(join(dir, `${scenario.id}.txt`), text, 'utf8');
  writeFileSync(join(dir, `${scenario.id}.expected.json`), JSON.stringify(expected, null, 2) + '\n', 'utf8');
  console.log(`wrote ${scenario.id}`);
}

for (const s of CAMS_SCENARIOS) writeFixture(join(ROOT, 'cams'), s, renderCams, 'cams');
for (const s of KFIN_SCENARIOS) writeFixture(join(ROOT, 'kfintech'), s, renderKfintech, 'kfintech');

console.log(`Generated ${CAMS_SCENARIOS.length} CAMS + ${KFIN_SCENARIOS.length} KFintech fixtures.`);
