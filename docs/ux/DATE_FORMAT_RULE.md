# Date format rule (PO review 06-10-2026, finding F13)

PO: "I asked to change the date format globally to India or Australia but seeing this format (YYYY-MM-DD), there is no user from the country who use this format, please make sure that you don't use this format at any place across the application."

## The rule

- Every date a person reads or types is day first: **dd-mm-yyyy** for India, **dd/mm/yyyy** for Australia. Admin screens follow the same rule.
- Never year-first (yyyy-mm-dd) and never month-first (mm/dd/yyyy) in a label, placeholder, hint, message, table, PDF or e-mail.
- Machine formats stay ISO where nobody reads them: request and response bodies, API field names, files, the database.

## What to use

| Need | Use |
|---|---|
| Show a stored date | `formatDateShort(date, 'AUD' \| 'INR')` in `lib/engines/date.ts` (key from the user's country: `dateFormatKeyForCountry(country)`); inside a sentence `formatDateInText(value, currency)`; date and time `formatDateTimeShort` |
| Type a date | `components/ui/DateInput.tsx` (placeholder DD-MM-YYYY, value in and out is ISO), or `DateTextField` in `components/resources/editor/FormField.tsx` for the Resources editors. Never `<input type="date">` (it follows the browser's locale) |
| Parse typed text | `parseDateInput` in `lib/engines/dateInput.ts` (day first only, never guesses) |
| No country known (Admin lists, public pages) | the Australian shape (dd/mm/yyyy), the app-wide fallback |

## Enforced

`tests/unit/dateFormatVisibleTextGuard.test.ts` walks all of `app/`, `components/` and `lib/` and fails on year-first or month-first wording, a native date picker, a browser-locale day, an ISO string rendered in JSX text, and a raw stored date shown as text. The only exceptions are the exact machine-format lines listed in `ALLOWED_MACHINE_TOKENS` (file-format identifiers a parser reads), each re-checked so the list cannot widen silently. Negative controls prove the scanner fails on the exact placeholder from the PO screenshot.

The upload file-layout dropdown (`DATE_FORMAT_OPTIONS`) shows the plain-words label only for the year-first and month-first options ("Year first (year, month, day)", "Month first, US style (month, day, year)") and no sample date: the PO rule of 07-10-2026 is that yyyy-mm-dd must not appear anywhere visible, even to describe the layout of the person's own file. The day-first options keep their samples (31/01/2024, 31-01-2024). `tests/unit/benchmarkDataUiLogic.test.ts` enforces this.

## PO confirmations (07-10-2026)

- Public Resources pages and Admin lists show dates as **dd/mm/yyyy** (the Australian shape, the app-wide fallback) wherever no country is known; **dd-mm-yyyy** is used on India-context screens (Reference Data Quality, Look-Through, Market Index, Investment Intelligence notes). The change from "20 Aug 2026" to 20/08/2026 on Money Updates, Resources lists and the public Resources site is confirmed by the Product Owner.
- A typed ISO date (2026-08-20) is rejected by the new date fields by design (day first only).
