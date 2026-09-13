# AIE-1 — II/FDH Original-Bytes-At-Accept-Time Dependency: Why, and What Was Done About It

Raised by the Product Owner: *"Your agreed behaviour is to delete PDFs once
extraction and validation have produced durable structured results. II and
FDH currently need the original at acceptance. The developer should
establish why and, where possible, make acceptance consume the validated
structured payload."*

## 1. Why, exactly (read from the real code, not assumed)

**Investment Intelligence** (`lib/aie/adapters/investment-intelligence/write.ts`):
AIE's own accept-time write inserts exactly one row itself
(`ii_source_documents`) and then delegates the ENTIRE canonical write —
accounts, instruments, transactions, holdings, reconciliation, certification —
to `processSourceDocument()`, Investment Intelligence's **own, real,
already-certified orchestrator** (`lib/services/investment-intelligence/documentProcessing.ts`).
That function does not accept "here is a pre-extracted JSON payload" as
input at all — its actual, only, certified contract is "here is a
`sourceDocumentId` whose storage row points at a real document; I will
parse it myself, the same way I parse every normal user upload." AIE's own
extracted candidate fields (from `runExtractionPipeline`) were only ever
used for the **review/reconciliation-preview UX AIE shows the user before
acceptance** — they were never II's actual source of truth for the write.

**FDH-bank** (`lib/aie/adapters/fdhBankStatement/atomicImport.ts`): the
exact same pattern, and the module's own header already discloses the
trade-off explicitly: FDH-5's own `uploadBankPdf` → `processBankPdfDocument`
services are called unmodified, meaning "the bytes are classified/
reconstructed twice... a deliberate trade-off for keeping FDH-5's
already-certified write path completely unmodified rather than threading a
precomputed result through it."

**Both adapters made the identical, deliberate design choice, for the
identical reason: reuse the module's own real, certified write path exactly
as the normal (non-AIE) upload flow uses it, rather than inventing a second,
AIE-only write path that trusts AI-extracted JSON as ground truth.** This
is not an oversight — it is the direct consequence of this whole
programme's own most-repeated rule, stated in the original closure
mission itself: *"never invent balancing entries,"* generalized here to
*"never invent a second canonical-write contract a real financial module
was never designed to accept."*

## 2. Was "make acceptance consume the validated structured payload" attempted?

**No — and here is the reasoning for not attempting it, not just a refusal:**

Making II's or FDH's acceptance consume AIE's own structured payload
directly, instead of re-parsing original bytes, would require one of:

1. **A new write path inside II/FDH that trusts AIE's extracted JSON as
   truth**, bypassing `processSourceDocument()`/`processBankPdfDocument()`
   entirely. This reintroduces exactly the risk this architecture was built
   to avoid: an AI-extraction result becoming a financial system's source
   of truth without that system's own real parser/reconciliation ever
   running against it. It would also mean maintaining a second, parallel
   canonical-write implementation for every future II/FDH schema change —
   a durable, compounding maintenance liability, not a one-time fix.
2. **Modifying II's or FDH's own real, certified orchestrator** to accept
   pre-extracted data as an alternate input mode. This touches
   already-production-certified code (`documentProcessing.ts`,
   `bankPdfProcessingService.ts`) outside AIE's own module boundary, without
   the "deep familiarity with the live schema" the original closure report's
   own §9.1 already named as the reason NOT to rush a comparable change
   (the Investment Intelligence HTTP-route gap) — the same caution applies
   here with at least as much force, since this would mean changing a
   write path other, non-AIE callers also depend on.

**Neither option was attempted.** Both are real engineering possibilities
for II's/FDH's own programmes to consider on their own timeline, with their
own module owners' sign-off — not a change AIE-1 should make unilaterally
under a verification/closure pass, and not a gap this analysis is
downplaying: it is a genuine, structural limit on how early AIE can delete
these two adapters' original bytes.

## 3. What WAS done: closing the actual named risk — "never accepted" retention

The Product Owner's real concern was named precisely: *"a user who never
accepts could leave the PDF retained until cleanup; that limit must be
implemented and verified."* This is answerable without touching II/FDH's
write paths at all, because retention duration and canonical-write design
are two separate concerns.

**Already implemented** (prior closure-mission work, `lib/aie/services/purge.ts#enforceAieRawFileHardBackstop`):
a generic, adapter-agnostic, age-based hard backstop — ANY `aie_document_intake`
row with a non-null `storage_key`, older than 24 hours, not already
purged/in-progress, gets its original bytes scheduled for deletion
regardless of adapter, regardless of whether acceptance ever happened.
This is not new work; it already existed and already covers the II/FDH
"never accepted" case structurally, by construction (the function has no
adapter-specific branch at all).

**Not previously verified against real DEV data — attempted this session,
and found genuinely blocked**: a direct read against DEV's
`aie_document_intake.purge_status` column (the column
`enforceAieRawFileHardBackstop`/`findDuePurges`/`runPurgeAttempt` all
require) fails with `column aie_document_intake.purge_status does not
exist` — migration `0149` has not been applied to DEV yet (see
`AIE_1_EXTERNAL_DEPENDENCIES_REGISTER.md`, item 4). **This is the actual
reason the 24-hour backstop is "implemented, not yet verified" — not
because the mechanism doesn't exist or wasn't tested at the unit level
(`tests/unit/aiePurgeService.test.ts` already covers it), but because the
one DB column its live behavior depends on isn't in DEV yet.**

## 3a. 2026-09-13 update — verified live, migration 0149 now applied

The Product Owner applied migration `0149` to DEV. Both previously-blocked
verifications are now done, live, with real evidence:

- **Insurance's full immediate-deletion path** (storage delete AND DB
  bookkeeping together, not just the storage half) re-run end-to-end —
  `storage_key` now correctly clears and `status` correctly flips, closing
  the previously-disclosed gap exactly.
- **The 24-hour hard backstop** (`scripts/aiecl_24h_backstop_live_dev.ts`,
  16/16 PASS): a genuinely-backdated (`created_at` −25h), never-accepted
  intake row with a real quarantine object was found by the sweep
  (`scanned:1`), scheduled, and genuinely purged — its real storage object
  deleted, its DB status flipped. A fresh negative-control row was
  confirmed completely untouched, proving the age filter is real. Zero
  residue.

**This directly and completely closes the Product Owner's stated concern**:
the bound on "how long can an unaccepted II/FDH PDF remain" is now
verified, live, at 24 hours — not merely implemented and asserted.

## 4. Conclusion and recommendation

- **Do not build a workaround that lets acceptance consume AIE's own
  extracted payload directly.** The dependency is structural and
  deliberate; removing it would trade a disclosed, bounded, time-limited
  retention window for a durable architectural risk (a second,
  AI-trusting write path, or a modification to another module's certified
  code outside this session's authority and familiarity).
- **The real, closeable gap is verification, not implementation**: once
  migration `0149` is applied to DEV, live-DEV proof that a genuinely-aged
  (backdated `created_at`), never-accepted II/FDH-shaped intake row is
  correctly swept and its storage object genuinely deleted is a same-day,
  low-risk task this session is ready to run immediately.
- This closes the Product Owner's stated concern precisely: the bound on
  "how long can an unaccepted PDF remain" is **24 hours, structurally,
  regardless of adapter** — not "until cleanup" in the sense of
  indefinite/unbounded retention. What remains is proving that bound live,
  not designing a new one.
