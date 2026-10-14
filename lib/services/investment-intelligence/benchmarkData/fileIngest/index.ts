// Public API of the historical-benchmark file-ingest library (pure).
export * from './types';
export { inspectUpload, decodeCsvBytes, sniffContent, readZipEntries, tryReadZipEntries, openZip, ZipReadError } from './fileInspection';
export type { InspectInput, InspectResult, UploadKind } from './fileInspection';
export { parseCsvText, detectDelimiter } from './csvReader';
export type { CsvDelimiter, CsvParseOptions, CsvParseResult } from './csvReader';
export { listWorkbookSheets, readWorksheet, excelSerialToIsoDate, formatCodeIsDate, columnLetters } from './xlsxReader';
export type { SheetInfo, XlsxCell, XlsxRow, WorksheetResult, ReadWorksheetOptions, CellKind } from './xlsxReader';
export { parseMarketDate } from './dateParsing';
export type { DateParseResult } from './dateParsing';
export { parseLevel, MAX_DECIMALS, MAX_LEVEL_EXCLUSIVE } from './numberParsing';
export type { LevelParseResult } from './numberParsing';
export { PROVIDER_LAYOUTS, resolveLayout, matchRegisteredLayouts, nearestLayouts, normaliseHeaderName } from './layouts';
export type { ProviderLayout, ResolvedLayout, ResolvedMapping, LayoutResolution } from './layouts';
export {
  validateUpload,
  csvToTable,
  xlsxToTable,
  VALIDATOR_VERSION,
  MIN_MARKET_DATE,
  LARGE_MOVE_FRACTION,
  SCALE_RATIO_HIGH,
  SCALE_RATIO_LOW,
  GAP_WEEKDAY_THRESHOLD,
} from './validator';
export type {
  TableCell,
  TableRow,
  UploadTable,
  StagedRow,
  StagedRowFlag,
  ValidationIssue,
  ValidationResult,
  Acknowledgement,
  BenchmarkSummary,
} from './validator';
export { buildValidationErrorCsv, neutraliseCsvCell } from './errorCsv';
export { BENCHMARK_UPLOAD_TEMPLATES, UPLOAD_HELP_SECTIONS } from './templates';
export type { UploadTemplate, HelpSection } from './templates';
export { readUploadToTable } from './readUpload';
export type { ReadUploadInput, ReadUploadResult } from './readUpload';
