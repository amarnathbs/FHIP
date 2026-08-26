# 00 — Repository Baseline

Phase 0 of the FHIP Google Search Entity, Domain Identity & AI Overview Remediation task.

## Repository / worktree

- Repository: `amarnathbs/FHIP` (origin: `https://github.com/amarnathbs/FHIP.git`)
- Worktree: `D:/FHIP/.claude/worktrees/fhip-google-entity-consolidation`
- Branch: `fix/fhip-google-entity-consolidation`, cut from `origin/main`
- Base SHA (origin/main at dispatch, re-verified via `git fetch origin main`): `285c9c0291a341910e7cea230e576466399ee1bf`
  ("fix(ii): standalone production security hotfix for ii_holding_snapshots (0094)")
- Working tree at branch creation: clean, no dirty/untracked files carried over from the base commit.
- This worktree does not collide with any other active worktree under `D:/FHIP/.claude/worktrees/`.

## Framework / stack

- Next.js `16.2.12`, App Router (`app/` directory), TypeScript.
- Package name: `fhip`. Test runner: Vitest (`tests/unit/**/*.test.ts`, node environment). E2E: Playwright (`tests/e2e`).
- Deployment: GitHub → AWS Amplify (build+hosting, `ap-southeast-2`) → Cloudflare (DNS) → Supabase (prod DB/auth/storage) → Resend (transactional email via Supabase Auth SMTP). See `DEPLOYMENT.md`.
- Single Amplify app/build serves the whole product; there is no separate build or deployment target for `myfhip.com` anywhere in the repository (`amplify.yml`, `DEPLOYMENT.md`, `ENVIRONMENT_VARIABLES.md` all reference only `app.financialhealthplatform.com`).

## Domain/environment configuration found in-repo

- `APP_BASE_URL` (server-only env var, reused across the codebase — see `lib/resources/public/metadata.ts`): set to `https://app.financialhealthplatform.com` in production, `http://localhost:3000` locally. This is the only base-URL configuration point in the app; it is now also the single source of truth this task's new SEO/canonical/JSON-LD code reuses (see `02-seo-entity-audit.md`).
- No `myfhip.com` environment variable, redirect config, middleware, or Amplify domain association exists anywhere in the repository. The only in-repo reference to `myfhip.com` prior to this task was a single code comment (`app/(marketing)/page.tsx` line 29) documenting a prior branding change, not any functional wiring.
- Cloudflare zone `financialhealthplatform.com` is the DNS host for both `myfhip.com` (per DEPLOYMENT.md, this is inferred/not explicit — see `01-domain-inventory.md`) — correction: `myfhip.com` and `financialhealthplatform.com` are in fact two independently-registered domains, each with their own Cloudflare zone (both resolve via Cloudflare nameservers; confirmed live in `01-domain-inventory.md`/`03-canonical-matrix.md`).

## Live domain state (read-only HTTP checks performed for this baseline; full detail in `01-domain-inventory.md`)

| Host | Resolves? | HTTP behaviour |
|---|---|---|
| `myfhip.com` / `www.myfhip.com` | Yes (Cloudflare anycast IPs) | 301 → `https://app.financialhealthplatform.com/` (path+query preserved) |
| `financialhealthplatform.com` (root) | **No** — Cloudflare zone exists (NS delegated) but no A/AAAA record configured; confirmed via both local resolver and `8.8.8.8` | N/A — does not resolve |
| `www.financialhealthplatform.com` | **No** — NXDOMAIN | N/A |
| `app.financialhealthplatform.com` | Yes | 200 OK, serves the live Next.js app (CloudFront + Amplify) |

This is a first-order finding, not an assumption: the bare `financialhealthplatform.com` root domain has **no DNS presence at all**, which is directly relevant to Problem B's root-cause assessment (see `10-residual-risk.md` and the final report).

## Branch discipline

No other feature branch or worktree was modified by this task. All work happens exclusively inside `fix/fhip-google-entity-consolidation` in the dedicated worktree above.
