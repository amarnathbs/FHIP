# FDH-11 — Investments Tab UX (spec sections 2, 76-83, 141, 144)

## Layout

`app/(app)/investments/page.tsx` now offers three entry points, above the existing manual grid:

```
Investments
Add investments manually, import an Australian broker statement, or view your India investments.

[Import Australian Investment Statement]   [India Investments →]

(AuInvestmentStatementImportPanel, when opened)

─────────────────────────────────────────

[Investments | Retirement]  (existing InvestmentsSubNav, unchanged)
[Manual investment grid — "+ Add Custom Item" remains the manual-add path, unchanged]
```

"India Investments" is a plain `<Link href="/investment-intelligence">` — no new India processing, no residence gate (spec section 77: India capability must not be hard-blocked by residence). The existing `/investment-intelligence` module and its own nav entry (`components/ui/AppShell.tsx`) are both left fully intact; FDH-11 adds a second way to reach the same destination, per spec section 2's "unified UX does not mean unified implementation."

## Manual investment flow (spec section 82) — unaffected

`FinancialDataGrid` + `investmentGridConfig`'s `+ Add Custom Item` / edit-in-place / archive flow is untouched by this pass — verified by `git diff` showing zero changes to `components/grid/FinancialDataGrid.tsx`, `lib/grid/configs.ts`, or `app/api/investments/*`.

## The AU import journey (`AuInvestmentStatementImportPanel.tsx`)

Upload → Review (positions + activities listed with per-row match status) → "Match accounts & securities" (bulk-resolves account + every unresolved security + runs bank-matching) → Approve evidence (disabled while any row is unmatched) → Apply (only enabled once approved) → Applied (shows the count of canonical rows created). Every phase before Apply is inert by construction — the panel's own state machine has no code path that calls the `/apply` route before the user explicitly clicks "Apply to Investment Intelligence," mirroring `LiabilityImportPanel.tsx`/`PayslipImportPanel.tsx`'s established shape.

## Error vs zero (spec section 143)

The panel distinguishes `unable_to_read` (a genuine extraction failure, with the specific reason surfaced) from a legitimate empty result — it never silently shows an empty review screen for a failed upload. The underlying extraction functions (`csvExtraction.ts`) always emit a `warnings` array alongside any partial result, and zero-rows-extracted is itself flagged (`zero_positions_extracted`).

## Disclosed UX residuals

- **No per-row correction UI** — a user cannot edit a mis-extracted security name/quantity from the review screen this pass; they can only accept the match-or-review outcome the bridge computed. (Matches spec section 24's "these are statement observations" framing; a correction UI is a natural follow-up, not represented as built.)
- **UPDATE (live-DEV closure round)**: the Browser-pane worktree-binding problem noted below was resolved — `preview_start` with an explicit `url` parameter (rather than a `name` looked up against `launch.json`) correctly points the Browser pane at a `next dev` instance started explicitly from this worktree. Desktop/Tablet/Mobile were then genuinely verified live (both CTAs render correctly at each breakpoint, real mouse click opens/closes the panel with correct `aria-expanded` state and focus-return, real Tab-key navigation reaches the toggle button in one press from the preceding sidebar control), and the India Investments link was confirmed to navigate to the real, unmodified `/investment-intelligence` module. Full detail in `FDH11_LIVE_DEV_CERTIFICATION.md`.
- **Keyboard activation (Enter/Space) specifically — not Tab navigation — remains unverified by this session's tooling.** A focused native `<button>` did not respond to this browser automation tool's synthetic Enter/Space key events; a control test reproduced the identical non-response on the already-certified `LiabilityImportPanel.tsx`'s own toggle button using the same technique, indicating a tool limitation against native button default-action handling rather than a defect in either component (native buttons activate on Enter/Space as a browser platform guarantee, independent of any custom application key-handling code, of which this component has none). Disclosed precisely rather than claimed as a pass.
- Full accessibility audit (screen-reader walkthrough, colour-contrast, focus-visible styling) was not run as its own dedicated pass — the component's semantic HTML (`role="region"`, `aria-live`, `aria-expanded`, labelled inputs, the focus-return pattern) is the evidence available.
