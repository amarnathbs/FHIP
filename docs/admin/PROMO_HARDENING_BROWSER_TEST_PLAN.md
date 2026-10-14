# Promo and Premium hardening: browser certification plan and readiness (item 12)

Status: PLAN PLUS READINESS. No browser session was run against DEV in this work (no operator session tokens are available to the agent, and credentials are never minted). What IS done: the screens were changed to the shared Admin components, the dates were made day-first, and a source-contract test (`tests/unit/promoHardeningSourceContract.test.ts`, section "item 12") pins the properties that can be checked without a browser. Everything in the table below that needs eyes is for the DEV pass.

Screens: `/admin/entitlements/promo-codes` (component `PromoCodesClient`), `/admin/entitlements` (component `PremiumEntitlementsClient`), the Profile page Plans section (`BillingPanel`) and the app-wide reminder banner (`PremiumAccessNotice`).

## Operators needed (positive and negative)

| Operator | Capabilities | Used to prove |
|---|---|---|
| A | `can_manage_promo_codes` only | promo screen works; entitlement screen redirects to the dashboard |
| B | `can_manage_premium_entitlements` only | entitlement screen works; promo screen redirects; no override panel |
| C | A and B together, no override | both screens; **still no override panel** |
| D | B and `can_override_entitlement_limits` | override panel appears at a limit |
| E | Super Admin (an `admin_users` row) with no capability | neither screen is listed in the menu; both URLs redirect; `/api/admin/me` shows all three capabilities false |
| F | an ordinary user | Profile redemption; reminder banner and expiry summary text |
| G | a second ordinary user whose address is unverified | bound-code refusal |

## Promo codes screen (operator A)

| # | State to certify | Steps | Pass when |
|---|---|---|---|
| P1 | Create, generated code | leave Code blank, 30 days, max 5, expiry 90 days ahead, Create code | the notice shows the code ONCE with the words "shown only this once"; the list row shows only a masked hint such as `AB******YZ`; reload: the code is nowhere on the page |
| P2 | Create, admin-entered code | type `summer-2k26 pass` | accepted; the same text in another case or spacing is refused as a duplicate; an invalid character (O, 0, I, L, 1) is refused with the alphabet message |
| P3 | Finite versus unlimited | set max 1, then tick Unlimited | the number box disables when Unlimited is ticked; neither is ever chosen silently |
| P4 | Expiry versus no expiry | type the date as DD-MM-YYYY, then tick No expiry | the date box disables; a past date is refused; the hint under the box shows DD-MM-YYYY |
| P5 | Access length wording | read the field label and the notice | "counting the day of redemption"; the notice says redeemed today the access would end on the date shown day-first (30 days from 5 October 2026 ends 3 November 2026) |
| P6 | Disabled and exhausted rows | disable a code with a reason under 10 characters, then a valid one; redeem a one-use code | Confirm disable stays disabled until 10 characters; the row shows Disabled or Exhausted; neither shows a Disable button |
| P7 | E-mail with a recipient | tick nothing, add one address | a purpose box appears and the button stays disabled until the purpose has 10 characters |
| P8 | E-mail switched off (default) | submit with an address and a purpose | message "Email sending is switched off. Copy the code and send it yourself." and the code shown once |
| P9 | Replacement and e-mail | on an active row choose "Generate a replacement code and email it", give address and purpose | a NEW code (different hint); the old row is unchanged; a fourth replacement of the same code in a day is refused with the limit message |
| P10 | Partial failure | send to three addresses where one is rejected (use the DEV provider with one invalid mailbox) | the result lists "Recipient N: e-mail sent" or "could not be sent" per address; only the failed recipient's code is shown; refresh the page: the codes are gone |
| P11 | Status after refresh | use "Check the delivery status of an earlier e-mail request" with the stored key and the same addresses | per address sent, failed or "outcome not recorded"; never a code |
| P12 | Repeat submit | double-click the submit button | one code, one set of e-mails; the second request shows the duplicate message with per recipient status |
| P13 | Circuit breaker message | with the breaker open (clear after the test) | "paused for a few minutes" and the code shown once |
| P14 | Confirmation text and audit | open the Audit trail table | create, disable and redeem events show the actor and a masked hint only |
| P15 | Responsive | 375 px wide (phone) and 768 px (tablet) | no horizontal page scroll; the tables scroll inside their own box; every button is reachable; the form is one column |
| P16 | Keyboard and screen reader | Tab through the form; use a screen reader on the status area | every control has a visible label; focus order follows the page; the success message is announced politely and an error assertively (shared status component); the checkboxes are operable with Space |

## Premium access screen (operators B, C, D)

| # | State | Pass when |
|---|---|---|
| E1 | Search and select a free user | the manage section shows the state; Grant with a 10 character reason works; the maximum end date shown is today plus 364 ("365 days counting today") |
| E2 | Extend five times | each works; the sixth shows the extension-limit message and the Extend button is disabled (operators B and C see no override panel) |
| E3 | Revoke then Grant repeatedly | after ten admin grants and extensions in total the Grant is refused with the lifetime-limit message; the message says a revoke does not reset it |
| E4 | Override (operator D only) | at the limit the override panel appears; a reason under 20 characters keeps the button disabled; success; the history shows the action; an alert row exists (`select * from admin_monitoring_events where event_type = 'premium_limit_override'`); a high-severity row |
| E5 | Override not needed | operator D tries the override on a user with no limit hit | refused with "an override is not needed" |
| E6 | Capability negative | operators B and C open the same user at a limit | no override panel is rendered; a direct POST with `override: true` returns 403 |
| E7 | Paid user | select a user with an active paid plan | the manage section says it is protected; no button changes it |
| E8 | Expiry summary | read "This month" | dates are day-first (dd/mm/yyyy); counts per source; no export button |
| E9 | Responsive, keyboard, screen reader | same as P15 and P16 | same |

## Profile and banner (operators F and G)

| # | State | Pass when |
|---|---|---|
| U1 | Redeem a generated code | the plan shows "Premium (promo code, ends <date>)" with the date day-first; a second redemption of the same code gives "You have already used this code." |
| U2 | Unusable codes | a wrong, disabled, expired and exhausted code all read exactly "This code cannot be used." |
| U3 | Bound code, matching verified address | works |
| U4 | Bound code, unverified address (operator G) | "This code cannot be used." (same message as any other unusable code) |
| U5 | Bound code after an address change | change the account address, then try: "This code cannot be used." until an admin issues a new one |
| U6 | Paid subscriber | "You already have an active paid Premium subscription..." and nothing changes |
| U7 | Reminder banner | with an entitlement ending in 25 days the banner says so, with the end date day-first; at 5 days a more urgent banner replaces it (one notice at a time); dismiss is remembered per threshold |
| U8 | Rate limit | eleven wrong attempts in 15 minutes: "Too many attempts..." |

## What the source-contract test already pins (no browser needed)

Every form control has a label; both Admin screens use the shared `AdminActionStatus` live region; no native date picker or locale formatter; the list renders only `code_hint`; every table sits in an `overflow-x-auto` wrapper; the override panel is rendered only for a capability read from `/api/admin/me` that fails closed; the capability routes never use the bare `requireAdmin`; Super Admin does not imply any of the three capabilities.

## Readiness

The two screens and the Profile panel are ready for this pass once the migrations 0264 to 0268 are applied on DEV and the secrets are set. Findings from the pass go in the report section 18.12.
