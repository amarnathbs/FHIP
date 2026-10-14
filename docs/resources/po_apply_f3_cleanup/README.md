# F3: removing the empty "Untitled" drafts (Product Owner step)

Date written: 06/10/2026. Evidence label: **the SQL is hand-written and was NOT executed on any database.** The same selection rules were run read-only on DEV through `scripts/resources/f3-untitled-draft-cleanup.ts` (dry run), which listed 35 removable drafts and 7 it will not touch. Run step 1 on production first and read the list.

## What this is

Before this fix, opening Create Article, Guide or FHIP Explainer made a record straight away, so every visit left an "Untitled Article" (or Guide, Explainer, Glossary Term) draft behind. This fix stops that. These two SQL files remove the ones already there.

## Safety rules built into the SQL

- Only drafts or ideas that were **never published**, never scheduled, and never saved after creation (`created_at = updated_at`).
- No excerpt, no category, no tags, no saved versions, no related or context links.
- Video records are never touched (an "Untitled Video" row is a real video).
- Anything someone edited, even slightly, is not listed and not removed.
- Every removal is written to the audit log with action `RESOURCE_DRAFT_DELETED`.

## How to run (Supabase SQL editor, production project)

1. Open `01_look_first.sql`, paste, run. It only reads. Check the list: every row should be a blank placeholder you recognise.
2. If the list is right, open `02_remove.sql`, paste, run. The result shows `removed` and `audited`; the two numbers must match and equal the number of rows in step 1.
3. Open All Content in the Admin and confirm the "Untitled" rows are gone.

If step 2 shows an error, nothing was removed (it is one statement). If you want to undo: removed drafts were empty placeholders; there is nothing of value to restore. The audit rows record what was removed.

## Pasting rules

Both files are plain ASCII, contain no percent signs, no dollar quotes and no semicolons inside comments, so the SQL editor accepts them as they are.
