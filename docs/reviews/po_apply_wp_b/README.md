# WP-B PO packs (Document2 (4): Review lifecycle and actions)

All three SQL files are READ ONLY. They change nothing, so no backup is needed. Run them on DEV first (project ref vqycarelcoijzwlpkpcz) in the Supabase SQL editor, in order, after replacing the placeholder email. Production has no managed backups: do not run any data-changing statement there from these packs, and none is provided.

| File | Answers |
|---|---|
| `01_readonly_open_case_classification.sql` | What every open case really needs (owner choice, instrument, classification, conflict, password and reprocess, information that no longer exists) and which action the app now offers |
| `02_readonly_owner_unmatched_causes.sql` | Why there are about 50 owner unmatched rows, which are repeats from reprocessing, and how many the app will close because the owner was already chosen |
| `03_readonly_review_item_regeneration.sql` | Review items that were dismissed and then raised again (should stop after the fix) |

No migration is required for this work package (range 0300-0303 unused). Every data change is performed by the app, per user, on an explicit user action (Close stale item, Upload replacement copy) or, for the two safe tidy-ups (an owner question for an account whose owner a person already chose, and exact duplicate cases), automatically when the Review tab opens, each audited and never deleting history. Nothing is ever assigned to Self or guessed.
