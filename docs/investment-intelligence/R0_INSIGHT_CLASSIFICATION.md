# R0 — Insight / Advice Classification

Status: FINAL (R0)
Depends on: `R0_CANONICAL_DATA_CONTRACT.md` (`ii_insights`), `lib/advice-boundary/` (existing FHIP gating precedent — see section 4)

## 1. The four classifications

### OBSERVATION
A neutral, factual statement about the user's own data — no interpretation, no implied judgement.
Example (spec-supplied): *"38% of the portfolio is exposed to three underlying companies."*

### EDUCATION
General financial-literacy context connected to an observation — explains a concept, does not tell the user what to do about their specific situation.
Example (spec-supplied): *"High concentration may increase portfolio-specific risk."*

### SIMULATION
A deterministic, assumption-labelled "what if" calculation — explicitly conditional, always states its assumptions, never a recommendation to act.
Example (spec-supplied): *"If ₹500,000 were redeemed, estimated exit load and tax under the selected assumptions would be ₹X."*

### PERSONALISED_ADVICE
A specific instruction to buy, sell, switch, or hold a specific instrument — tells the user what to do with their specific money.
Example (spec-supplied): *"Sell Fund A and purchase Fund B."*

OBSERVATION, EDUCATION and SIMULATION may be supported subject to appropriate product/legal review (not itself an R0/R1 deliverable — a compliance sign-off gate, not an engineering one). PERSONALISED_ADVICE remains gated and outside the normal consumer analytics workflow until separately approved (design principle 16) — enforced structurally, not just documented: `ii_insights` rows with `classification='personalised_advice'` carry `gated boolean not null default true` and require a non-null `compliance_approved_at` before the service layer will ever return them to a consumer-facing surface (`R0_CANONICAL_DATA_CONTRACT.md`).

## 2. Required fields per insight (per spec Section 13)

`classification`, `rule_code`, `rule_version`, `evidence`, `severity`, `assumptions`, `data_quality`, `created_at`, `status` — all frozen as columns on `ii_insights` in `R0_CANONICAL_DATA_CONTRACT.md` (`evidence`/`assumptions` folded into the `evidence jsonb` column; `data_quality` sourced from the underlying `ii_holding_snapshots.quality_status`/`ii_analytics_results` the insight cites, not duplicated as a separately-tracked value).

## 3. Ten worked examples, classified (spec Section 19G)

| # | Example insight | Classification | Rationale |
|---|---|---|---|
| 1 | "38% of your portfolio is held in three companies." | Observation | States a fact derived from holdings data; no interpretation. |
| 2 | "Concentrated portfolios can experience larger swings when one company underperforms." | Education | General principle, not tied to an instruction. |
| 3 | "If you redeemed ₹2,00,000 from Fund X today, the estimated exit load under a 1% assumption would be ₹2,000." | Simulation | Explicitly conditional ("if"), states its assumption, no instruction. |
| 4 | "Switch out of Fund X and into Fund Y for better returns." | Personalised advice | Names specific instruments and a specific buy/sell instruction. |
| 5 | "You have not made a SIP contribution to this fund in the last 4 months." | Observation | Factual statement about recorded transaction history. |
| 6 | "Regular SIP investing can help smooth out the effect of market volatility over time (rupee-cost averaging)." | Education | General concept, not an instruction about this user's specific fund. |
| 7 | "At your current SIP amount, this fund's value would reach an estimated ₹X in 5 years, assuming a 10% annual return." | Simulation | Explicit assumption, forward projection, no instruction to act. |
| 8 | "You should redeem your entire holding in this fund before the financial year ends." | Personalised advice | A specific transactional instruction about specific holdings. |
| 9 | "This fund's expense ratio is 1.8%, compared to a category average of 1.1%." | Observation | A factual comparison of recorded/reference data; no recommendation attached. |
| 10 | "A higher expense ratio reduces net returns over time, all else being equal." | Education | General financial-literacy statement, no instruction. |

Note on the boundary between Education and Personalised Advice: example 10 stops at explaining *why* expense ratio matters; it does not say "switch out of this fund," which is what would move it into Personalised Advice (as in example 4/8). This is the exact line the classification exists to police — general/conditional statements vs. specific transactional instructions naming specific instruments.

## 4. Existing precedent this reuses

`lib/advice-boundary/` already exists in the repository as a gating helper directory (`R0_CURRENT_STATE_DISCOVERY.md` section 1) — confirming FHIP already has an established need to separate "what the platform can say" from "what would constitute regulated advice" elsewhere in the product. `ii_insights`' classification/gating mechanism is designed to be consistent with, and should be implemented in R1 by extending, this existing pattern rather than inventing a parallel one — an explicit R1 implementation note, not resolved further at the architecture level in R0.
