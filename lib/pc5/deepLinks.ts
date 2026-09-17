/**
 * PC5 (M4) — K.14: *"Every resolvable Review Centre item must deep-link to
 * the exact underlying case, not merely the raw statement list."*
 *
 * WHY THIS IS A MODULE AND NOT A TEMPLATE STRING AT EACH CALL SITE. The
 * failure K.14 describes is not "no link exists" — it is a link that lands
 * the user one level too high, on a list they then have to search. That
 * failure is easy to reintroduce one component at a time. Centralising the
 * hrefs means the routes are asserted once, in one unit test, against the
 * real page paths; a page that moves breaks the test rather than quietly
 * degrading every link to a list.
 *
 * Every function returns a path, never a full URL: these are consumed by
 * Next.js `<Link>`/`router.push`, and an absolute URL would break in
 * preview deployments and would be an open-redirect shape if it ever
 * reached a redirect.
 */

/** The PC5 resolution surface itself. */
export const PC5_RESOLUTIONS_BASE = '/investment-intelligence/resolutions';

/** One specific unresolved item's resolution context — K.14's "exact
 * underlying case". */
export function pc5ItemHref(itemId: string): string {
  return `${PC5_RESOLUTIONS_BASE}/${encodeURIComponent(itemId)}`;
}

/** The whole document's exception set, when a user legitimately wants the
 * run rather than one item (e.g. after discarding an item's sibling). */
export function pc5RunHref(runId: string): string {
  return `${PC5_RESOLUTIONS_BASE}?run=${encodeURIComponent(runId)}`;
}

/** AIE's own review detail for the same run. PC5 links OUT to it rather
 * than reimplementing the candidate/correction surface, which already
 * exists and is already tested — K.3's "no parallel review experience"
 * applies to building a second one, not to linking to the first. */
export function aieRunReviewHref(runId: string): string {
  return `/aie-review/${encodeURIComponent(runId)}`;
}

/**
 * K.8 — the password-required case. This is the ONE deep link that does not
 * point at a page: it points at the real unlock ROUTE that already exists
 * (`app/api/aie/investment-intelligence/intake/[intakeId]/process/route.ts`,
 * which accepts `{ password, owner_member_id }` and resumes from the SAME
 * quarantined bytes).
 *
 * WHY NOT LINK TO A `request_reprocessing` ACTION INSTEAD. Because there
 * isn't one. `'request_reprocessing'` appears in nearly every
 * `permittedActionTypes` and `allowedActions` array in this codebase and is
 * implemented by NOTHING — `VALID_ACTIONS` in the decide route is
 * `['correct','not_present','defer']`, and no service anywhere implements
 * reprocessing. Deep-linking to a real route that works, rather than to a
 * vocabulary entry that does not, is the honest answer to K.8; the gap
 * itself is reported rather than papered over.
 */
export function pc5PasswordUnlockEndpoint(intakeId: string): string {
  return `/api/aie/investment-intelligence/intake/${encodeURIComponent(intakeId)}/process`;
}

/**
 * K.8's user-facing half: where the user goes to supply the password. The
 * AIE review detail page owns the document-level actions for a run, and the
 * unlock prompt belongs with them rather than in a PC5 page that would
 * otherwise have no reason to handle a password at all (and would then be a
 * second place credentials are typed — see PC5's security notes).
 */
export function pc5PasswordUnlockHref(intakeId: string): string {
  return `/aie-review?unlock=${encodeURIComponent(intakeId)}`;
}
