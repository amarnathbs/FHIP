# G8 Terminal Closure — 2026-09-14

## Verdict: CONDITIONAL PASS

Both items the prior report (`G8_FINAL_VERIFICATION_ONLY_CLOSURE_PASS_2026_09_13.md`) named as remaining are now closed or substantially de-risked. One item — direct AWS console confirmation of the CloudFront distribution's own configuration — remains genuinely operator-access-blocked, though strong empirical behavioral evidence now exists for it. This is not being inflated to an unconditional FULL PASS.

## What changed since the last report

1. `feature/g6-g8-closure-continued` (deployment-identity evidence + G2 live-DEV proofs), the app-review live-defect fix branch (10 bug fixes: the 6 originally reported plus the 4 sibling import panels), and the validation-leak sweep (59 additional routes) were all merged into `main` and pushed — three separate pushes, each verified clean (`tsc --noEmit`, zero conflicts, zero file overlap between branches) before pushing.
2. **Deployment confirmed via real operator evidence**: Amplify Deployment 184, "Deployed" (green check), last commit "merge: sweep leaked Zod validation errors valida...", domain `app.financialhealthplatform.com`, build 4m42s + deploy 31s, both green. This corresponds to `origin/main` @ `7cbfa15`.
3. **A bounded production acceptance matrix was run against this live deployment** (`scripts/g8_post_merge_acceptance_2026_09_14.mjs`, real HTTP, real disposable synthetic production users, cleaned up + independently re-verified gone) — **8/8 PASS**:
   - G2: the landing page now serves dynamically (`Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate`) — the framework-level cache-isolation behavior documented in the prior closure pass is confirmed live in production for the first time.
   - G2: the manual-selection cookie tier (`fhip_landing_country`) correctly switches presentation — setting it to India shows `₹99/mo` and correctly hides the AU `A$9.99/mo` price; the default (no cookie) case still resolves to a valid priced page.
   - App-review item 1 (validation-error leak fix): a real invalid POST to `/api/retirement` in production now returns `"Please check: Current Balance. This field could not be saved — correct it and try again."` — not the previous raw Zod issue dump.
   - App-review item 2 (upload-status disclosure): `/api/financial-data-hub/upload-status` is live and correctly reports `enabled: false` in production.
   - The validation-leak sweep reaches a second, unrelated route (`/api/expenses`) with the same friendly-message behavior.
4. **The existing G4/G5B/0147 production smoke test was re-run unchanged** (`g8_prod_full_activation_smoke_test.mjs`) — **16/16 PASS, zero residue** — confirming zero regression across these three additional deploys landing on top of the previously-certified G4/G5B activation.
5. **The G4-runtime-effective probe was re-run** (`g8_prod_g4_runtime_effective_check.mjs`) — still effectively ON at runtime, unchanged.

## CloudFront edge-policy item — substantially de-risked, not council-confirmed

Direct AWS console/API access remains unavailable to this session (re-confirmed: `amplify:ListApps` and `cloudfront:ListDistributions` both `AccessDenied` for the same IAM identity used throughout this programme). However, a real, repeatable behavioral test was run against the live production app:

Four separate requests were sent to `https://app.financialhealthplatform.com/`, each with a different **client-supplied** `CloudFront-Viewer-Country` header value (`IN`, `AU`, `GB`, and the invalid pseudo-code `ZZ`). If this header reached the application unmodified, at least the `IN` request should have rendered `₹99/mo` (India pricing), and `ZZ` — an explicitly denylisted pseudo-code per `lib/services/landingCountryContext.ts`'s own `RESERVED_OR_PSEUDO_COUNTRY_CODES` set — should have fallen through to the neutral/unresolved tier. **All four requests, with no exception, rendered the identical `A$9.99/mo` (AU) result.**

The only explanation consistent with the application's own documented tier-precedence logic (`computeLandingCountryContext()`) is that the value the application actually received for this header was **not** the client-supplied one — something between the client and the application is overwriting it with a real, consistent value. This is exactly the behavior expected of CloudFront's own viewer-country header injection (CloudFront owns this header name and replaces any client-supplied value with its own GeoIP-derived one before forwarding to the origin). This is real, repeatable, empirical evidence that the header injection is active — not a simulated or assumed result.

This falls short of a literal "operator confirmed the CloudFront distribution's cache/origin-request policy in the console" closure, so it is named here as **de-risked, not closed** — consistent with this programme's standing discipline of never converting circumstantial-but-strong evidence into an unconditional claim.

## Full closure status

| Item | Status |
|---|---|
| Deployment-identity confirmation | **CLOSED** (Deployment 181 → 184, real operator screenshots + git verification each time) |
| G2 two-visitor cache isolation | **CLOSED** (19/19 live-DEV, real browser contexts) |
| G2 mobile/320px + desktop layout | **CLOSED** (8/8 live-DEV) |
| G2 keyboard + accessibility | **CLOSED** (5/5 live-DEV) |
| G2 live-production behavior | **CLOSED** (8/8, this pass — dynamic rendering + manual-override tier, real production HTTP) |
| CloudFront edge-policy confirmation | **DE-RISKED, not council-confirmed** (strong repeatable behavioral evidence; genuine AWS console access still unavailable) |
| Migration `0129` reconciliation | **CLOSED** (byte-identical hashes, prior pass) |
| G4/G5B account-preservation regression | **CLOSED** (16/16, re-run clean on this new deployment, zero residue) |
| App-review live-defect fixes (10 total) + validation-leak sweep (59 routes) | **CLOSED** (merged, deployed, spot-checked live in production) |
| Rollout cohort / kill switch | Previously closed (24/24 + 6/6 live-DEV); production rollout percentage kept at 100% throughout, unchanged |

## Verdict

**G8 CONDITIONAL PASS.** The programme's own standing rule — "documentation alone never earns FULL PASS" — is satisfied here in the opposite direction: every item this report closes is closed on real, live, reproducible evidence, not a status re-statement. The one remaining gap (a literal CloudFront-console confirmation) is an operator-access limitation of this sandboxed environment, not a code or product defect, and now has strong supporting behavioral evidence rather than none.

No further engineering work is identified as outstanding for G8 at this time. The programme's own explicit boundary stands: **G8 is the end of this program's authorized scope — no G9 is created or implied by this report.**
