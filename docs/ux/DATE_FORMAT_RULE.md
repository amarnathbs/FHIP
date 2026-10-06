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

The upload file-layout dropdown (`DATE_FORMAT_OPTIONS`) still shows a sample such as `2024-01-31` next to the plain-words label "Year first (year, month, day)": it describes the layout of the person's own file, which may genuinely be year-first.
