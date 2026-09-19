-- Data fix: correct already-persisted reversal-pairing mistakes for real
-- schemes whose statement was parsed BEFORE reclassifyReversedPurchasePairs()
-- existed in its current form (camsParser.ts, fixed 2026-09-19). Root cause
-- and the code fix itself: see that function's own header comment. This
-- migration only repairs rows that were parsed under an EARLIER version of
-- the pairing logic and never reprocessed since -- exactly the same
-- append-only situation as migration 0162 (UTI MNC Fund).
--
-- Every row below was individually verified, read-only, against real
-- production data before writing this migration (see the investigation
-- queries at the bottom of this file). Scoped by exact transaction id --
-- the narrowest possible scope, chosen deliberately because this bug's
-- correct fix is genuinely data-dependent (which specific row pairs with
-- which), not a single uniform pattern like 0162's wording-based fix.
--
-- WHY A DIRECT UPDATE, NOT A REPROCESS. Same reasoning as 0162:
-- ii_transactions is append-only at the application layer, and
-- transaction_type is one component of the duplicate-detection fingerprint
-- (fingerprint.ts) -- reprocessing would insert new, correctly-classified
-- rows ALONGSIDE the old wrong ones, double-counting every affected
-- transaction. This is a pure LABEL correction (transaction_type only --
-- date/amount/units/every other column is untouched and was already
-- correct), not a change to any economic fact.
--
-- SCOPE, SCHEME BY SCHEME:
--
-- Axis Large Cap Fund (INF846K01164): exactly one leftover mispair, found
-- among five total rejection events in this scheme's history. The other
-- four (2014-03-10, 2014-04-10, and BOTH 2016 same-magnitude-duplicate
-- rejections) were already correctly paired in production -- confirmed by
-- checking each rejection already has an exact-negation, reversal-typed
-- partner on record. The 2014-02-10 rejection did not: its purchase side
-- (id cb1e5cce) was left as 'sip', a real ~10,000 contribution that never
-- actually went through.
--
-- Franklin India Mid Cap Fund (INF090I01809): the real incident this
-- migration's motivating code fix was built for. Two unrelated same-day,
-- same-magnitude SIP series ("6/7" and "5/33") on 2016-02-08. The OLD
-- one-step-back algorithm wrongly reclassified the UNRELATED "5/33"
-- purchase (id dfa31944) as the rejection's pair (it was the row
-- immediately preceding the rejection in parse order), leaving the TRUE
-- target "6/7" purchase (id 4e1a1a0c) stuck as an uncancelled contribution.
-- This needs a TWO-SIDED fix: 4e1a1a0c corrected TO 'reversal', and
-- dfa31944 corrected BACK to 'sip' (its own wording, "Systematic
-- Investment Purchase - 5/33", is an unambiguous sip_purchase match with
-- no reversal keyword anywhere -- it was never a real rejection).
--
-- Kotak Mid Cap Fund (INF174K01DS9): three separate, single-instalment
-- rejections (2025-06-05, 2025-07-07, 2025-08-05), each with exactly one
-- unambiguous non-reversal candidate on the same date -- no duplicate-
-- magnitude ambiguity in any of the three, so no instalment-token tie
-- break was even needed to resolve them.
--
-- SBI Contra Fund (INF200K01362): investigated and found to have ZERO
-- reversal-typed transactions and ZERO unclassified rows in its entire
-- 194-row history (97 purchase + 97 fee, cleanly paired). Whatever data-
-- quality issue this scheme showed is NOT caused by the reversal-pairing
-- bug this migration fixes -- deliberately left untouched here rather than
-- forcing an unrelated "fix" onto data that isn't actually broken by this
-- defect. Needs its own separate investigation if the issue persists.

-- Run BEFORE applying, and record the actual values (expect exactly the
-- rows named above, each in the CURRENT/WRONG state described):
--   select id, transaction_type, source_description from ii_transactions
--   where id in (
--     'cb1e5cce-2e8a-44ad-be14-eb290d801e28',
--     '4e1a1a0c-8a07-459e-a280-52e47df8b0eb',
--     'dfa31944-1667-497f-9c80-367142f87a78',
--     'a7617cd0-2fe9-4660-adb9-386308616100',
--     'a408a853-4744-4dee-be11-05c49af81f14',
--     'bbd9326f-33b3-40d7-987f-c863670e7851'
--   );

-- Axis Large Cap Fund: 2014-02-10 purchase side of a rejected instalment.
update ii_transactions
set transaction_type = 'reversal'
where id = 'cb1e5cce-2e8a-44ad-be14-eb290d801e28'
  and transaction_type = 'sip';

-- Franklin India Mid Cap Fund: the TRUE "6/7" target, wrongly left as sip.
update ii_transactions
set transaction_type = 'reversal'
where id = '4e1a1a0c-8a07-459e-a280-52e47df8b0eb'
  and transaction_type = 'sip';

-- Franklin India Mid Cap Fund: the UNRELATED "5/33" contribution, wrongly
-- reclassified as reversal by the old bug -- restored to its real type.
update ii_transactions
set transaction_type = 'sip'
where id = 'dfa31944-1667-497f-9c80-367142f87a78'
  and transaction_type = 'reversal';

-- Kotak Mid Cap Fund: three single, unambiguous rejected instalments.
update ii_transactions
set transaction_type = 'reversal'
where id = 'a7617cd0-2fe9-4660-adb9-386308616100'
  and transaction_type = 'purchase';

update ii_transactions
set transaction_type = 'reversal'
where id = 'a408a853-4744-4dee-be11-05c49af81f14'
  and transaction_type = 'purchase';

update ii_transactions
set transaction_type = 'reversal'
where id = 'bbd9326f-33b3-40d7-987f-c863670e7851'
  and transaction_type = 'purchase';

-- Run AFTER applying, and confirm every row now shows the target type
-- from the comment above (five 'reversal', one 'sip'):
--   select id, transaction_type, source_description from ii_transactions
--   where id in (
--     'cb1e5cce-2e8a-44ad-be14-eb290d801e28',
--     '4e1a1a0c-8a07-459e-a280-52e47df8b0eb',
--     'dfa31944-1667-497f-9c80-367142f87a78',
--     'a7617cd0-2fe9-4660-adb9-386308616100',
--     'a408a853-4744-4dee-be11-05c49af81f14',
--     'bbd9326f-33b3-40d7-987f-c863670e7851'
--   );
--
-- And confirm each scheme's reversal-typed count now matches the number
-- of genuine rejected instalments in its real history:
--   select ii_instruments.instrument_name, ii_transactions.transaction_type, count(*)
--   from ii_transactions
--   join ii_instruments on ii_instruments.id = ii_transactions.instrument_id
--   where ii_instruments.isin in ('INF846K01164', 'INF090I01809', 'INF174K01DS9')
--   group by ii_instruments.instrument_name, ii_transactions.transaction_type
--   order by 1, 2;
