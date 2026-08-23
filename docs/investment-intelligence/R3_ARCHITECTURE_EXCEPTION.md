# R3 — Architecture Exception

Status: FINAL (R3)

The R3 brief instructs: "Do not replace this architecture unless implementation reveals a genuine blocking contradiction — if so, document it in `R3_ARCHITECTURE_EXCEPTION.md` rather than silently deviating." Two genuine, concrete contradictions were found between the frozen R0 architecture and the actual live schema. Both are documented here, both were resolved with the smallest possible, fully additive/backward-compatible change, and neither required abandoning any R0 principle — only correcting an R0 assumption that turned out not to match the real schema once implementation began (exactly the class of finding R0 itself anticipated: "confirmed against live code," not assumed).

## Exception 1 — `investments.owner` is a role enum, not a `household_members` foreign key

**The R0 claim** (`R0_FHIP_PUBLISHING_CONTRACT.md`, OWNER section): "canonical legal/household owner — `ii_accounts.owner_member_id` (once confirmed) resolved to a `household_members.id`, published into `investments.owner`."

**What the actual schema says** (`supabase/migrations/0004_financial_data_grid.sql` lines 59-61): `investments.owner` is `text not null default 'self' check (owner in ('self','spouse','joint','child','family_trust','company','smsf','other'))` — a fixed ROLE enum, not a UUID column, and has no foreign-key relationship to `household_members` at all. `household_members.id` cannot be written into `investments.owner` — the column's type and check constraint make it a compile-time/runtime impossibility, not a stylistic choice.

**Resolution**: `investments.owner` is populated from the resolved `household_members.relationship` value (self/spouse/partner/child/parent/other_dependant/other — migration `0009`), mapped to the closest FHIP owner-enum value via `mapRelationshipToOwner()` (`lib/services/investment-intelligence/publicationLogic.ts`): `self→self`, `spouse→spouse`, `partner→spouse`, `child→child`, `parent/other_dependant/other→other`. The actual `household_members.id` that produced this mapping is retained separately, on `ii_fhip_publications.owner_member_id` (migration `0042`), so the precise household member is never lost — only the *role enum written into the existing FHIP column* is a mapped value, exactly as the existing FHIP grid itself already requires of every manually-entered row (no manual investment row in this app has ever stored a `household_members.id` in `owner` either — this was already how the column worked before R3 existed).

**No schema change was needed to resolve this** — it is a mapping-function correction, not an architecture change. `R3_FHIP_MAPPING_SPEC.md` documents the exact mapping table.

## Exception 2 — `investments` unique(user_id, master_item_key) blocks more than one certified position per category

**The R0 claim** (`R0_FHIP_PUBLISHING_CONTRACT.md` section 1, `R0_NET_WORTH_DEDUP_CONTRACT.md` section 1): "Publishing is implemented as one `ii_fhip_publications` row per canonical position mapping onto exactly one `investments`/.../row" — read most naturally, this implies each certified position gets its own `investments` row.

**What the actual schema says** (`supabase/migrations/0004_financial_data_grid.sql` line 68): `investments` carries `unique (user_id, master_item_key)`. `lib/services/registry.ts`'s `save()` upserts on this exact key (`onConflict: 'user_id,master_item_key'`) — the FHIP Investments grid is a fixed, pre-populated spreadsheet with **at most one row per catalogue item per user** (e.g. exactly one `managed_funds` row, ever, for a given household — `owner` does not participate in the unique key either). A household holding two or more distinct certified mutual fund positions (the overwhelming common real case for any Indian retail investor with more than one SIP) would violate this constraint the moment a second position tried to publish with `master_item_key='managed_funds'` set — a real, DB-enforced blocking contradiction, not a hypothetical one.

**Resolution** (migration `0042`, section 2): the table-level `unique(user_id, master_item_key)` constraint is dropped and replaced with an equivalent **partial** unique index scoped to `source_type='manual'` rows only:

```sql
create unique index uidx_investments_user_master_manual
  on investments(user_id, master_item_key)
  where source_type = 'manual';
```

Every existing row defaults to `source_type='manual'` (the new column's default), so this reproduces the **exact prior behaviour, unchanged, for 100% of existing manual data** — the manual spreadsheet grid still allows exactly one row per catalogue item, exactly as before. Investment-Intelligence-published rows (`source_type='investment_intelligence_published'`) are exempted from this constraint and instead governed by a **stronger, more precise** guarantee: `uidx_ii_fhip_publications_one_active_position`, a partial unique index on `ii_fhip_publications(account_id, instrument_id) where status='published'`. This enforces "one active publication per *economic position*" — the actual no-double-counting invariant the release exists to prove — at a finer grain than "one row per category" ever provided, and it is enforced on the table that is specifically designed to be the single source of dedup truth (`R0_NET_WORTH_DEDUP_CONTRACT.md` section 1), not repurposed from a constraint designed for an unrelated UX concern (re-checking a grid checkbox).

**Why this is not a silent deviation**: the manual-entry guarantee is preserved byte-for-byte (same behaviour, same constraint shape, same column pair, just narrower scope). No R0 principle is violated — `R0_NET_WORTH_DEDUP_CONTRACT.md`'s stated mechanism ("never insert a second row into investments for a position it has already published... single-target-per-position publishing") is honoured exactly; this exception only concerns *distinct* certified positions each getting their own row, which R0's own worked example (`R0_FHIP_PUBLISHING_CONTRACT.md`'s INSTITUTION section) already anticipated needing ("Portfolio-level aggregation... may show 'Multiple AMCs'... this is a display concern for a future release's portfolio summary UI, **not a publishing-time transformation of the per-row institution value**" — i.e. R0 itself expected per-row, per-position publishing, not a single aggregated row).

## No other exceptions

Every other R0/R1/R2 contract examined during R3 implementation (net-worth formula, FX architecture, Forecasting interface, Goal integration, audit vocabulary extension pattern, RLS discipline, `ii_fhip_publications`'s core purpose and lifecycle direction) matched the real code and real schema exactly as documented, and required no exception — only additive extension, per the patterns each contract itself specified. See `R3_PUBLISHING_ARCHITECTURE.md` for the full implementation-vs-contract trace.
