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
- **Desktop/tablet/mobile/keyboard/accessibility certification was not run as a dedicated pass** against a live rendering — see `FDH11_LIVE_DEV_CERTIFICATION.md`'s residuals for why (the Browser-pane preview in this sandbox environment was bound to a different worktree's directory and could not be redirected to serve this codebase's dev server, a genuine environment limitation, confirmed and disclosed rather than worked around by fabricating results). Static verification (`tsc --noEmit`, ESLint, the component's own semantic HTML — `role="region"`, `aria-live`, `aria-expanded`, labelled inputs, a focus-return pattern copied verbatim from the already-certified `LiabilityImportPanel.tsx`) is the evidence available for this pass.
