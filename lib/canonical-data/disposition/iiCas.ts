/**
 * Field dispositions -- India CAS (CAMS / KFintech) through Investment
 * Intelligence. ALREADY CLOSED (matrix section 4, IICAS rows): process ->
 * portfolio-truth certify -> publish into `investments` ("Imported via
 * Investment Intelligence"). Registry only; no behaviour change. Owner: WP-12
 * (which must not alter the India engine).
 */
import { A, B, C, D, rows, type Row } from './build';
import type { RegistryFile } from './types';

const IIS = 'Investment Intelligence screens; Investments tab once published';

const ACCOUNT: Row[] = [
  ['folioNumber', A, 'ii_accounts.folio_number', IIS],
  ['accountNumberMasked', A, 'ii_accounts.account_number_masked', IIS],
  ['amcName', A, 'ii_accounts.institution_name', IIS],
  ['holderName', C, 'ii_* account evidence (holder)', IIS],
  ['panMasked', C, 'ii_* account evidence (masked PAN only, never full)', IIS],
  ['jointHolders', C, 'ii_* account evidence (joint holders)', IIS],
  ['holdingModeRaw', C, 'ii_* account evidence (holding mode as printed)', IIS],
  ['raw', D, 'in-memory parse provenance (never logged)'],
];

const INSTRUMENT: Row[] = [
  ['rawSchemeName', A, 'ii_instruments.instrument_name', IIS],
  ['normalisedSchemeName', D, 'scheme resolution key'],
  ['amcName', A, 'ii_instruments (fund house)', IIS],
  ['planType', A, 'ii_instruments.plan_type', IIS],
  ['optionType', A, 'ii_instruments.option_type', IIS],
  ['isin', A, 'ii_instrument_identifiers (ISIN)', IIS],
  ['amfiSchemeCode', A, 'ii_instrument_identifiers (AMFI code)', IIS],
];

const TXN: Row[] = [
  ['folioNumber', D, 'links the transaction to its ii_accounts row'],
  ['scheme', A, 'ii_instruments', IIS],
  ['transactionDateIso', B, 'ii_transactions.transaction_date', IIS],
  ['rawTransactionTypeText', C, 'ii_transactions.source_description', IIS],
  ['canonicalType', B, 'ii_transactions.transaction_type', IIS],
  ['classificationConfidence', D, 'parse quality'],
  ['amountScaled', B, 'ii_transactions.gross_amount', IIS],
  ['unitsScaled', B, 'ii_transactions.units', IIS],
  ['navScaled', B, 'ii_transactions.price_per_unit', IIS],
  ['balanceUnitsAfterScaled', D, 'reconciliation input only (never stored as a transaction field)'],
  ['sourceReference', D, 'ii_transactions fingerprint input'],
  ['sourceDescription', C, 'ii_transactions.source_description', IIS],
];

const HOLDING: Row[] = [
  ['folioNumber', D, 'links the holding to its ii_accounts row'],
  ['scheme', A, 'ii_instruments', IIS],
  ['asOfDateIso', A, 'ii_holding_snapshots.as_of_date', IIS],
  ['unitsScaled', A, 'ii_holding_snapshots.units', IIS],
  ['valueScaled', A, 'ii_holding_snapshots.value', IIS],
  ['navScaled', A, 'ii_holding_snapshots.source_nav', IIS],
];

const META: Row[] = [
  ['sourceKey', D, 'ii source document detection'],
  ['sourceConfidence', D, 'ii source document detection'],
  ['documentTypeDetected', D, 'ii source document detection'],
  ['formatVersionDetected', D, 'ii source document detection'],
  ['statementPeriodStartIso', C, 'ii source document statement period', 'Investment Intelligence > documents'],
  ['statementPeriodEndIso', C, 'ii source document statement period', 'Investment Intelligence > documents'],
  ['statementAsOfDateIso', C, 'ii source document as-of date', 'Investment Intelligence > documents'],
  ['extractionMethod', D, 'ii parse run'],
];

export const iiCasRegistry: RegistryFile = {
  id: 'iiCas',
  ownerWp: 'WP-12',
  OPEN_GAP_CEILING: 0,
  entries: [
    ...rows('ii_cas', 'ts_interface', 'ii:parsers/types.ts#ParsedAccountRecord', ACCOUNT),
    ...rows('ii_cas', 'ts_interface', 'ii:parsers/types.ts#ParsedInstrumentRecord', INSTRUMENT),
    ...rows('ii_cas', 'ts_interface', 'ii:parsers/types.ts#ParsedTransactionRecord', TXN),
    ...rows('ii_cas', 'ts_interface', 'ii:parsers/types.ts#ParsedHoldingRecord', HOLDING),
    ...rows('ii_cas', 'ts_interface', 'ii:parsers/types.ts#ParseMetadata', META),
  ],
};
