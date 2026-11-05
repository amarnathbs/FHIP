# Premium automatic categorisation (05-11-2026) -- what it does and how to switch it on

No database change and no migration. It is code plus three Amplify environment variables, all default OFF.

## What a Premium person sees

1. They import a bank statement and open its review page as before.
2. The page says "Categorising and counting your statement..." for up to a minute, once.
3. A box "Categorised automatically" then says what was counted: how many as income, how many as spending, **how many as moves that are not counted** (transfers, loans, cash, investments), how many came from AI (and how many of those were best guesses), and how many still need them.
4. Everything the run could place is already approved and counts toward income, spending and Monthly Surplus. The person edits what is wrong.
5. **Undo, so I can change it** withdraws every approval on that statement (categories are kept). The page is then exactly the manual review. The automatic run never starts again on that statement by itself.

A Free person, or any environment with the switch off, sees the review page exactly as before.

## What it decides, line by line

| Line | What happens |
|---|---|
| Recognised by the rules (merchant, built-in rules, repeating salary or loan payer) | Counted under that category. |
| Money out to a business the rules did not recognise | Sent to AI (masked, digits removed, business wording only). AI always gives its closest category; a low-confidence answer is kept and counted as a "best guess"; "unknown" is filed as **Other spending** (counted, visible). |
| Payment to a person (Osko, PayID, transfer wording, or a line that is just a person's name such as "U RANASINGHE C") | **Never sent to AI** (names inside bank lines are not covered by the masking). Out: Payments to People (spending). Nothing readable at all: Other spending. |
| Money in that nothing recognised | Never sent to AI. Filed as Income > Other Income. |
| Wording that says "transfer to savings" and similar | The category the review already suggests (Own-Account Transfer). |
| A large proposed amount (5,000 or more), a possible duplicate, a pending refund or transfer match, any blocking check | **Never approved automatically.** Listed for the person, exactly as before. |
| Money out to a business when the AI could not be asked (switch off, daily limit, outage) | Left for the person. Nothing is guessed on the AI's behalf. |

Audit: every automatic approval is recorded with actor "system"; there is one "started" marker and one "completed" event with counts only (no payee, description or category choice). Undo is recorded as the person's action.

## Switching it on (DEV first)

Set on the Amplify environment (these three all start with `AIE_`, which `amplify.yml` already forwards):

```
AIE_BANK_AUTO_CATEGORISE_ENABLED=true      # the new switch: counts the rules' answers and the fixed answers automatically
AIE_BANK_CATEGORISE_AI_ENABLED=true        # the AI part (needs the switch below and the real malware scan as well)
AIE_AI_FALLBACK_ENABLED=true               # the shared AI kill switch every AI call in the app checks
```

With only the first one on, nothing reaches the AI: the rules and the fixed answers are counted, and the business payments only the AI could place wait for the person.

The AI part also needs the OpenAI key already used by the other AI features, a Premium entitlement for the person, and stays under the existing per-person daily cost cap and the global cost ledger.

## One thing to know before enabling on production

The first time a Premium person opens the review page of a statement that is still waiting, the run starts for it -- including statements imported before the switch was turned on. Undo is available on each.

## Measured on the PO's two real NAB statements (05-11-2026, real OpenAI call, gpt-4o-mini, about 0.05 cent)

593 lines, 588 matched to the PO's AI-categorised reference. After the rules, the repeating-payer rule, the fixed answers and the AI:
- no line left unplaced;
- the same bucket (income / spending / not counted / refund) as the reference on 580 of 588 (98.6%); the 8 others are refunds the reference files as refunds and we file as Other Income;
- the same category as the reference's on 534 of 588 (90.8%). 22 more are spending in the right bucket but filed as Other spending because the AI answered unknown.

The run also found and fixed two defects before this was ever switched on: the model answered with a category's display name instead of its key (now accepted when it is exactly an offered name, and the prompt asks for the key), and a person's name inside a bank line reached the provider (now never sent). It also taught the rules the holder's own name cut off by the bank's 20-character name field ("AMARNATH SURENDRA BE"), which had been counted as spending instead of an own-account transfer.
