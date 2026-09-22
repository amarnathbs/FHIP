import { camsFolioStatementParser } from '@/lib/services/investment-intelligence/parsers/camsFolioStatementParser';

const text = [
  'FOLIO DETAILS',
  '',
  'FOLIO NUMBER : DEBUG-FOLIO',
  'Name : Debug Holder',
  '',
  'Statement Date : 18-Sep-2026',
  '',
  'SUMMARY OF HOLDINGS',
  'Scheme Name          Cost of Investment    Unit Balance    NAV Date       NAV        Market Value',
  'HDFC Flexi Cap Fund - Growth   21000.00   11.000000   18-Sep-2026   2242.7570   24670.33',
  '',
  'FINANCIAL TRANSACTIONS',
  '',
  'HDFC Flexi Cap Fund - Growth ISIN CODE : INF179K01UT0',
  'DATE          TRANSACTION TYPE                Amount        NAV         PRICE       UNITS         BALANCE UNITS',
  '01-Aug-2026   Opening Balance                                                        10.000000',
  '15-Aug-2026   Purchase                          2100.00   2100.0000   2100.0000   1.000000   11.000000 [Ref: DEBUG-P001]',
].join('\n');

const replacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);
console.log('canHandle:', JSON.stringify(camsFolioStatementParser.canHandle(text)));
const accounts = camsFolioStatementParser.parseAccounts(text);
console.log('accounts:', JSON.stringify(accounts, replacer, 2));
const txns = camsFolioStatementParser.parseTransactions(text, accounts);
console.log('transactions:', JSON.stringify(txns, replacer, 2));
const holdings = camsFolioStatementParser.parseHoldings(text, accounts);
console.log('holdings:', JSON.stringify(holdings, replacer, 2));
