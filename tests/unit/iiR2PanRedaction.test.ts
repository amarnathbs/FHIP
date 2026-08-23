import { describe, it, expect } from 'vitest';
import { parseExtractedDocument } from '@/lib/services/investment-intelligence/parsers/registry';
import { redactPanFromLine } from '@/lib/services/investment-intelligence/parsers/textUtils';

// Spec sections 16/34: "Full PAN must not appear in logs" / "do not log
// full PAN". ParsedAccountRecord.raw retains the verbatim source block for
// provenance but must NEVER contain a full, unmasked PAN — proactively
// fixed (not merely "currently unused downstream so it's fine") after
// discovering during a security review pass that the raw block, as
// originally written, DID include the unredacted PAN line.

describe('redactPanFromLine', () => {
  it('masks a PAN value on a "PAN: value" line', () => {
    expect(redactPanFromLine('PAN: ABCDE1234F')).toBe('PAN: ABCDE****F');
  });
  it('masks a PAN value on a "PAN : value" line (KFintech spacing)', () => {
    expect(redactPanFromLine('PAN : ABCDE1234F')).toBe('PAN : ABCDE****F');
  });
  it('leaves a non-PAN line unchanged', () => {
    expect(redactPanFromLine('Name: RAHUL SHARMA')).toBe('Name: RAHUL SHARMA');
  });
});

describe('ParsedAccountRecord.raw never contains a full unmasked PAN (CAMS + KFintech)', () => {
  it('CAMS: the parsed account block never contains the full PAN digits, only the masked form', () => {
    const text = [
      'CAMS Consolidated Account Statement',
      'Statement Period : 01-Jan-2025 To 30-Jun-2025',
      '',
      'Folio No: 1201040000123',
      'PAN: ABCDE1234F',
      'Name: RAHUL SHARMA',
      'Holding Mode: SI',
      '',
      'AMC Name: HDFC Mutual Fund',
      'Scheme Name: HDFC Flexi Cap Fund - Growth (Direct Plan)',
      'ISIN: INF179K01YW8',
      'AMFI Code: 118834',
      'Registrar: CAMS',
    ].join('\n');
    const result = parseExtractedDocument(text);
    const accounts = result.detection.parser!.parseAccounts(text);
    expect(accounts[0].panMasked).toBe('ABCDE****F');
    expect(accounts[0].raw).not.toContain('ABCDE1234F');
    expect(accounts[0].raw).toContain('ABCDE****F');
  });

  it('KFintech: the parsed account block never contains the full PAN digits, only the masked form', () => {
    const text = [
      'KFINTECH Consolidated Account Statement',
      'Period : 01/01/2025 to 30/06/2025',
      '',
      'Folio No : 7654321/00',
      'PAN : ABCDE1234F',
      'Investor Name : ANIL KUMAR',
      'Mode of Holding : Single',
      '',
      'AMC Name : SBI Mutual Fund',
      'Scheme : SBI Bluechip Fund - Growth (Regular Plan)',
      'ISIN : INF200K01UP0',
      'AMFI Code : 103504',
      'RTA : KFINTECH',
    ].join('\n');
    const result = parseExtractedDocument(text);
    const accounts = result.detection.parser!.parseAccounts(text);
    expect(accounts[0].panMasked).toBe('ABCDE****F');
    expect(accounts[0].raw).not.toContain('ABCDE1234F');
  });
});
