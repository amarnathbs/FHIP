// II-PC3 — one-off smoke test proving buildEncryptedTextPdf produces a REAL
// RC4-encrypted PDF that real `pdf-parse` (the production extraction
// library) correctly rejects without a password / with a wrong password,
// and correctly decrypts with the right one. Not a vitest test (this lives
// under scripts/, run manually via `npx tsx`) — the permanent vitest
// coverage for this lives in tests/unit/iiPc3GoldenFixtureGate.test.ts.
import { buildEncryptedTextPdf } from '../../../tests/support/buildEncryptedCamsPdf';
import { PDFParse, PasswordException } from 'pdf-parse';

async function main() {
  const result = buildEncryptedTextPdf(
    [
      ['CAMS Consolidated Account Statement', 'Statement Period : 01-Jan-2025 To 30-Jun-2025', 'Folio No: 1201040009999', 'PAN: ABCDE1234F', 'Name: TEST USER'],
      ['Registrar: CAMS', 'Date          Description        Amount(Rs.)   Units    NAV(Rs.)   Unit Balance'],
    ],
    'qualif-pw-2026'
  );
  console.log('PDF bytes length:', result.bytes.length);

  try {
    const p1 = new PDFParse({ data: result.bytes });
    await p1.getText();
    console.log('FAIL: expected PasswordException with no password');
  } catch (e) {
    console.log('no-password case ->', e instanceof PasswordException ? 'PasswordException (expected)' : `unexpected error: ${e}`);
  }

  try {
    const p2 = new PDFParse({ data: result.bytes, password: 'wrong-password' });
    await p2.getText();
    console.log('FAIL: expected PasswordException with wrong password');
  } catch (e) {
    console.log('wrong-password case ->', e instanceof PasswordException ? 'PasswordException (expected)' : `unexpected error: ${e}`);
  }

  try {
    const p3 = new PDFParse({ data: result.bytes, password: 'qualif-pw-2026' });
    const r = await p3.getText();
    console.log('correct-password case -> SUCCESS, text:');
    console.log(JSON.stringify(r.text));
  } catch (e) {
    console.log('FAIL: correct password threw', e);
  }
}

main();
