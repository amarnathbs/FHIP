# A1.3 — Analytics and Suppression Architecture Boundary

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

## 3. Inherited suppression model (Standard §7, restated so this document is self-contained — not a new model)

Minimum cell count, minimum distinct-person count, dominance protection, primary suppression, **complementary suppression** (a primary-suppressed cell forces at least one further cell in the same exhaustive partition to also be suppressed, or the whole partition returns `unavailable` — defeats subtract-from-a-known-total reconstruction), totals/subtotals/denominators/ratios must not leak a hidden value, cross-metric/cross-RPC reconstruction resistance, filter-combination reconstruction resistance, repeated-query/differencing-attack resistance (recomputed fresh per call, safe under the ≥2-unknowns-per-partition rule regardless of timing — Standard §7.1), snapshot-change resistance, cached-result resistance, identical treatment across SQL/API/UI/CSV/PDF, and the public-content-data vs. user-derived-behavioural-data distinction (the latter always gets the full model).

**Provisional thresholds (Standard §7.2, already approved, not re-derived here):** minimum cell count **5**; minimum distinct people **10**; minimum evaluation runs **20**. Explicitly *"starting controls... require pre-production revalidation against real data distributions before this standard is applied to a production release."*

**Result-state contract (Standard §8):** `ok` / `suppressed` (fixed label **"Insufficient data to display safely."**) / `unavailable` / an explicit denial (never a fourth successful data state) — already defined, reused verbatim by every consumer.

## 4. Recommendations Gap Review's designed-not-built replacement

Per Wave 5's own privacy closure design (`A02_WAVE5_GAP_REVIEW_PRIVACY_CLOSURE.md` §6): minimum cell size 5, minimum distinct people 10, complementary suppression, no exact figures, no direct identifiers. **This is the first concrete consumer this document names** — when the canonical engine exists, this is the aggregate feature that replaces ADM-06's permanent withdrawal, not a resurrection of the original identifiable-data feature.

## 5. FDH-13's `canViewFdhAnalytics` (CAP-26 / ADM-37)

The one FDH-13 capability that maps cleanly onto an existing role (Analyst) precisely because it is defined the same way — aggregate, suppressed, read-only. It **consumes** the canonical engine (§2), consistent with `REG-15`; it does not get a bespoke FDH suppression implementation even though it is often the most likely first real caller of the engine.

## 6. What A1 does

Defines the boundary (§2) and inherits the model (§3) — a governance document, not an engine. `A1_20`'s roadmap places actual construction in A4, with FDH-13 Wave E as the possible-first-builder-on-canonical-owner's-behalf contingency already resolved by `REG-15`.
