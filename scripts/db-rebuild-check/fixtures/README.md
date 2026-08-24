# Fixtures

`seed_master_items_pre_air_consolidation.sql` is a frozen copy of
`supabase/seed_master_items.sql` exactly as it stood before the Assets,
Investments & Retirement Consolidation release (migrations 0072-0074),
i.e. it still contains the cross-module duplicate catalogue items (Shares
in both Assets and Investments, SMSF in three places, etc).

It exists purely so `scripts/air_consolidation_certification.mjs`'s
populated-DEV-upgrade replay (DB-02) can seed a PGlite database with the
same catalogue shape real DEV actually has today, then apply 0072-0074 on
top of it — proving the migration corrects a genuinely pre-fix catalogue,
not a catalogue that was already fixed before the test ran. Do not edit
this file to match new changes to `supabase/seed_master_items.sql`; it is
deliberately a historical snapshot.
