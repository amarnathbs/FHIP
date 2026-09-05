// II-PC3-C1 — Golden real-variant fixture: RED/GREEN gate before mass
// regeneration of the Q01-Q12 real-variant qualification pack.
//
// Reproduces every structural characteristic recorded in
// docs/investment-intelligence/II_PC3_REAL_CAMS_VARIANT_FINGERPRINT.md:
// an AMC transition (folio A's scheme closes, folio B's begins — this
// grammar has no nameable AMC label at all, per fingerprint section 4),
// a folio, the combined scheme/ISIN line, the transaction table in the
// real column order (Date/Amount/Price/Units/Type, no Description), one
// Stamp Duty AND one STT row in the real fee-row shape (fingerprint
// section 8/9 — Date+Amount+Type only, NO Price/Units/Balance fields),
// the real closing/balance grammar, and a page continuation with no
// header reprint. Fully synthetic economics — invented names, PAN-shaped-
// but-fake identifiers, folios, amounts. Nothing here is copied from the
// real statement; only its abstract SHAPE (already zero-real-value in the
// fingerprint doc) is reproduced.
//
// Run: npx tsx scripts/investment-intelligence/pc3/pc3GoldenRealVariantFixture.ts

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { buildMinimalTextPdf } from '../../../tests/support/buildMinimalPdf';

const OUT_DIR = join(__dirname, '..', '..', '..', 'lib', 'fixtures', 'investment-intelligence', 'pc3-cams-real-variant');
mkdirSync(OUT_DIR, { recursive: true });

const folioA = '9312040001201';
const folioB = '9312040001202';
const schemeALine = 'Composite Growth Opportunities Fund - Growth (Direct Plan) - ISIN: INF999K01ZZ9(Advisor: ARN00999) Registrar : CAMS';
const schemeBLine = 'Diversified Value Builder Fund - Growth (Regular Plan) - ISIN: (Advisor: ARN01111) Registrar : CAMS';
const headerLine = 'Date          Amount           Price        Units       Transaction Type                    Unit Balance';

// Fee/tax row shape per fingerprint section 8/9: Date, Amount+attached
// marker (no space), Type label, trailing marker — NO Price/Units/Balance
// fields at all (structurally shorter than the full economic row below).
const page1 = [
  'CQAL-STMT-TRK-2026-CAMS-GOLDENV1',
  'Consolidated Account Statement',
  'Statement Period : 01-Jan-2025 To 30-Jun-2025',
  '',
  `Folio No: ${folioA}`,
  `PAN: PCQAL0013F`,
  '',
  schemeALine,
  '',
  headerLine,
  '01-Feb-2025   10,000.00        119.7605     83.500      Purchase                             83.500   [Ref: PC3G-001]',
  '05-Feb-2025   50.00***   Stamp Duty   ***',
  '10-Feb-2025   120.00###   STT   ###',
  '15-Mar-2025   5,000.00         121.3600     41.200      SIP Purchase                         124.700  [Ref: PC3G-004]',
];
// Page 2: table continues RAW, zero header/label reprint, then closes and
// a new folio/scheme begins (the "AMC transition" this grammar expresses).
const page2 = [
  '30-Jun-2025   5,000.00         124.6300     40.120      SIP Purchase                         245.280  [Ref: PC3G-005]',
  '',
  'Closing Unit Balance: 245.280 Total Cost Value: Rs. 30,000.00',
  '',
  `Folio No: ${folioB}`,
  `PAN: PCQAL0014F`,
  '',
  schemeBLine,
  '',
  headerLine,
  '01-Mar-2025   8,000.00         200.0000     40.000      Purchase                             40.000   [Ref: PC3G-006]',
  '',
  'Closing Unit Balance: 40.000 Total Cost Value: Rs. 8,000.00',
];

const text = [page1.join('\n'), page2.join('\n')].join('\n-- 1 of 2 --\n');
writeFileSync(join(OUT_DIR, 'pc3-golden-real-variant.txt'), text, 'utf8');
const pdf = buildMinimalTextPdf([page1, page2]);
writeFileSync(join(OUT_DIR, 'pc3-golden-real-variant.pdf'), pdf);
console.log('wrote pc3-golden-real-variant (.txt, .pdf [2 real PDF pages])');
