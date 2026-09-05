# A1.3 — Analytics and Suppression Architecture Boundary

**PO-7: APPROVED** — the Product Owner retains both existing provisional minimums (§3: minimum displayed cell size **5**; minimum distinct people **10**) and additionally requires every one of the following, binding on whatever builds the canonical suppression engine (A4, per §2): complementary suppression (already inherited, §3); protection against subtraction and differencing attacks (already inherited, §3); **no individual drill-down**; **no exact pseudonymous financial profiles**; **rounding or bands for sensitive financial measures**; **controls against repeated filters reconstructing a suppressed group** (a stricter, explicit restatement of the inherited "filter-combination reconstruction resistance"); **identical protections for on-screen results, APIs, and exports** (already inherited as "identical treatment across SQL/API/UI/CSV/PDF"); **keyed-HMAC pseudonymization where stable pseudonyms are genuinely required** (already resolved in principle by `REG-10`, `A1_13` §2 rule 6 — PO-7 reconfirms it applies specifically to Analytics, not just the general privacy standard); and **privacy review before introducing any new dimension or export**. §3 below is updated to fold these in as one list, not two overlapping ones.

## 1. The central fact this document exists to preserve

**`FHIP_ADMIN_ARCHITECTURE_STANDARD.md` §7's suppression model has never been implemented anywhere in FHIP** — confirmed independently by Admin A0.2 Wave 6 and the FDH-13 baseline. The one Admin feature that ever exposed individual-level data (Recommendations Gap Review) was **withdrawn entirely** rather than given a first, feature-specific suppression implementation. This was a deliberate choice, not an oversight: `REG-15` (binding Product Owner ruling) resolves that **the canonical Admin Analyst/Analytics architecture builds the suppression engine first, generically, and every domain — FDH, Resources, Recommendations — consumes it. No domain may build its own competing implementation.**

## 2. Ownership boundary (binding)

| Question | Answer |
|---|---|
| Who builds the first suppression engine? | The canonical Admin Analytics/Privacy architecture (A4, per `A1_20`) |
| What if FDH-13 Wave E is authorised before the canonical engine exists? | Wave E builds it *as* that canonical component (generic, Resources-adoptable) and hands ownership to the canonical architecture — it does not retain FDH ownership |
| What does the Analyst Analytics implementation track (separate workstream) do? | **Consumes** the canonical engine once it exists; must never build a competing suppression implementation of its own — restated explicitly per the brief |
| What does Recommendations do? | Consumes the same engine for its eventual Gap Review aggregate replacement — never builds its own |
| What does A1 build? | Nothing — this document is the boundary and the inherited thresholds, not an implementation |

## 3. Inherited suppression model (Standard §7, restated so this document is self-contained — not a new model) — PO-7-approved, additional protections folded in

Minimum cell count, minimum distinct-person count, dominance protection, primary suppression, **complementary suppression** (a primary-suppressed cell forces at least one further cell in the same exhaustive partition to also be suppressed, or the whole partition returns `unavailable` — defeats subtract-from-a-known-total reconstruction), totals/subtotals/denominators/ratios must not leak a hidden value, cross-metric/cross-RPC reconstruction resistance, filter-combination reconstruction resistance (PO-7: explicitly includes **repeated-filter reconstruction** — re-running the same query with slightly different filter combinations must not let an operator triangulate a suppressed group), repeated-query/differencing-attack resistance (recomputed fresh per call, safe under the ≥2-unknowns-per-partition rule regardless of timing — Standard §7.1), snapshot-change resistance, cached-result resistance, identical treatment across SQL/API/UI/CSV/PDF (PO-7 reconfirms: on-screen results, APIs, and exports get the identical protection — no export-only or API-only bypass), and the public-content-data vs. user-derived-behavioural-data distinction (the latter always gets the full model).

**PO-7's four additional, explicitly named protections (not previously spelled out this granularly in the Standard):**
1. **No individual drill-down** — no Analytics destination may let an operator narrow a result down to a single identifiable person, regardless of role.
2. **No exact pseudonymous financial profiles** — even a keyed-pseudonym-labelled row must never expose an exact, un-rounded financial figure attributable to that pseudonym.
3. **Rounding or bands for sensitive financial measures** — any financial figure in an Analytics result must be rounded or banded, never exact, once it is sensitive enough to matter under the 7-class scheme (`A1_13` §1).
4. **Privacy review before introducing new dimensions or exports** — adding a new groupable dimension or a new export format to any Analytics destination requires a privacy review before it ships, not only at initial design time.

**Provisional thresholds (Standard §7.2, already approved, not re-derived here; retained unchanged by PO-7):** minimum cell count **5**; minimum distinct people **10**; minimum evaluation runs **20**. Explicitly *"starting controls... require pre-production revalidation against real data distributions before this standard is applied to a production release."*

**Keyed-HMAC pseudonymization (PO-7 reconfirms `REG-10`, `A1_13` §2 rule 6, applied specifically to Analytics):** where a stable pseudonym is genuinely required (e.g. tracking the same anonymous cohort across two time periods), it must be a keyed HMAC derived server-side, secret held outside the database, versioned key identifier, no raw user UUID ever in an Analytics-visible result, no reversible lookup exposed to any administrator. Suppression still applies on top — pseudonymization is never a substitute for aggregation, restated here because Analytics is the first concrete consumer likely to need stable pseudonyms at all.

**Result-state contract (Standard §8):** `ok` / `suppressed` (fixed label **"Insufficient data to display safely."**) / `unavailable` / an explicit denial (never a fourth successful data state) — already defined, reused verbatim by every consumer.

## 4. Recommendations Gap Review's designed-not-built replacement

Per Wave 5's own privacy closure design (`A02_WAVE5_GAP_REVIEW_PRIVACY_CLOSURE.md` §6): minimum cell size 5, minimum distinct people 10, complementary suppression, no exact figures, no direct identifiers. **This is the first concrete consumer this document names** — when the canonical engine exists, this is the aggregate feature that replaces ADM-06's permanent withdrawal, not a resurrection of the original identifiable-data feature.

## 5. FDH-13's `canViewFdhAnalytics` (CAP-26 / ADM-37)

The one FDH-13 capability that maps cleanly onto an existing role (Analyst) precisely because it is defined the same way — aggregate, suppressed, read-only. It **consumes** the canonical engine (§2), consistent with `REG-15`; it does not get a bespoke FDH suppression implementation even though it is often the most likely first real caller of the engine.

## 6. What A1 does

Defines the boundary (§2) and inherits the model (§3) — a governance document, not an engine. `A1_20`'s roadmap places actual construction in A4, with FDH-13 Wave E as the possible-first-builder-on-canonical-owner's-behalf contingency already resolved by `REG-15`.
