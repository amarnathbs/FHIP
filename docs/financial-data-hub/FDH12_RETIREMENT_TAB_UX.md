# FDH-12 — Retirement Tab UX

Spec sections 55, 57, 94, 146-151.

## Where it lives

```
  Input Data ▸ Retirement
  ┌──────────────────────────────────────────────────────────┐
  │  Retirement Planning        (existing — target ages)     │
  ├──────────────────────────────────────────────────────────┤
  │  Self-Managed Super Fund    (existing — SMSF section)    │
  ├──────────────────────────────────────────────────────────┤
  │  Import retirement statement            ◀── FDH-12       │
  │    jurisdiction · fund · masked member no. · period      │
  │    [ Upload and read statement ]                         │
  ├──────────────────────────────────────────────────────────┤
  │  Retirement Accounts grid   (existing — ADD/UPDATE       │
  │                              MANUALLY, unchanged)        │
  └──────────────────────────────────────────────────────────┘
```

Spec section 146's choice — **[Add/Update Manually] OR [Import Retirement
Statement]** — is realised by both routes being visible on one page. FDH-12
removes no existing affordance and is not a new top-level destination, exactly
as FDH-9 lives behind Income and FDH-10 behind Liabilities.

The import panel sits **below** the SMSF section deliberately, so the boundary
reads correctly: a self-managed fund is managed there, and an SMSF statement
uploaded here is routed back to it.

## The journey

Upload → Parse → Match member & account → Reconcile (payslip / bank /
rollover) → Review evidence → **Approve evidence** → Compare → **Apply**.

Every step before Apply is inert. The panel has no write path to
`retirement_accounts` at all — it speaks only to the FDH-12 API over `fetch()`.

## Review screen (spec 147)

Shows member, fund, masked account, period, opening balance, contributions
(employer / personal), investment earnings, fees, insurance premiums, tax,
closing balance, a plain-language reconciliation status, the activity table,
the investment-option list, and the actions.

Approval is blocked while unresolved items remain, with a count and an
explanation rather than a disabled button alone.

## Current vs Statement (spec 55, 57)

Two comparisons, deliberately distinct:

1. On the review screen, once matched: **Current / Statement / Difference** for
   the balance, with the account name.
2. On the comparison screen: a **Field / Current / Statement / Apply this
   field** table with a checkbox per field, a `please confirm` marker on
   confirmation-gated fields, and a four-way decision radio group
   (Add new / Update existing / Apply only ticked / Keep as is).

Only recommended, non-confirmation-gated fields are ticked by default —
contribution rates start unticked because they change forecast inputs.

The comparison screen states plainly:
> Your target retirement age is never changed by importing a statement.

## Payslip reconciliation UX (spec 148)

The activity table's last column is **"Matched payslip"**, showing `Yes`,
`No payslip on file`, `Amounts differ — please check (−$50.00)`, or
`More than one possible payslip — please choose`. **One financial event,
annotated** — never two.

## Rollover UX (spec 149)

Rollover legs are labelled **"Transfer in (rollover)"** and **"Transfer out
(rollover)"** — never "income" — with notes explaining the money moved between
retirement accounts rather than arriving as new money.

Every internal activity carries a note saying where the money went, so a user
never mistakes an internal movement for household cash. For example, a fee
reads: *"Deducted from your retirement balance — not a separate household
bill."*

## Error vs zero (spec 94)

`money()` renders **"Not shown on statement"** for an absent value, never
`$0.00`. The distinction is enforced at every layer: extraction returns
`undefined` rather than `'0'`; the adapter proposes no `current_balance` field
at all when the statement had none; and every failure path carries a message
naming a real next step:

| State | Message |
| --- | --- |
| Unreadable layout | "We couldn't recognise the layout... You can still add or update this account manually." |
| PDF | "PDF super statements are not yet supported... Try a CSV export from your fund, or add the account manually." |
| Scan | "This statement looks like a scan rather than a text document..." |
| SMSF | "This looks like a self-managed super fund statement. SMSFs are managed in the SMSF section." |
| Duplicate | "You have already imported this exact statement, so nothing was added again." |

## Privacy in the form (spec 87-89)

The member-number field says: *"Only the last few digits. Never enter your tax
file number."* A value containing 7+ consecutive digits is rejected by the
upload route's Zod schema, with the DB CHECK as a second refusal.

## Accessibility (spec 151)

* The panel is a `role="region"` with `aria-label` and `aria-live="polite"`, so
  phase changes are announced.
* Every table uses `<caption class="sr-only">`, `<th scope="col">` and
  `<th scope="row">`.
* Every checkbox carries an explicit `aria-label` naming the field it applies.
* Every input is wrapped in a `<label>`; the decision group is a `<fieldset>`
  with a `<legend>`.
* Statuses are stated **in words**, not by colour alone — reconciliation
  renders a sentence, and match states render text.
* Buttons are real `<button type="button">` elements in DOM order, so keyboard
  traversal follows the journey.

## Responsive (spec 150)

Every wide table is wrapped in `overflow-x-auto` with a `min-w`, so the table
scrolls inside its own container and the page body never scrolls horizontally.
Form rows use `flex-wrap`; the summary list is `grid-cols-1 sm:grid-cols-2`.

## Disclosed UX residuals

* The panel is one component covering all phases, following the FDH-9/10/11
  precedent. It has no dedicated Playwright e2e spec — consistent with FDH-9,
  FDH-10 and FDH-11, none of which shipped one either.
* Desktop/tablet/mobile rendering was certified by construction (the responsive
  classes above) and by code review, **not** by screenshots at three
  breakpoints against a running app. Disclosed rather than claimed.
