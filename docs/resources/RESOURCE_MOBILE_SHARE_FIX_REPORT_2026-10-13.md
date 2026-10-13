# Resource mobile Share, shared-link and deep-link closure (13-10-2026)

Branch `fix/resource-mobile-share-20261013`, based on `origin/main` tip `4b00b12`. Nothing pushed, merged or deployed.
Admin standard: not applicable (no file under `app/(app)/admin/**`, `app/api/admin/**` or any Admin capability was touched).

Evidence labels used below: UNIT-TESTED, BROWSER-HARNESS (Chromium engine with phone emulation, real running app on DEV), NOT VERIFIED.

## Discovery: the complete chain (before the fix)

| Step | Where |
|---|---|
| Resource article page | `app/(marketing)/resources/[slug]/page.tsx` (public, outside the auth gate; `proxy.ts` `isAppRoute` does not match `/resources`) |
| Header that hosts Share | `components/resources/public/ResourceDetailHeader.tsx` (`shareUrl` prop) |
| Share control | `components/resources/public/ShareButton.tsx` (the only Share implementation; no separate mobile one) |
| Tap handler | `handleShareClick` only toggled a dropdown; `navigator.share` was reachable only from a "More options..." item (2026-10-01 decision, because desktop Edge/Chrome expose `navigator.share` with dead targets) |
| Fallback UI | `div role="menu" className="absolute right-0 z-10 mt-2 w-48 ..."` inside `div.relative` |
| Copy | `navigator.clipboard.writeText(url)` with no fallback and a silent catch |
| URL generated | `buildResourceCanonicalUrl(slug)` = `${APP_BASE_URL}/resources/${slug}` (`lib/resources/public/metadata.ts`), slug taken from the route param |
| Metadata | `buildResourceMetadata`: canonical, og:url/title/description/type; Twitter tags are derived by Next from the Open Graph block; no og:image is configured anywhere |
| Recipient navigation | plain HTTPS GET `/resources/<slug>` -> `getPublicResourceBySlug` (exact slug match, public visibility only) -> article, or generic 404 |
| Native / deep link | none (see below) |

## Root cause

The clipping was not a z-index or overflow problem. The Share button sits in `flex flex-wrap justify-between`. On a phone the chip row of a real article (Article / Global / Beginner-Intermediate) is too wide to share a line with the button, so the wrapped Share button falls to the LEFT edge on its own line. The menu was `absolute right-0 w-48` (192 px), anchored to the RIGHT edge of that small left-hand button, so it extended about 74.5 px past the left edge of the screen. That is exactly the cut-off menu in the PO screenshot (`...ink` = "Copy link").

Reproduced on the production article (read-only public page, old code) with the harness: panel left edge = -74.5 px at 320, 360, 375 and 390 px; fits at 393 px and wider because the chip row stops wrapping there. Screenshots: `artifacts/resources/share/before-production/fallback-iphone-390.png`, `fallback-narrow-320.png`.

Second defect found: the shared journey never used the native share sheet on phones (the PO's "does not reliably open" experience included users getting only a tiny web-link menu). Third: `Copy link` had no fallback and no failure feedback; `role="menu"` was declared without arrow-key support.

## Files changed

- `lib/resources/public/share.ts` (new): pure share logic (payload, native-vs-fallback rule, cancellation, clipboard with legacy fallback, public-URL guard).
- `components/resources/public/ShareButton.tsx`: rewritten UI (details below).
- `components/resources/public/ResourceDetailHeader.tsx`: passes the excerpt to Share.
- `lib/resources/public/metadata.ts`: `buildResourceCanonicalUrl` encodes the slug once.
- `app/(marketing)/resources/[slug]/page.tsx`: canonical/share URL built from the stored `post.slug`.
- Tests: `tests/unit/resourceShareJourney.test.ts` (new, 48), `tests/unit/shareButton.test.ts` (updated), `tests/e2e/resource-share-mobile.spec.ts` + `playwright.resource-share.config.ts` (new browser harness), screenshots in `artifacts/resources/share/`.

## Share URL

- Before: `https://app.financialhealthplatform.com/resources/gross-income-vs-take-home-income` on production. Verified on the live page: `<link rel="canonical">` and `og:url` carry that exact URL, so `APP_BASE_URL` is correctly set in production and the Share URL was already the right public URL. The localhost fallback only occurs if `APP_BASE_URL` is unset in a deployment.
- After: identical for production. The URL is now built from the stored slug (not the raw route parameter), the slug is URL-encoded exactly once (identity for the repo's `[a-z0-9-]` slugs; protects any future non-ASCII slug from raw or double encoding), and canonical, og:url, JSON-LD and Share are one function. The component shares only its `url` prop and never reads `window.location` (unit-tested).
- The guard `findShareUrlProblem` rejects localhost, 127.x, http, Supabase hosts, relative URLs, admin routes, UUID-only routes, query/fragment and non-`/resources/<slug>` shapes (UNIT-TESTED, 13 cases). It is a tested rule, not a runtime blocker, so Share is never hidden on local development.

## Native Web Share behaviour

On touch devices (`matchMedia('(pointer: coarse)')`) that expose `navigator.share`, the tap calls `navigator.share({ title, text, url })` synchronously from the click handler (user activation preserved), with the article title, the excerpt (max 200 characters, word-boundary cut, with a title-based fallback when there is no excerpt) and the canonical URL; `navigator.canShare`, where present, can veto. A user dismissing the sheet (`AbortError`) produces no message and no panel. Any other rejection opens the in-page panel. Desktop browsers that merely expose `navigator.share` keep the in-page panel with an optional "More options..." entry (the 2026-10-01 decision is preserved). UNIT-TESTED (exact payload, abort, other error, device matrix) and BROWSER-HARNESS (mocked `navigator.share` at 360/375/390/393/412: called once with exact title/text/url; abort shows nothing; NotAllowedError opens the in-page sheet inside the viewport). The real iOS/Android OS share sheets are NOT VERIFIED.

## Fallback behaviour

- Below 640 px: bottom sheet (`fixed`, left/right/bottom `max(0.5rem, env(safe-area-inset-*))`, `max-w-sm`, `max-h-[80vh]` scrollable) with a dimmed backdrop, a header and an explicit Close button, so it can never be wider than the viewport minus margins, whatever the anchor.
- 640 px and up: anchored popover (`sm:absolute right-0 w-48 max-w-[calc(100vw-2rem)]`); the Share control is `ml-auto` so it stays right-aligned even when the header row wraps; the popover is scrolled into view (landscape phones).
- Actions: Copy link (first), Email, X, Facebook, LinkedIn, WhatsApp (existing targets only, no new SDKs), "More options..." where the Web Share API exists on desktop. Touch targets at least 44 px on phones and on any coarse-pointer device.
- Copy link: Clipboard API, then a legacy textarea copy, then a "select and copy this link" field. Visible "Link copied" plus a polite live region. Escape, outside tap, backdrop tap and Close all close; focus returns to Share.

## Mobile viewport results (BROWSER-HARNESS, Chromium with touch emulation, DEV Supabase `vqycarelcoijzwlpkpcz` verified, dev server on port 3989 with `APP_BASE_URL=http://localhost:3989`)

34 of 34 Playwright tests pass (`npx playwright test -c playwright.resource-share.config.ts`):

- Fallback sheet at 320, 360, 375, 390, 393, 412, 414, 430 portrait and 844x390 landscape: panel left >= 0, right <= viewport width, bottom <= viewport height, `scrollWidth <= clientWidth` with the sheet open, action height >= 44 px. Repeated with Share forced to the left edge of the header (the PO's wrapped layout) at every width below 640: still fully inside.
- Share closed: no horizontal overflow and the article inside the viewport at all nine sizes.
- Desktop 1280: popover inside the viewport, Enter opens, focus lands on Copy link, Escape closes and focus returns to Share, outside click closes, "More options..." reaches the (mocked) native share; native share is not invoked by the Share tap on desktop.
- Phone: Escape, Close button and backdrop tap close the sheet and focus returns to Share.
- Test data note: DEV only holds the R1.5/R1.6 test resources (short chip rows), which do not wrap Share on their own; the left-edge case is forced in the harness and the natural case was reproduced on the production page with the old code.
- Not run: physical iPhone Safari, WebKit, Android Chrome hardware. No claim is made about them.

## Logged-out recipient test (BROWSER-HARNESS plus curl)

In every fallback run the copied clipboard text was compared with the canonical URL, then opened in a brand-new cookie-less context at the same viewport: HTTP 200, same URL (no redirect, no login, no loop), same H1, same after reload, no horizontal overflow. Separate test: canonical and og:url equal the page URL, og:title present, Resources index then browser Back returns the same article, reload keeps it. Production, plain `curl` without cookies: `/resources/gross-income-vs-take-home-income` returns 200 with the correct title, H1 and canonical. Unit test: `proxy.ts`'s protected-route pattern does not match `/resources/**` (with a control proving it still protects `/dashboard` and `/admin/resources`). Not tested: a real phone browser, private-session behaviour on iOS.

## Deep link / PWA finding

NOT CURRENTLY SUPPORTED. The repository has no `apple-app-site-association`, `assetlinks.json`, web app manifest, service worker, custom scheme or associated-domain configuration (searched; asserted by a unit test so it cannot change silently). The only icons are the favicon/apple-touch icons in `app/layout.tsx`. Required behaviour therefore applies: the canonical HTTPS link opens the correct public Resource in the browser. There is no "open in app" behaviour to certify.

## Metadata

Canonical, og:url, og:title/description/type (and the Twitter tags Next derives from them) are unchanged in value for production. og:image is not configured anywhere in the Resources metadata and was not added (outside "smallest correct fix"). Canonical and Share URL are the same function output for the same stored slug (UNIT-TESTED).

## Accessibility

Real `<button>` named "Share" with `aria-expanded`, `aria-controls`, `aria-haspopup="dialog"`; panel is a labelled non-modal `role="dialog"` (the unsupported `role="menu"`/`menuitem` roles were removed); visible `focus-visible` rings; focus moves to Copy link on open and returns to Share on Escape, Close, backdrop and item choice; no focus trap (non-modal); polite live region announces "Link copied". Verified by unit assertions on the source and the Playwright keyboard/focus tests. NOT a screen-reader test: no VoiceOver/TalkBack/NVDA run, no certification claimed.

## Tests

- UNIT-TESTED: `tests/unit/resourceShareJourney.test.ts` (48) + `tests/unit/shareButton.test.ts` (7) pass; `resourcesPublicR1_5` 38 pass; `seoEntity`, `proxyG4GenericAllowlist`, `resourcesDiscoveryR1_6`, `resourcesF11F12PickerLinksRepair`, `resourcesEditorR1_3` pass.
- Pre-existing, unrelated failure: `countryGateAccessMatrix.test.ts` MC-15 ("no account/user-deletion API route exists") fails because `app/api/admin/account-deletions/[id]/execute/route.ts` is on `origin/main`; not touched by this branch.
- Negative controls proven by mutation (break, see the named test fail, restore): (1) re-add `absolute right-0 w-48` to the panel -> "the old defect is gone..." fails; (2) `isShareAbort` always false -> "AbortError -> cancelled" fails; (3) native share without the coarse-pointer check -> "desktop (fine pointer)..." and "no matchMedia..." fail; (4) slug not encoded -> "encodes the slug exactly once" fails; (5) add `resources` to the protected route pattern -> "proxy.ts treats /resources/** as a non-app route" fails; (6) drop `ml-auto` -> the right-alignment test fails; (7) Share URL from `window.location.href` -> "shares exactly its url prop" fails. Browser-level control: the same harness against the old code on the production article fails with panel left edge -74.5 px.
- `npx tsc --noEmit` (with a larger Node heap) clean; ESLint clean on all touched files; `next build --webpack` compiles successfully (3.4 min) and then stops at the known pre-existing next route-type validator error on `app/api/admin/recommendations/gaps/route.ts`. A Turbopack build cannot run in this worktree because `node_modules` is resolved from a parent directory.

## Main SHA / origin/main

Based on `origin/main` tip `4b00b12`; at the end of the work `origin/main` had not moved, so no merge was needed.

## Amplify deployment

Pending: PO push, then coordinator verifies the Amplify build.

## Production mobile evidence

Pending: PO phone. Production oracle: Share -> native sheet (or in-page sheet) opens fully on screen -> shared link is `https://app.financialhealthplatform.com/resources/<slug>` -> recipient taps it logged out -> the same public Resource opens.

## Verdict

CONDITIONAL PASS. Remaining evidence gaps: PO push to main; Amplify deployment; real production iPhone/Android journey (physical iOS Safari and the OS share sheets cannot be tested here); `APP_BASE_URL` was observed correct in production only through the live page's canonical/og:url.
