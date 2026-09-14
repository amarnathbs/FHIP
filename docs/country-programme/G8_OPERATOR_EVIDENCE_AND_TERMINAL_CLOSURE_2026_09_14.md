# G8 — Operator Evidence and Terminal Closure (2026-09-14)

**Supersedes for verdict purposes only:** `G8_FINAL_VERIFICATION_ONLY_CLOSURE_PASS_2026_09_13.md`, which is NOT re-run here (per this mission's own explicit instruction). This report adds: a review of the 3 local verification commits for handoff, a G2 activation-readiness package (not applied), and the honest terminal-verdict reconciliation.

**No AWS API calls were repeated in this pass.** Per this mission's own instruction ("Do not repeatedly retry an AWS operation after an explicit access denial"), the prior session's explicit denials (`s3:ListAllMyBuckets`, `guardduty:ListDetectors`, `cloudfront:ListDistributions`, `amplify:ListApps` — all `AccessDenied`/`AccessDeniedException` for `arn:aws:iam::879807128139:user/Amar`) are treated as still current and are not re-probed here.

---

## 1. Executive verdict

**`G8 CONDITIONAL PASS — SPECIFIC OPERATOR OR ACTIVATION ITEMS REMAIN`.**

`G8 FULL PASS` is **not** awarded. Two conditions for FULL PASS are unmet, honestly, not redefined:
- The actual successful production deployment (job ID, exact SHA, completion timestamp, domain association) is **not identified** — this session has no Amplify API/console access, and none was requested to be re-attempted.
- **G2 (country-personalisation) production behavior has never been activated or certified** — it is OFF today, confirmed by live behavioral observation (production returns byte-identical content regardless of country header). Per this mission's own §9 instruction, this is recorded honestly as an **unactivated requirement**, not glossed over as an operator-evidence-only gap: if G2's behavior was part of the original country programme's scope, the programme's full rollout is not complete while it stays off.

## 2. Actual deployed SHA, deployment job, branch, domain, completion time

**Not established.** This session has no Amplify API/console access (confirmed, not re-attempted this pass). What IS established, from git and live HTTP evidence:

| Fact | Value | Source |
|---|---|---|
| `origin/main` HEAD | `00a3d88` (unchanged since the prior report — confirmed by `git fetch` this pass) | git |
| Smoke-tested revision | `f53d0c0` | prior report |
| `f53d0c0`, `5c76340`, `00a3d88` all reachable from `origin/main` | Yes, re-confirmed this pass | `git merge-base --is-ancestor` |
| Production serving *a* single consistent build right now | Yes — two consecutive fetches of the homepage return byte-identical content and a stable `ETag` | Not re-fetched this pass (unchanged since last observation, no reason to expect drift with zero new pushes) |
| Exact deployed commit SHA | **Unknown** | No Amplify API access |
| Deployment job ID / completion timestamp / domain association | **Unknown** | Same |

**Consolidated operator evidence needed** (per this mission's own §4, batched into the one request at the end of this report): Amplify application ID, production branch name, domain association for `app.financialhealthplatform.com`, the latest successful deployment's job ID + full commit SHA + completion timestamp, and whether any later deployment job failed/is pending/succeeded.

## 3. Comparison with the smoke-tested revision

**Unchanged from the prior report — re-confirmed this pass, not re-derived from scratch.** `git diff f53d0c0..00a3d88` still shows exactly:
- `amplify.yml`: only the temporary diagnostic block removed (13 lines); the actual runtime-forwarding line is byte-for-byte identical.
- One new script file (`g8_prod_full_activation_smoke_test.mjs`) — never ships in the Amplify build artifact.
- One new doc.

**Zero application source, zero migration, zero runtime-behavior-affecting configuration changed** between the smoke-tested revision and current `origin/main` HEAD. This bounds risk regardless of which exact SHA is currently served — the certified 16/16 production behavior is unaffected either way.

## 4. Effective G2/G4/G5B and rollout configuration

| Flag | Effective state | Evidence |
|---|---|---|
| `G4_APP_CAPABILITY_LAYER_ENABLED` | ON (production) | 16/16 production smoke test (prior report) |
| `G5B_GENERIC_WRITE_ENABLED` | ON (production) | Same |
| `ROLLOUT_G5B_GENERIC_WRITE_ENABLED` / `_VERSION` / `_PERCENTAGE` | ON, `2026-09-13-g8-initial-activation`, **100** | Same; unchanged this pass, not re-tested (explicitly not authorized to lower) |
| `G2_LANDING_LOCALISATION_ENABLED` | **OFF** | Confirmed by live behavior (see §5) — this is a fact about the running application, not merely "last observed"; no code or config path exists by which it could have silently turned on without a config change, and none occurred (zero pushes since `00a3d88`) |
| `G2_ALLOW_TEST_DETECTION_HEADER` | Unknown in production (irrelevant while `G2_LANDING_LOCALISATION_ENABLED` is OFF — the whole code path this flag gates is never reached) | Structural: `readRawDetectedCountry()` only consults this flag inside a code path that itself never executes while G2 is off |

## 5. CloudFront/header/caching evidence and its provenance

**Provenance discipline, per this mission's explicit instruction — every claim below is labelled by its actual evidentiary basis, not conflated:**

| Claim | Provenance | Status |
|---|---|---|
| The app is served through Amplify's own managed CloudFront (not a separately customer-editable distribution) | **Actual observed production HTTP response headers** (`Via: 1.1 <hash>.cloudfront.net`, `X-Amz-Cf-Pop`, `X-Amz-Cf-Id`) | Direct observation |
| Production currently returns byte-identical content regardless of `CloudFront-Viewer-Country` header value | **Actual observed production HTTP responses** (identical `ETag`/`Content-Length` across no-header/IN/GB requests) | Direct observation. **This is consistent with G2 being OFF — it is NOT evidence that CloudFront forwards or that genuine country detection works**, per this mission's own explicit caution (§6) |
| `CloudFront-Viewer-Country` reaching the application at all | **Not established** — no evidence either way from this session; requires either operator confirmation the distribution has viewer-country injection enabled, or turning G2 on and observing a real behavioral difference (§9 activation package, not applied) | Unconfirmed |
| Enabling G2 forces Next.js to render the landing route dynamically (`Cache-Control: no-cache, must-revalidate`), which structurally prevents one visitor's cached personalized response from leaking to another | **DEV-fixture observation** (isolated local dev server, `G2_LANDING_LOCALISATION_ENABLED=true`) — a platform behavior of Next.js's own `headers()`/`cookies()` opt-out-of-static-rendering rule, not a bespoke guarantee this codebase had to get right | DEV-simulation + documented platform behavior, **not a production observation** |
| Whether CloudFront's own edge cache policy for this distribution respects that origin `Cache-Control` header, specifically | **Not established** — requires operator-level CloudFront/Amplify Hosting cache-policy visibility this session does not have | Unconfirmed, named in the consolidated request |
| Manual visitor selection (cookie) overrides detection; a malformed/tampered cookie falls through safely; the real header name is correctly wired | **DEV-fixture observation**, real HTTP against an isolated local server, not production | DEV-simulation |
| A forged public `CloudFront-Viewer-Country` header cannot grant financial capability, change billing eligibility, or write to any authoritative field | **Structural code-read evidence**: `landingCountryContext.ts`'s `isAuthoritative: false` is hardcoded on every result; the module has no write path into `user_profiles`/`country_of_residence`/`billing_country`/`primary_country` at all; `'GLOBAL'` cannot fit the `char(2)` DB columns even if a future bug tried | Direct source inspection, applies regardless of G2's on/off state or of production/DEV |

**No new infrastructure evidence was invented this pass.** Where operator/CloudFront-console access is required and unavailable, this is stated as unconfirmed, not inferred favorably.

## 6. G2 production acceptance matrix

| Scenario | Status | Provenance |
|---|---|---|
| AU detection → approved AU presentation | Proven correct **in a DEV fixture only** | DEV-simulation |
| IN detection → approved India presentation | Proven correct **in a DEV fixture only** | DEV-simulation |
| Other country → approved Global presentation | Proven correct **in a DEV fixture only** | DEV-simulation |
| Missing/malformed signal → neutral fallback | Proven correct **in a DEV fixture only** | DEV-simulation |
| Manual selector overrides detection | Proven correct **in a DEV fixture only** | DEV-simulation |
| Two separate visitor contexts don't share selected-country state | **Not separately tested this pass or the prior one** — the underlying mechanism is per-request/per-cookie with no server-side session cache (confirmed by code structure: `computeLandingCountryContext()` is a pure function taking only per-request inputs), which structurally implies isolation, but this was not proven via two genuinely concurrent live sessions | Structural inference only, not a live multi-session proof |
| Confirmed account jurisdiction unchanged by detection | Proven correct by code structure (tier 1, authenticated primary-country, always wins; detection is tier 3) | Direct source inspection |
| Forged public header cannot escalate authority | Proven correct by code structure (§5's structural row) | Direct source inspection |
| Production test-detection override cannot bypass trusted detection or account rules | The override requires `G2_ALLOW_TEST_DETECTION_HEADER=true`, which is a separate env var from `G2_LANDING_LOCALISATION_ENABLED` and gates a header read only within the same non-authoritative module — **its actual production value was not independently reconfirmed this pass** (assumed unset/false, matching a production-safe default, but not re-verified since no new probe was run) | Not reconfirmed this pass |

**Because G2 is OFF in production, none of the above have EVER been observed as real production behavior** — every proof is DEV-fixture-based. This is the honest basis for §9's "unactivated requirement" framing.

## 7. Migration `0129` closure reference

**Unchanged, closed.** Per the prior report: SHA-256 hashes across `feature/g6-g8-closure-continued`, `origin/main`, and the original base branch are byte-identical (389 lines, zero diff — not a comment-only diff, no diff at all). The repository's own cross-branch collision tool re-confirmed clean. Not re-derived this pass (no code or migration history changed since).

## 8. Existing 24/24 cohort evidence reference

**Unchanged, closed, not repeated this pass** (per this mission's own explicit instruction). `scripts/g8_verify_live_dev_cohort_killswitch.mjs` (23/23) + 1 cleanup check = 24/24, covering: percentage inclusion/exclusion, stable allocation on repeat, monotonic behavior on percentage increase, forged-parameter resistance, AU/FULL non-effect, MCC precedence, kill-switch-off fail-closed, malformed-config fail-closed. Reviewed as part of this pass's commit audit (§10) — confirmed the script file is unchanged, real, and its own commit message's claimed result (23/23) is consistent with what the earlier session actually observed running it.

## 9. Application/API versus database rollback boundary

**Unchanged, documented, not retested this pass.** `scripts/g8_verify_db_layer_rollback_boundary.mjs` (6/6) already proved live: the application-layer rollout switch has **zero effect** on a GENERIC user's own direct authenticated PostgREST INSERT/UPDATE access — migration `0129`'s DB-layer grant is unconditional once applied. DELETE/archive-via-UPDATE remains blocked regardless (migration `0147`), independent of any application-layer state. **This is documented as the system's real operating boundary, not claimed as a database-wide emergency stop** — no such mechanism exists or is claimed to exist.

## 10. Three local commits and their handoff status

| Commit | Files | Nature | On `origin/main`? |
|---|---|---|---|
| `206f354` | `scripts/g8_verify_live_dev_cohort_killswitch.mjs` (299 lines, new file) | Script only | No |
| `a52581f` | `scripts/g8_verify_db_layer_rollback_boundary.mjs` (85 lines, new file) | Script only | No |
| `246a4cd` | `docs/country-programme/G8_FINAL_VERIFICATION_ONLY_CLOSURE_PASS_2026_09_13.md` (232 lines, new file) | Documentation only | No |

**Confirmed this pass**: zero application source files, zero migration files touched across all 3 commits (`git diff origin/main..HEAD --name-only` shows only `scripts/` and `docs/` paths). Secret scan and conflict-marker scan both clean. No duplicate work exists on `origin/main` to merge against — these are 3 net-new files, not modifications to existing ones, so there is no merge conflict risk.

**Handoff status: ready for a documentation/test-only merge, pending separate explicit authorization.** Pushing these to `main` would trigger an Amplify build (any push does, regardless of file type) — cosmetically identical risk profile to the earlier `amplify.yml` diagnostic-cleanup push, i.e. low, since neither script nor doc files affect `npm run build`'s output. **Not pushed or merged this pass** — no such authorization was given.

## 11. Changes performed and their explicit authorization

**None.** This pass performed read-only git inspection (commit review, secret/conflict/migration scans) and documentation authoring only. No AWS/Amplify/CloudFront configuration was inspected via API (none re-attempted, per instruction), no environment variable was changed, no migration was applied or edited, no production write occurred, no push or merge occurred.

## 12. Remaining blockers

1. **Exact production deployment identity** (job ID, SHA, timestamp, domain association) — needs the consolidated Amplify evidence package (§2).
2. **G2 production activation** — deliberately not applied this pass; the readiness package is in §13 below, awaiting explicit PO approval before any change is made.
3. **CloudFront edge cache-policy confirmation** for the dynamic-rendering case, and confirmation that viewer-country injection is genuinely enabled on this distribution — needs operator console evidence.
4. **Two-concurrent-visitor-context isolation** for G2 — not yet live-tested even in DEV (only structurally inferred from the code's stateless design).

---

## 13. G2 activation-readiness package (NOT APPLIED — awaiting explicit PO approval)

Per this mission's §9 instruction: prepared, not applied.

| Field | Value |
|---|---|
| Proposed change | Set `G2_LANDING_LOCALISATION_ENABLED=true` in Amplify (app-level, matching G4/G5B's own precedent) |
| Current value | Unset (defaults `false`) |
| Proposed value | `true` |
| Application revision to deploy | None required — the code has been live on `main` since `9feba13`; this is a pure configuration change, no new deploy needed beyond whatever Amplify does automatically when a console env var changes (confirm with operator whether an env-var-only change triggers a rebuild on this project, matching the same open question the G4/G5B activation encountered) |
| Runtime-forwarding requirement | **Already satisfied** — `G2_LANDING_LOCALISATION_ENABLED` was added to `amplify.yml`'s forwarding list in the same commit (`9feba13`) that fixed G4/G5B's forwarding gap; no further code change needed |
| Trusted-header behavior | `CloudFront-Viewer-Country` is read only; this session cannot confirm CloudFront actually injects it (§5) — activating G2 without that confirmation risks the feature silently defaulting to the neutral-fallback tier for every visitor (safe, not a security risk, but not the intended personalization either) |
| Cache/privacy implication | Enabling G2 forces the landing route into dynamic (uncached) rendering by Next.js's own framework behavior — no separate cache-policy change is needed on the application side; CloudFront's own edge policy for this now-dynamic path is the one open question (§5) |
| Read-only production acceptance tests once live | Fetch the production homepage with/without a `CloudFront-Viewer-Country` header (if settable) and confirm a real behavioral difference (AUD vs INR vs neutral) — the exact test already run in DEV, now for real |
| Rollback procedure | Set `G2_LANDING_LOCALISATION_ENABLED` back to unset/`false` — no migration, no data change, reverts to today's exact behavior (byte-identical static content for everyone) |
| G4/G5B rollout confirmation | Unaffected — G2 is a structurally separate flag/module from G4/G5B/rollout; enabling it makes zero change to `requireModuleCapability()` or the rollout gate |
| Financial/billing confirmation | Structurally guaranteed unaffected — `isAuthoritative: false` hardcoded, no write path exists into any billing/country field (§5's structural row) |

**Stop point, honored**: this package is not applied. No PO approval was given during this pass.

---

## Closing metrics

- Exact production deployment confirmed: **no**
- G2 production activation: **off**
- Header behavior verified: **partially** (structural/DEV-simulation only; not confirmed in production)
- Cache isolation verified: **partially** (the dynamic-rendering guarantee is confirmed platform behavior; CloudFront's own edge policy is not confirmed)
- Production rollout percentage: **100** (unchanged)
- New production writes: **0**
- Migrations changed/applied: **0**
- Production configuration changes: **0**
- Push/merge/deployment actions: **0**
- Remaining programme blockers: **4** (§12)
- Terminal verdict: **`G8 CONDITIONAL PASS — SPECIFIC OPERATOR OR ACTIVATION ITEMS REMAIN`**
- Exact next Product Owner action: (a) supply the consolidated Amplify deployment-evidence package (§2), and (b) decide whether to approve the G2 activation-readiness package (§13) or explicitly record `G2 PRODUCTION ACTIVATION DEFERRED — ORIGINAL PROGRAMME ROLLOUT INCOMPLETE` and accept that as the programme's final scope.
