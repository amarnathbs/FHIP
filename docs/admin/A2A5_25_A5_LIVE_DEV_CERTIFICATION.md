# A5 — Live-DEV Certification (Terminal)

## Status: BLOCKED — same named mission stop condition as `A2A5_09`

Mission §12.5 requires repeating the nine-role live-DEV matrix after integrated A2–A4 implementation, covering login, Admin entry, Home, every visible group, representative CRUD routes, permitted/forbidden mutation, deep links, compatibility routes, help, desktop/mobile navigation, sign-out, session expiry, and cross-role transitions.

**This cannot be performed in this execution environment.** No Supabase DEV credentials exist (`.env.local` absent, no `SUPABASE_*` environment variables — re-confirmed at the start of this stage, `A2A5_07` §1, and unchanged since). This is the identical root cause as `A2A5_09`, and per mission §14, is a named immediate stop condition ("credentials are unavailable for a mandatory live gate"), not a defect to work around.

## What is different at A5 vs. A2's own live-role gate

Mission §12.5 is broader than §8.4 (A2's own matrix) in one respect: it asks for this to run "after integrated A2–A4 implementation." Since A4 is `NOT STARTED` (`A2A5_18`–`A2A5_22`), there is no additional A4 surface for this matrix to exercise beyond what A2's matrix would already cover — so even with credentials, this specific pass's incremental scope beyond `A2A5_09` would be limited to re-confirming the same A2/A3.3 surface, since A4 contributes nothing new to click through yet.

## Disposition

**BLOCKED**, same as `A2A5_09`. A5 cannot receive FULL PASS without this gate (mission §15.4). See `A2A5_31_TERMINAL_CERTIFICATION_REPORT.md` for the consolidated verdict and the exact Product Owner decision this leaves open.
