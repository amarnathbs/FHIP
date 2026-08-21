# Database governance — open findings register

Living document for findings discovered during database-governance work
(migration reconciliation, RLS certification, schema audits) that are
deliberately **not** fixed in the pass that discovered them, so they don't
get lost. Scoped to `supabase/` and DB-adjacent work; application-level UX
findings live in their own registers (e.g.
`docs/phase1_ux_remediation_register.md`).

| ID | Status | Severity | Found in | Summary |
|---|---|---|---|---|
| `DB-BASE-0012` | **OPEN** | Low (latent, non-blocking) | Migration-lineage reconciliation, pre-application closure pass, 2026-08-21 | `0012_module8_benchmark_seed.sql` foreign-keys into a `countries` table that no migration ever creates or seeds — only `supabase/seed.sql` does. A stock `supabase db reset` (migrations-only, no seed file) would fail at `0012`. This is a base-FHIP defect from before any of the II/Resources/Phase 0C/FDH work existed (`main`'s `0001`-`0030` chain), unrelated to the migration-numbering collision this reconciliation fixed. |
| `FDH1-F1` | OPEN | Low (disclosed, contained) | FDH-1 closure pass, 2026-08-21 | FK validation on FDH-1 tables can bypass RLS in a narrow way; confidentiality impact confirmed contained. See `docs/financial_data_hub_fdh1.md` / FDH-1 closure docs for full detail. Tracked here only as a cross-reference — FDH-1's own docs are authoritative. |

## DB-BASE-0012 — detail

- **Where:** `supabase/migrations/0012_module8_benchmark_seed.sql`
- **What:** contains one or more rows/statements with a foreign key
  referencing `countries(code)` (or equivalent), but no migration file in
  `0001`-`0049` contains `CREATE TABLE countries` or seeds it — the
  `countries` table is populated only by `supabase/seed.sql`, which is not
  part of the migration chain a `supabase db reset` replays.
- **Impact today:** none in practice, because this project has never run a
  stock `supabase db reset` against DEV (or any environment) — every
  migration has been applied by hand via the Supabase Dashboard SQL editor,
  and `seed.sql` has always been run early enough (or `countries` has always
  already existed) that this FK never actually fails live. It is a
  **reproducibility** defect (a fresh, from-scratch `supabase db reset` would
  break at `0012`), not a currently-manifesting data-integrity defect. The
  offline PGlite replay in `scripts/db-rebuild-check/replay.mjs` works around
  it by explicitly running `seed.sql` immediately after `0001`, before
  `0012` runs — see the script's own comments.
- **Status: OPEN, PRE-EXISTING, explicitly OUT OF SCOPE for this
  reconciliation.** Per the dispatch instructions for this pass, this finding
  is disclosed and tracked, not fixed. A future pass that wants a truly
  from-scratch `supabase db reset` (migrations only, no manual seed step) to
  work would need to either move the relevant `countries` seed rows into an
  early migration or make `0012`'s foreign key deferrable/nullable until
  seeded.
- **Not to be fixed as a side effect of any other DB-governance task** unless
  a Product Owner explicitly authorizes it.
