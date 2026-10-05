# Promo code e-mail: real Resend certification on DEV (plan only, nothing is sent by this work)

Purpose: prove, with real messages to mailboxes the operator owns, the things no hermetic test can prove: that the sender is authenticated, the message arrives, reads correctly, leaks no code outside the body, and that the provider behaves as the application assumes.

Status: PLAN AND SCRIPT SKELETON. `scripts/promo_email_resend_dev_certification.mjs` defaults to printing this plan and runs read-only DNS checks. It sends only when told to with explicit flags. It was not run as part of this work.

## 0. Preconditions

- DEV only. Never production. The script refuses a project ref that is not the DEV project and refuses to run without `--confirm-owned-mailboxes`.
- At least three mailboxes the operator owns, on different providers (for example a Gmail address, an Outlook address, and one on the sending domain itself).
- DEV Amplify environment has `RESEND_API_KEY`, the sender address variables, and the dedicated secrets (see `ENVIRONMENT_VARIABLES.md`). `PREMIUM_PROMO_EMAIL_ENABLED` is set to `true` **on DEV only**, for the duration of the test, and unset afterwards.
- The migrations 0264 to 0268 are applied on DEV and the application of this branch is deployed there.

## 1. Domain authentication (read only, can be done first)

Run `node scripts/promo_email_resend_dev_certification.mjs --dns <sending-domain> --dkim-selector <selector>`. It looks up and prints:

| Check | Expected | How to read the answer |
|---|---|---|
| SPF | exactly one TXT record starting `v=spf1` that includes the provider (Resend publishes the include value for the domain) | two SPF records is a failure |
| DKIM | a TXT or CNAME at `<selector>._domainkey.<domain>` (Resend shows the selector in its dashboard) | missing = unsigned mail |
| DMARC | a TXT record at `_dmarc.<domain>` with `p=none`, `quarantine` or `reject` and a `rua` mailbox | `p=none` is acceptable for the first certification, the PO decides the final policy |

If any check fails, stop. Fix the DNS first. The names above are the standard ones. What the provider requires for this particular domain is **UNVERIFIED** from the repository and must be read from the Resend dashboard.

## 2. The messages

Three messages per mailbox, all sent by the script with a **sample code that no admin created and that cannot be redeemed** (`ZZZZZ-ZZZZZ`). The body is the file `docs/admin/po_apply_hardening/resend_sample_body.txt`, which a test keeps equal to the real message produced by `composePromoCodeEmail`. So the certification certifies the real text.

| # | Message | What it proves |
|---|---|---|
| 1 | the sample with date wording and links | sender name, delivery, links, the English date |
| 2 | the same message sent again with the SAME idempotency key | the provider's idempotency behaviour (section 4) |
| 3 | a send with an invalid API key (a deliberately wrong key in a one-off environment variable) | failure handling: an explicit provider failure, no crash |

## 3. What to check on each received message

- It arrives in the inbox, not spam. Record the placement for each provider.
- **Sender**: the display name is `FHIP` (the address is the configured one). No other name.
- **Authentication**: open "Show original" (Gmail) or the message headers (Outlook). `Authentication-Results` must show `spf=pass`, `dkim=pass` (with the sending domain) and `dmarc=pass`. Record the three results.
- **Subject** is exactly `Your FHIP Premium access code`. The code is not in the subject.
- **Date wording**: `Please redeem it by 31 October 2026.` (the unambiguous English form). No numeric date anywhere in the message.
- **Counting wording**: "for 30 days, counting the day you redeem it".
- **Links**: the profile link points at the DEV application origin and opens the DEV Profile page. There is no tracking redirect and no other link.
- **Plain text** only: no HTML part, no images, no unsubscribe header (this is a service message, see the note in the mail).
- **No code outside the body**: in the provider dashboard (Resend, Emails) open each sent message. The code must appear only in the message body, not in the subject, the tags, the metadata or the from field. The application sends only `from`, `to`, `subject`, `text` plus an `Idempotency-Key` header; a test asserts this (`tests/unit/promoHardening/mailerTimeoutAndSample.test.ts`). The header value is `promo-code-<request key>-<code id>-<16 characters of a keyed hash>` and holds no code.
- **Logs**: search the DEV application logs for the sample code, for each mailbox address and for the API key. Expect none. (The application never logs an address or a code.)

## 4. Idempotency behaviour (to verify, not assumed)

The application sends `Idempotency-Key` on every send and also keeps its own ledger, which is the real guarantee. What the provider does with a repeated key is **UNVERIFIED** here. The test: send message 1 and message 2 with the same key (script `--repeat-key`). Expected provider behaviour (from its documentation, to be confirmed by this test): the second request returns the first message id and no second message arrives. Record: how many messages arrived, whether the returned id was the same, and how long the key is honoured (the documentation says 24 hours; confirm in the dashboard).

If the provider delivers twice, record it as a finding. The application is still safe because a repeated request key never reaches the mailer twice (database idempotency), but the finding changes the retry advice.

## 5. Failure and timeout handling

- Invalid key: the script sends message 3 with a wrong key. Expected: HTTP 401, reported by the application as `resend_http_401`, counted by the circuit breaker as a provider failure.
- Timeout: the application aborts a provider call after 10 seconds and reports `resend_timeout`. To see it, block the provider host from the DEV server for one send (operator network step) or temporarily set the timeout lower on DEV. Not required for certification if the unit test and the invalid key result are accepted (the unit test injects a timeout).
- Breaker: after five consecutive provider failures the breaker opens for 15 minutes and the next admin request shows the pause message and the code once. To prove: five sends with the wrong key (one-off environment), then one more send with the right key and read the pause message; wait 15 minutes or clear `promo_email_circuit` on DEV and send again.

## 6. Evidence to record

For each mailbox: placement, the three authentication results, the sender name, the subject, the date line, the link target, the idempotency result, a screenshot of the dashboard entry showing no code outside the body. Attach the DEV log search result. A single FAIL (an unauthenticated sender, a code outside the body, a numeric date) blocks enabling the feature on production.

## 7. After the test

Unset `PREMIUM_PROMO_EMAIL_ENABLED` on DEV. Remove any one-off wrong-key variable. The three sample messages carry no real code and need no clean-up.
