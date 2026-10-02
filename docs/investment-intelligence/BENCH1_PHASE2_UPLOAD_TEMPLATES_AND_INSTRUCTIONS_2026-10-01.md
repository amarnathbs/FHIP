# BENCH-1 Phase 2 - Upload templates and instructions

The downloadable templates are served by `GET /api/admin/investment-intelligence/benchmark-data/templates/<name>` (any benchmark-data capability) and defined in `lib/services/investment-intelligence/benchmarkData/fileIngest/templates.ts`. The help text shown in the Upload tab is `UPLOAD_HELP_SECTIONS` in the same file.

| Template | File shape | Notes |
|---|---|---|
| `single_date_value` | `date,value` | Benchmark, source, return type, currency and date format are chosen in the form. Example dates are written day first (like 01-01-2024), so choose the file date format "Day-month-year (DD-MM-YYYY)". Dates typed into the admin screens are DD-MM-YYYY too; the API still carries ISO. |
| `multi_key_date_value` | `benchmark_key,date,value` | Every key must exist in the catalogue and share the variant and currency chosen on the form. The example keys are deliberately NOT in any catalogue, so an unedited template can never be published. |
| `provider_nse_tri_export` | `Date,Total Returns Index` (dates like `02 Jan 2024`) | A recognised provider shape. The header sets for provider exports come from public conventions and are **not verified against a live download**; anything not matching a registered layout needs an explicit column mapping (never inferred). |

Templates contain no comment lines (a comment would corrupt a re-upload) and obviously illustrative values.

## What every uploader must know (also shown in the app)

* **A level, not a return.** Each value is the index level on that date (for example 23,456.70). Percentage returns, point changes and growth-of-100 figures are rejected; a `%` sign is refused.
* **Price, TRI and net TRI are different series** with different levels. The variant you pick must equal the catalogue benchmark's variant; a "Total Returns Index" column declared as price is refused.
* **Currency and dates must be right.** Pick the date format explicitly; `03/04/2024` is never guessed; timestamps and timezones are refused; two-digit years and future dates are refused.
* **Uploading a file does not establish usage permission.** Publication needs an approved entitlement record for the exact benchmark, variant and currency, covering ingestion and storage for the date range.
* **XLSX:** choose the sheet explicitly; formula cells in required columns are rejected; hidden rows and other sheets are disclosed; Excel 1900/1904 date systems are explicit options (the 1900 leap-year-bug serial 60 is rejected). XLSM/macros, encrypted workbooks, PDFs and non-UTF-8 text are refused.
* **Numbers:** choose the locale (plain / en `12,345.67` / Indian `1,23,456.78` / eu `12.345,67`); at most 6 decimals; zero, negative, NaN, infinity are refused.
* **Missing dates stay missing.** Nothing is interpolated or synthesised. Gaps longer than 3 weekdays, weekend rows, moves above 10% and suspected rebasing are flagged for explicit acknowledgement, not rejected.
* **Corrections** use correction mode, need the correction permission and a reason, and keep the old level as a revision.

Limits: 5 MB, 20,000 rows, 200 zip entries, 50 MB uncompressed, 100:1 compression ratio (all configurable in `DEFAULT_LIMITS`).
