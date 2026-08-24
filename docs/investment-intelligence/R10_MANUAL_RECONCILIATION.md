# II-R10 — Manual Reconciliation

**Status: NOT RUN.** 0/30. No manual reconciliation against canonical
source APIs was performed this session beyond the automated
source-module-assertion unit tests in `tests/unit/reportsIIChapters.test.ts`
(which verify the chapter builders pass fixture engine output through
unchanged, not that a real live report's numbers match a real live II
API response for the same user).

This is a genuine, disclosed gap — reaching 30 manual reconciliations (5
Free, 10 standard Premium, 5 investment-heavy, 5 goals/forecast-heavy, 3
incomplete-data, 2 cross-border) requires real users with real, varied II
data, which was not seeded this session (see
`R10_TESTING_AND_VERIFICATION.md` for why: seeding realistic R4/R5/R6/R9
data end-to-end — real transactions, holdings, tax lots — was judged out
of reach for this session's remaining time after the security foundation
work and the core chapter implementation).
