# Release order note: this release sits on top of Premium-only uploads (15-10-2026)

Written when the stack `r1 table layout -> r2 Premium-only uploads -> r3 this branch` was assembled. It changes how the
production proof in `05_PRODUCTION_PROOF_PROCEDURE_AND_EVIDENCE.md` is read. Nothing here is PRODUCTION-VERIFIED.

## What a Free person sees once both are live

1. The five import panels (bank statement, payslip, AU investment statement, liability statement, retirement statement) show
   the locked-upload notice and no file form. The request guard added by Premium-only uploads answers first, before this
   branch's AI gate is ever reached. A Free person therefore never sees an "AI reading is a Premium feature" message for a
   file they could not upload.
2. This branch's refusal message ("AI-assisted reading is a Premium feature ...") is still reachable, but only by a person
   whose plan ended after they uploaded: the document was admitted while Premium, its first processing run is allowed to
   finish, and if the deterministic reader cannot read it the AI step is refused with that message. This is the sensible
   reading of both rules and needs no code change.

## What changes in the production proof (file 05)

| Journey | As written | With Premium-only uploads live |
|---|---|---|
| 5 (F1 uploads the bank letter PDF) | upload runs, ends "could not read", Premium message shown | F1 cannot upload: expect the locked-upload notice and **no** `upload-sessions` row. This proves the upload lock, not the AI refusal. To see the AI refusal itself, use an account that uploaded while Premium and was then set to Free before the first process run (a lapsed-Premium document), and expect `premium_required` in `V01` and no provider row in `V02` |
| 10 (F1 uploads again, then is upgraded) | upload works after the grant | before the grant F1 sees the locked notice; after the grant the same screen shows the form. The "no sign-out needed" check still applies |
| X1 (former pilot e-mail, not Premium) | same as F1 | same as F1: locked upload |

Everything for Premium accounts (journeys 1 to 4, 6 to 9, 11, 12) is unchanged.

## Deployment order and the environment steps

Premium-only uploads needs no environment change and no SQL. This branch still needs its Amplify steps exactly as in
`00_README_PO_ORDERED_STEPS.md`: stage with `AIE_AI_FALLBACK_ENABLED=false` and `II_AI_FALLBACK_ENABLED=false`, push, then open
one class at a time. The AI reading also still requires `AIE_REAL_MALWARE_SCAN_ENABLED=true`; with the scan flag off the AI
step refuses with a clear reason and the deterministic import is unaffected.
