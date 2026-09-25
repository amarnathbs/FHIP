/**
 * AIE-1 final production completion (2026-09-25) -- SYNTHETIC fixtures for the
 * live DEV journeys, each with an INDEPENDENTLY computed expected result
 * (arithmetic by hand in the comments, never read back from the parser).
 * Every person, employer, number and address here is invented.
 */
import { buildMinimalTextPdf } from '../tests/support/buildMinimalPdf';
import { AU_FIXTURES } from '../tests/fixtures/fdh9/payslips';

/** J1 -- deterministic payslip: the certified AU-01 fixture and its oracle
 * (tests/fixtures/fdh9/payslips.ts, computed by hand there). A unique marker
 * line keeps the file hash (and so the duplicate check) unique per run. */
export function nativePayslipPdf(runTag: string): { bytes: Buffer; expected: typeof AU_FIXTURES[number]['expected'] } {
  const f = AU_FIXTURES.find((x) => x.id === 'AU-01')!;
  const lines = [...f.text.split('\n'), `Reference: ${runTag}`];
  return { bytes: buildMinimalTextPdf([lines]), expected: f.expected };
}

/**
 * J2 -- a payslip the deterministic parser CANNOT read (prose "remittance
 * advice" layout, no column table) but a reader can. Planted synthetic PII
 * lines exercise masking on the request path.
 *
 * EXPECTED (by hand):
 *   gross   = base 2,900.00 + allowance 300.00           = 3,200.00
 *   tax     = 512.00
 *   net     = 3,200.00 - 512.00 - 200.00 (salary sacrifice) = 2,488.00
 *   frequency: fortnightly (stated "for the fortnight")
 *   payment date 2026-08-15
 */
export const AI_PAYSLIP_EXPECTED = { grossPay: 3200, taxWithheld: 512, netPay: 2488, payFrequency: 'fortnightly', paymentDate: '2026-08-15' } as const;
export function aiNeededPayslipPdf(runTag: string): Buffer {
  const lines = [
    'Quillfeather Studio Pty Ltd',
    'Remittance advice for wages',
    'Name: Zelda Quarrington',
    'Employee ID: EMP-448821',
    'Tax File Number: 123 456 782',
    'Email: zelda.q@example.invalid',
    'Phone: (02) 9555 0199',
    'Paid to BSB/Account: 062-000 12345678',
    'This advice covers the fortnight ending 14 August 2026.',
    'Your wage for the fortnight came to 2900.00, plus 300.00 for tools, so 3200.00 all up before tax.',
    'We held back 512.00 for the ATO and put 200.00 into your super by salary sacrifice.',
    'That left 2488.00, which landed in your account on 15 August 2026.',
    `Reference: ${runTag}`,
  ];
  return buildMinimalTextPdf([lines]);
}

/** J3 -- the EICAR anti-malware TEST string (not malware; every scanner is
 * required to flag it). Built without a literal backslash in source so no
 * shell or heredoc can mangle it. Sent as a CSV so it passes structural
 * validation honestly and reaches the real scanner. DEV bucket only. */
export function eicarCsv(): Buffer {
  const bs = String.fromCharCode(92);
  const eicar = `X5O!P%@AP[4${bs}PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*`;
  return Buffer.from(eicar, 'ascii');
}
