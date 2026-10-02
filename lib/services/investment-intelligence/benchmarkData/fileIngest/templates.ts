// Downloadable CSV templates and the plain-language upload help. The templates
// contain NO comment lines (a comment would corrupt a re-upload) and use
// obviously illustrative values; the example benchmark key is deliberately not
// in any catalogue, so an unedited template can never be published.
import { DEFAULT_LIMITS } from './types';

export interface UploadTemplate {
  fileName: string;
  description: string;
  csv: string;
}

const CRLF = '\r\n';

export const BENCHMARK_UPLOAD_TEMPLATES: Record<'single_date_value' | 'multi_key_date_value' | 'provider_nse_tri_export', UploadTemplate> = {
  single_date_value: {
    fileName: 'benchmark_single_template.csv',
    description: 'One benchmark: choose the benchmark, source, return type, currency and date format on the upload form. Dates in this template are written day first, like 01-01-2024, so choose the file date format "Day-month-year (DD-MM-YYYY)".',
    csv: ['date,value', '01-01-2024,1000.00', '02-01-2024,1001.50', '03-01-2024,1002.25'].join(CRLF) + CRLF,
  },
  multi_key_date_value: {
    fileName: 'benchmark_multi_template.csv',
    description: 'Several benchmarks in one file. Every benchmark_key must exactly match a key in the benchmark catalogue and share the return type and currency chosen on the form. Dates are written day first, like 01-01-2024, so choose the file date format "Day-month-year (DD-MM-YYYY)".',
    csv: [
      'benchmark_key,date,value',
      'EXAMPLE_KEY_REPLACE_ME,01-01-2024,1000.00',
      'EXAMPLE_KEY_REPLACE_ME,02-01-2024,1001.50',
      'EXAMPLE_OTHER_KEY_REPLACE_ME,01-01-2024,2000.00',
    ].join(CRLF) + CRLF,
  },
  provider_nse_tri_export: {
    fileName: 'provider_nse_tri_export_template.csv',
    description: 'The shape of an NSE Indices total-return export (Date, Total Returns Index), with dates written like 02 Jan 2024. The column names are taken from public conventions and are not verified against a live download.',
    csv: ['Date,Total Returns Index', '01 Jan 2024,1000.00', '02 Jan 2024,1001.50', '03 Jan 2024,1002.25'].join(CRLF) + CRLF,
  },
};

export interface HelpSection {
  title: string;
  body: string;
}

function mib(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

export const UPLOAD_HELP_SECTIONS: HelpSection[] = [
  {
    title: 'Upload an index level, not a percentage return',
    body: 'Each value must be the index LEVEL on that date, for example 23,456.70. A daily or monthly percentage return, a change in points, or a growth-of-100 figure is a different thing and is rejected. Values with a percent sign are refused.',
  },
  {
    title: 'Price, total return and net total return are different series',
    body: 'A price index ignores dividends. A total return index (TRI) adds back dividends before tax; a net total return index adds them back after tax. They have different levels for the same date. Pick the one that matches the benchmark, and never mix them in one upload. The return type you choose must match the benchmark in the catalogue.',
  },
  {
    title: 'Currency and dates must be correct',
    body: 'Choose the currency the levels are quoted in. Choose the date format the file uses, in words and with an example (day-month-year like 01-10-2026, month-day-year, year first, or an Excel date number): the system never guesses, because a date such as 03-04-2024 is two different days depending on the order. Dates must be plain calendar dates; a date with a time or a timezone is refused. Two-digit years are refused. Dates in the future are refused.',
  },
  {
    title: 'Uploading a file does not give you permission to use the data',
    body: 'Having the file is not the same as being allowed to publish it. Publishing needs an approved entitlement (usage permission) record for this source and for the dates in the file. Ticking a box saying you have permission is not enough on its own.',
  },
  {
    title: 'Which files are accepted',
    body: `Only .csv and .xlsx data files are accepted. PDF factsheets are not accepted as daily history. Macro-enabled workbooks (.xlsm, .xlsb) and older .xls files are refused. Files must be at most ${mib(DEFAULT_LIMITS.maxBytes)} and ${DEFAULT_LIMITS.maxRows.toLocaleString('en-US')} data rows. CSV files must be UTF-8 (or UTF-16 with a byte-order mark).`,
  },
  {
    title: 'Excel files: choose the sheet, and use values, not formulas',
    body: 'For an .xlsx file you must pick the sheet to process; the system never picks one for you, and it tells you which other sheets were not processed. Cells in the date, value and key columns must hold values: any cell with a formula is rejected, even if it shows a number. Copy the cells and paste them as values. Check whether your workbook uses the 1900 or 1904 date system, because the same Excel date number is four years and a day apart between them.',
  },
  {
    title: 'Hidden rows are shown to you, not silently dropped',
    body: 'Rows hidden in the spreadsheet are listed in the preview. By default they are not processed; you can choose to include them, and then you must acknowledge that you did. Hidden sheets are listed too.',
  },
  {
    title: 'What happens to weekends, big moves and gaps',
    body: 'Rows dated on a Saturday or Sunday are kept but flagged for review, because special trading sessions exist but weekend carry-forward values do not. A day-over-day move above 10% is flagged, not rejected, since large real moves happen. A jump of more than five times (or below a fifth) is flagged as a possible rebasing or unit change. Gaps of more than three missing weekdays are flagged. Missing dates are never filled in or estimated.',
  },
  {
    title: 'Corrections need their own permission',
    body: 'New-history mode adds dates that are not published yet; if a file disagrees with a level that is already published, it is rejected. To change a published level, use correction mode: it needs the separate correction permission, shows before and after values, and keeps the earlier value on record.',
  },
  {
    title: 'Errors block publishing',
    body: 'If any row has a hard error, nothing is published. You can download the list of errors as a CSV, fix the file and upload it again. Only rows that pass every check are ever staged.',
  },
];
