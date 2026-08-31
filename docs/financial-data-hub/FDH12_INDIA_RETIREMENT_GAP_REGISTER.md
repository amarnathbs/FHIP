# FDH-12 — India Retirement Gap Register

Spec section 172. Gaps that belong to **canonical Retirement**, not to FDH-12.

> "Do not use FDH-12 to create a parallel India retirement module when the gap
> belongs in canonical Retirement."

None of the gaps below were patched inside FDH-12.

---

## IN-R1 — NPS Tier I vs Tier II is not modelled

* **Capability:** National Pension System tier structure.
* **Evidence:** Migration `0100`'s own header discloses that NPS Tier I/II and
  its employer/employee/voluntary contribution structure are not modelled. A
  single `nps` catalogue item exists.
* **User impact:** An NPS holder cannot distinguish locked Tier I from
  withdrawable Tier II, so liquidity and retirement-readiness views treat them
  identically.
* **Canonical owner:** Retirement module.
* **Recommended fix:** A tier discriminator on the retirement account (or two
  catalogue items), plus contribution-type support.
* **FDH-12 action:** Recorded only. FDH-12 reads an NPS balance as one figure
  and invents no tier.
* **Status:** OPEN.

## IN-R2 — EPF interest accrual is not modelled

* **Capability:** Declared annual EPF interest.
* **Evidence:** No interest model exists anywhere; `retirement_accounts` stores
  a balance only, and the forecast grows every retirement tranche with the
  generic `retirement` return assumption.
* **User impact:** EPF is projected with a generic return rather than its
  declared rate.
* **Canonical owner:** Retirement / Forecasting.
* **Recommended fix:** A jurisdiction-aware return assumption, or an explicit
  declared-rate field.
* **FDH-12 action:** Recorded only. FDH-12 reads `INTEREST` activity as
  evidence and posts it nowhere.
* **Status:** OPEN.

## IN-R3 — PPF lock-in and maturity are not modelled

* **Capability:** Public Provident Fund availability.
* **Evidence:** No maturity date, lock-in period or partial-withdrawal
  eligibility field exists on any retirement table.
* **User impact:** A PPF balance appears fully available in liquidity and
  goal-funding views when it is not.
* **Canonical owner:** Retirement module.
* **Recommended fix:** Availability metadata, as
  `goal_funding_sources.availability_date` already models for goals.
* **FDH-12 action:** Recorded only.
* **Status:** OPEN.

## IN-R4 — India employer PF vs EPS split is not represented

* **Capability:** Employer provident-fund contribution split between EPF and
  the Employees' Pension Scheme.
* **Evidence:** FDH-9 records a single `employer_retirement_contribution`
  column; an Indian payslip splits the employer's share.
* **User impact:** Employer contribution evidence is slightly over-attributed
  to EPF.
* **Canonical owner:** Retirement module (with FDH-9).
* **Recommended fix:** A pension-scheme component, if the product wants that
  resolution.
* **FDH-12 action:** Recorded only. FDH-12 reconciles against FDH-9's existing
  single figure and adds no second contribution engine.
* **Status:** OPEN.

## IN-R5 — No India statement layouts beyond EPF

* **Capability:** NPS transaction statements and PPF statements.
* **Evidence:** `RETIREMENT_CSV_ADAPTER_REGISTRY` contains exactly one India
  adapter, for EPF passbook CSV.
* **User impact:** NPS and PPF statements resolve to MANUAL_MAPPING_REQUIRED.
* **Canonical owner:** FDH-12 (a future phase).
* **Recommended fix:** Certify NPS and PPF layouts against real fixtures.
* **FDH-12 action:** **Disclosed, not claimed.** No adapter pretends to read
  them, and the coverage matrix says so.
* **Status:** OPEN.

## IN-R6 — India retirement tax treatment is not modelled

* **Capability:** Taxability of retirement withdrawals in India.
* **Evidence:** No India retirement tax model exists; the Investment
  Intelligence R6 tax engine is scoped to investment capital gains.
* **User impact:** Withdrawal taxability is not shown.
* **Canonical owner:** Retirement module.
* **Recommended fix:** Out of FDH-12's scope entirely — spec sections 36 and 44
  forbid inventing tax treatment from a statement.
* **FDH-12 action:** Recorded only. FDH-12 preserves `TAX` evidence exactly as
  printed and infers no rate.
* **Status:** OPEN.

---

## What FDH-12 did NOT do

It added no India retirement calculation engine, no EPF interest model, no NPS
tier model, no PPF maturity model and no India-specific projection — all of
which spec sections 7 and 9 forbid building merely to parse a statement.
