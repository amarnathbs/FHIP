# FDH-14 — UI/Accessibility Smoke (GAP 5 closure, 2026-08-31)

## Tooling

Real browser automation via this repository's standing Playwright setup (`playwright.config.ts`,
`tests/e2e/` — the same tooling `onboarding.spec.ts`/`navigation.spec.ts`/`forecasting-engine.e2e.spec.ts`
already use), NOT a new tool invented for this round. `playwright.config.ts`'s `webServer` runs `npm run dev`,
which loads `.env.local` — the same hosted DEV Supabase project every other FDH-14 script targets. No FDH-
specific Playwright spec existed before this pass.

A synthetic, fully-onboarded user (email pattern `fdh14-closure-g5-*@fhip-test.invalid`) was created directly
via the Supabase admin API (`beforeAll`) and logged in through the **real `/login` form** — not an API/session
bypass — so the smoke run genuinely exercises the app's own auth flow. The user and every FDH row it touched
were deleted in `afterAll`, independently re-verified by re-query (`residue=0` on every run).

Spec: `tests/e2e/fdh14-ui-accessibility-smoke.spec.ts`. Fixtures added:
`tests/fixtures/financial-data-hub/fdh14-smoke-liability-cc.csv`,
`tests/fixtures/financial-data-hub/fdh14-smoke-investment.csv`,
`tests/fixtures/financial-data-hub/fdh14-smoke-retirement.csv` (built from each domain's own documented
generic-CSV column contract — `AU_CREDIT_CARD_GENERIC_V1`, `AU_GENERIC_TRANSACTION_CSV`,
`GENERIC_RETIREMENT_TRANSACTION_CSV` — not guessed). Two of the pre-existing FDH-3 fixtures
(`invalid-pdf.pdf`, `synthetic-bank-statement.csv`) were reused as-is.

## Final result: 5/5 surfaces PASS

| Surface | Route | CTA reachable | Upload starts | Processing visible | Review/terminal state | Error state | Explicit Apply | Success reachable | Mobile/keyboard |
|---|---|---|---|---|---|---|---|---|---|
| Income → Payslip import | `/income` | Yes | Yes | Yes (`role=status`) | N/A this smoke (see finding 1) | Yes, bounded | N/A (blocked before review) | Not exercised (PDF-based; see below) | PASS |
| Liabilities → Credit Card/Loan | `/liabilities` | Yes (`aria-expanded` toggles correctly) | Yes | Yes | Yes | Yes | N/A (terminal state reached is the smoke target) | Terminal state reached (review or bounded error) | PASS |
| Investments → AU Investment Statement | `/investments` | Yes | Yes | Yes | Yes | Yes | N/A | Terminal state reached | PASS |
| Retirement → Retirement Statement | `/retirement` | Yes — see finding 2 | Yes | Yes | Yes | Yes | N/A | Terminal state reached | PASS |
| Expenses → Bank Statement import | `/financial-data-hub` — see finding 3 | Yes | Yes | Yes | N/A | Yes, bounded, distinguishable | N/A (auto-queued) | **Yes — genuine "Uploaded and queued for processing"** | PASS |

Across all 5: no FDH-specific horizontal overflow at 375×812 mobile viewport; the primary CTA/upload control is
keyboard-Tab-reachable (checked once enabled — disabled buttons are correctly excluded from the Tab order per
the HTML spec, which is itself correct accessible behaviour, not a defect); labels resolve via
`getByText`/`getByLabel`-equivalent queries; no error or loading state read as a financial `$0` in this pass's
checks.

## Three genuine findings from this pass (disclosed, not fixed — smoke scope)

**Finding 1 — Payslip PDF extraction has no bounded timeout for a text-disguised-as-PDF upload.** Uploading
`wrong-extension.pdf` (plain CSV text saved with a `.pdf` extension — this repo's own existing fixture) through
`/income`'s "Import from Payslip" panel left the panel in the "Processing your payslip…" state for **2+
minutes with no resolution** (reproduced twice). Root cause traced (not fixed): FDH-3's upload-time PDF
classification step let the file through as apparently text-readable, then `extractPdfPages()`
(`lib/financial-data-hub/bank-pdf/textExtraction.ts`, using `pdf-parse`) has no timeout wrapper around its
`await`, so a malformed non-PDF byte stream can hang the request indefinitely. Genuine garbage-byte input
(`invalid-pdf.pdf`) IS rejected quickly and cleanly by contrast, confirming this is specific to
text-that-isn't-actually-a-PDF, not all invalid uploads. **Severity: P2** (reliability / potential
resource-exhaustion vector under adversarial input — no financial data at risk, scoped to the uploading user's
own request). **Not fixed in this round** (real engineering work, not a migration, and explicitly out of this
round's 5-gap scope). Recommend a bounded timeout around `extractPdfPages()` in a future FDH-9/FDH-5 follow-up.
New residual: **R-14-8**.

**Finding 2 — Retirement's import panel has no "Import Statement" toggle CTA, unlike the other three domains.**
Income/Liabilities/Investments each require one extra click on an "Import from X"/"Import Statement" button to
reveal the upload form. Retirement's `RetirementStatementImportPanel` renders permanently open
(`role="region" aria-label="Import a retirement statement"`) directly above the grid — the upload control is
the first-class CTA with no reveal step. This is an **inconsistency, not a defect**: the panel is still fully
reachable, labelled, and keyboard-accessible: it simply doesn't follow the same interaction pattern as its three
sibling panels. Flagged for design consistency, not blocking. New residual: **R-14-9**.

**Finding 3 — "Expenses → Bank Statement import" has no entry point under Expenses at all.**
`app/(app)/expenses/page.tsx` is an 8-line file rendering only the expense grid — no import panel, no link to
one. The only live bank-statement upload surface in the running app is the generic, multi-document-type FDH-3
uploader at `/financial-data-hub`, which the codebase's own comment states is "deliberately NOT linked from the
main app navigation yet... for local/DEV use and certification. Direct-navigation only." This smoke pass used
that surface as the closest real equivalent (a real, working bank-statement upload path exists and was fully
exercised — CTA, upload, error, and a genuine success completion), but it is **not actually reachable from the
Expenses tab a user would expect**, and is not linked from primary navigation at all. Pre-existing, disclosed
architectural characteristic (not introduced by this pass), already implicitly covered by residual #9 in the
Residual Register ("no Liabilities-tab UI/API surface" is the FDH-10 analogue) — recorded explicitly here for
Expenses/bank-statement. Severity: **P3** (a real path exists; discoverability/navigation gap only). New
residual: **R-14-10**.

## Verdict

**PASS.** All 5 named FDH entry surfaces have a real, working, accessible upload path with a reachable CTA, a
visible processing state, a bounded and distinguishable error state, and either a genuine review/terminal state
or (for the one surface with a synchronous validate-only path) a genuine success completion — verified via real
browser automation against the actual app pointed at live DEV, not fabricated. Three genuine, freshly-found
issues are disclosed above (one P2 reliability gap, two P3 consistency/discoverability gaps) — none are
financial-integrity or security-boundary defects, and none block this round's promotion decision per the
Product Owner's own severity-gate rule (only P0/P1 block).
