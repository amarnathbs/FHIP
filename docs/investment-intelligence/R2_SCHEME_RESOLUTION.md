# R2 — Scheme / Instrument Resolution

Status: FINAL

## 1. The priority-ordered resolver (spec section 17)

`schemeResolution.ts`'s `resolveScheme()` — a pure, fully deterministic function, tested independently of any DB, implementing the exact priority order the spec requires:

1. **ISIN** (globally unique — matched regardless of country, mirroring the R1 partial-unique-index design for `ii_instrument_identifiers`).
2. **AMFI scheme code** (country-scoped).
3. **Exact approved source identifier** (`internal_provisional` scheme, country-scoped — for RTA-native codes that are neither ISIN nor AMFI).
4. **Normalised scheme name + plan/option + AMC + country** — an EXACT match on the normalised string (lower-cased, whitespace-collapsed, punctuation-normalised via `parsers/textUtils.ts`'s `normaliseSchemeName()`), never a fuzzy/approximate match. Confidence 0.85 (lower than an identifier match, since scheme-name collisions are a real, if rare, risk).
5. **Controlled alias mapping** (`ii_scheme_alias_map`, migration `0041`) — a curated, admin/system-populated reference table for cases like a genuinely renamed scheme, or two RTAs printing the same scheme with cosmetically different punctuation. **Never auto-populated by fuzzy-match acceptance** — a row here represents a reviewed decision.
6. **Manual reconciliation** — if nothing above matches, the function returns `'unresolved'` and the caller decides what to do (see section 2).

At every priority level, if **more than one** existing instrument matches, the outcome is `'ambiguous'` (never picks one silently) — directly satisfying spec section 17's "ambiguous mappings must create a reconciliation case" and the critical-failure-condition "parser silently maps ambiguous scheme incorrectly."

## 2. What happens on `unresolved` vs `ambiguous`

- **`unresolved`** (genuinely new scheme, zero candidates): the orchestrator creates a new **provisional** `ii_instruments` row (ADR-002's existing R1 pattern — a provisional instrument gets a real UUID immediately so transactions can reference it without waiting on master-data enrichment) and records its ISIN/AMFI identifiers if the statement provided them. This is **not** treated as a blocker — a first-time-seen legitimate scheme is expected, ordinary behaviour, not an error.
- **`ambiguous`** (multiple candidates, genuinely cannot tell which): an `AMBIGUOUS_INSTRUMENT` reconciliation case is opened (severity `high`), and certification for any position depending on that resolution is blocked (`instrumentUnresolved = true` in `certification.ts`'s evaluation) until a human resolves it.

## 3. Mutual fund variant identification (spec section 18)

Direct-vs-Regular and Growth-vs-IDCW are, in AMFI reality, **different schemes with different ISINs/AMFI codes** — R2 does not invent a second identity axis for this. Each variant is its own `ii_instruments` row (matching R0's "a specific security/fund/scheme" contract), with two new descriptive/filterable columns (migration `0041`): `plan_type` (`direct|regular|not_applicable`) and `option_type` (`growth|idcw|dividend_payout|dividend_reinvestment|not_applicable`), plus `amc_name`. `parsers/textUtils.ts`'s `detectPlanType()`/`detectOptionType()` derive these from the scheme name text deterministically (regex on `\bdirect\b`/`\bregular\b`/`\bgrowth\b`/`\bidcw\b`/`\bdividend\b`/`reinvest`/`payout`). Distinct plan/option identifiers are never collapsed into one instrument merely because the base scheme name looks similar — proven directly in `tests/unit/iiR2SchemeResolution.test.ts` and in the `cams-direct-vs-regular-plan`/`kfin-direct-vs-regular-plan` golden fixtures (two schemes, same AMC, same base name, different ISIN/plan — resolve to two distinct instruments, two distinct closing holdings).

## 4. Renamed/merged scheme

`ii_instruments.merged_into_instrument_id` (R1, unchanged) remains the mechanism for reconciling a provisional instrument into a verified master record without breaking existing FKs. `ii_scheme_alias_map` (priority 5 above) is the mechanism for a scheme whose printed NAME changed across statement periods (an AMC rename, a merger) while the ISIN/AMFI code is unavailable in a given statement — a curated alias row lets the SAME instrument still resolve correctly. This is exercised in `tests/unit/iiR2SchemeResolution.test.ts`'s "priority 5" test rather than as its own dedicated golden CAS fixture (a genuinely faithful renamed-scheme fixture would need two full statements spanning a rename event, which is better proven at the resolver-unit level where the exact alias-row shape can be asserted directly) — honestly scoped, documented in `R2_GOLDEN_FIXTURE_CATALOG.md`.

## 5. What R2 does NOT do here

No fund overlap/look-through, no X-ray analytics, no benchmark assignment beyond what R1's schema shape already reserves — `ii_fund_holdings`/`ii_benchmarks`/`ii_instrument_benchmarks` remain untouched, empty tables, exactly as R1 left them (explicit non-goal, spec section 3).
