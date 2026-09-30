# BENCH-1 — DEV synthetic-row cleanup mutation ledger

**Date:** 2026-09-30
**Environment:** DEV only (`vqycarelcoijzwlpkpcz.supabase.co`). Production was not touched (remains
GET-only throughout; production's three tables were already at 0 rows — see BENCH1_B1_DISCOVERY).
**Authorization:** Product Owner, via coordinator message, explicit conditions reproduced below.
**Independent corroboration:** the same 14 rows were already identified as synthetic by a prior,
unrelated session — `PC6_MARKET_DATA_CERTIFICATION_2026-09-15.md` §3.6 (`PC6-LD-39`): *"DEV was
checked: of its 14 benchmark rows, zero are named after a real licensed index — they are all
pre-PC6 R4/R5 synthetic test fixtures."* This dispatch re-verified that finding independently
before acting on it, five months later, using this session's own PostgREST access.

## 1. Positive trace performed before any delete

1. Exported full row content (not just IDs) of `ii_benchmarks`, `ii_benchmark_series`,
   `ii_instrument_benchmarks` from DEV — saved as `pre_delete_*.json` in this folder.
2. Re-verified counts matched the original B1 discovery baseline exactly: 14 / 199 / 14. No drift
   since the discovery pass earlier this session.
3. Confirmed all 14 `ii_benchmarks.benchmark_key` values match the synthetic pattern
   (`VCVC0[0-9]{9,}...`/`MR[0-9]{9,}...`, epoch-millisecond suffixes) — none is a real index name.
4. Extracted the distinct `benchmark_id` values referenced by all 199 `ii_benchmark_series` rows
   and all 14 `ii_instrument_benchmarks` rows, and confirmed (via `comm -23`, i.e. set difference)
   that **every single one** is a member of the same 14-id set — zero series rows and zero mapping
   rows pointed at anything outside the synthetic set. No ambiguous or partially-traced row existed.
5. Searched schema for every foreign key pointing at these three tables
   (`grep "references ii_benchmarks\|references ii_benchmark_series\|references ii_instrument_benchmarks"`
   across all migrations). Found:
   - `ii_benchmark_category_defaults.benchmark_id -> ii_benchmarks(id)` — **0 rows in DEV**, so no
     dependent existed.
   - `ii_benchmark_series.superseded_by_id -> ii_benchmark_series(id)` (self-referential) — checked
     all 199 rows; every `superseded_by_id` was `null`. No supersede chain to unwind.
6. Checked `ii_reference_corrections` (the one other place a correction could reference these rows)
   — it had 3 rows, all `target_table: "ii_prices_nav"` (real AMFI NAV corrections, unrelated).
   **Zero rows referenced any of the three benchmark tables.**

No row outside the traced 14+199+14 set was touched. No other table was written.

## 2. Deletions performed (DEV only), in dependency order

| Order | Table | Filter | Rows deleted | HTTP status | Verified via |
|---|---|---|---|---|---|
| 1 (children) | `ii_instrument_benchmarks` | `benchmark_id=in.(<14 ids>)` | **14** | 200 | `Prefer: return=representation` — 14 full rows returned, ids match |
| 2 (children) | `ii_benchmark_series` | `benchmark_id=in.(<14 ids>)` | **199** | 200 | `Prefer: return=representation` — 199 full rows returned |
| 3 (parent) | `ii_benchmarks` | `id=in.(<14 ids>)` | **14** | 200 | `Prefer: return=representation` — 14 full rows returned, ids match the traced set exactly |

Full pre-delete row content: `pre_delete_ii_benchmarks.json`, `pre_delete_ii_benchmark_series.json`,
`pre_delete_ii_instrument_benchmarks.json`.
Full delete-response row content (proves exactly which rows were removed):
`delete_response_ii_benchmarks.json`, `delete_response_ii_benchmark_series.json`,
`delete_response_ii_instrument_benchmarks.json`.

The 14 deleted `ii_benchmarks.id` values:
`181dff65-035e-45b7-9827-9f0704461015`, `3858f2e5-a56e-4f46-a487-f107b59aa535`,
`42d8a861-c14d-46b5-8e2d-2c085d53274d`, `4babef9a-8018-4afb-bad7-8043928c6c8f`,
`683f0a52-afcb-43bc-ab53-245561a42c96`, `7224d4e6-d5ed-4925-899a-e2aa71566377`,
`855df188-7307-4a1e-9763-e6437788d733`, `8cceaa71-7e19-47b2-aadc-9648f4fd72e3`,
`922abd52-77b0-48e7-a5e7-4b54baec5171`, `92ae8c7a-1b7f-42e7-8584-15157a363f5c`,
`a4a527f8-19d0-4f54-9b9a-f6d73963de65`, `a7c14c5f-f540-4bd0-bd20-950a5887465b`,
`da6594ec-b1b6-4edb-887c-7ffb7236e348`, `f3f7a578-afe9-489b-b4df-bf2df20e1d9e`.

## 3. Before/after counts (re-queried independently after the deletes)

| Table | Before | After |
|---|---|---|
| `ii_benchmarks` (DEV) | 14 | **0** |
| `ii_benchmark_series` (DEV) | 199 | **0** |
| `ii_instrument_benchmarks` (DEV) | 14 | **0** |
| `ii_benchmarks` (production) | 0 (unchanged) | 0 (unchanged, not touched) |
| `ii_benchmark_series` (production) | 0 (unchanged) | 0 (unchanged, not touched) |
| `ii_instrument_benchmarks` (production) | 0 (unchanged) | 0 (unchanged, not touched) |

DEV and production now agree: all three tables are genuinely empty everywhere, with no leftover
test pollution. This is the clean baseline BENCH-1's real seeding work should start from.

## 4. What this ledger is not

No `BEGIN`/`COMMIT` transaction wraps the three DELETE calls (PostgREST does not expose
multi-statement client transactions over REST; each DELETE is atomic in isolation, and the
dependency order above — children before parents — makes an inconsistent intermediate state
unreachable even without a wrapping transaction, since each step is independently a no-op unless
the whole positive trace above holds). No table other than the three named was written. No
production row was created, modified, or deleted.
