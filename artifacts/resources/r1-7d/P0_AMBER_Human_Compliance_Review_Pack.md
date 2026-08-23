# P0 AMBER — Human Compliance Review Pack
**Stage A deliverable — Claude recommendations are ADVISORY ONLY. No Human_Compliance_Decision has been recorded for any record.**

All 10 AMBER records confirmed live from CMS `compliance_classification` (not hard-coded): RAU-001, RAU-002, RAU-003, RIN-001, RIN-002, RIN-003, IP-001, IP-002, CB-001, CB-002. 74 GREEN, 0 RED.

---

## RAU-001 — Superannuation Explained for Beginners
**Jurisdiction:** Australia | **Risk class:** AMBER

**Material current-rule claim(s):** General SG rate is 12% as at August 2026

**Official source used:** Australian Taxation Office | **URL:** https://www.ato.gov.au/tax-rates-and-codes/key-superannuation-rates-and-thresholds/super-guarantee | **Authority type:** Government agency

**Effective date:** 2025-07-01 | **Verification date:** 2026-08-21

**Wording time-aware?** YES

**Uncertainty / source-fetch limitation:** None

**Material change since R1.7C:** None

**Claude compliance recommendation (advisory only): `COMPLIANCE_APPROVE -- verified current via direct WebSearch of ato.gov.au-derived results, no further legislated increase`**

---

## RAU-002 — How Superannuation Contributions Build Retirement Savings
**Jurisdiction:** Australia | **Risk class:** AMBER

**Material current-rule claim(s):** Same as RAU-001 plus Payday Super timing

**Official source used:** Australian Taxation Office | **URL:** https://www.ato.gov.au/businesses-and-organisations/super-for-employers/about-payday-super | **Authority type:** Government agency

**Effective date:** 2025-07-01 / 2026-07-01 | **Verification date:** 2026-08-21

**Wording time-aware?** YES

**Uncertainty / source-fetch limitation:** None

**Material change since R1.7C:** None

**Claude compliance recommendation (advisory only): `COMPLIANCE_APPROVE -- verified current`**

---

## RAU-003 — Understanding Retirement Readiness in Australia
**Jurisdiction:** Australia | **Risk class:** AMBER

**Material current-rule claim(s):** Age Pension age = 67; preservation age = 60 (birth-date tiered)

**Official source used:** Services Australia / Moneysmart | **URL:** https://www.servicesaustralia.gov.au/age-pension | **Authority type:** Government agency

**Effective date:** 2023-07-01 | **Verification date:** 2026-08-21

**Wording time-aware?** PARTIAL

**Uncertainty / source-fetch limitation:** Direct fetch to servicesaustralia.gov.au timed out (genuinely attempted, R1.7C and R1.7D)

**Material change since R1.7C:** None

**Claude compliance recommendation (advisory only): `BLOCK_PENDING_OFFICIAL_SOURCE -- WebSearch aggregation of official-source-derived results is consistent and unchanged since R1.7C, but the spec requires a successful direct authoritative recheck before compliance approval, which this sandbox cannot currently perform`**

---

## RIN-001 — EPF Explained for Beginners
**Jurisdiction:** India | **Risk class:** AMBER

**Material current-rule claim(s):** Employee 12% + employer 12%; 8.33% of wages (capped Rs 15,000, i.e. Rs 1,250/month) diverted to EPS

**Official source used:** EPFO | **URL:** https://www.epfindia.gov.in/site_en/index.php | **Authority type:** Government agency

**Effective date:** Long-standing scheme rule | **Verification date:** 2026-08-21

**Wording time-aware?** PARTIAL

**Uncertainty / source-fetch limitation:** Direct fetch to epfindia.gov.in refused connection (genuinely attempted, R1.7C and R1.7D)

**Material change since R1.7C:** Supreme Court has directed government to decide on raising the Rs 15,000 wage ceiling by May 2026 -- pending change not yet reflected in the draft

**Claude compliance recommendation (advisory only): `BLOCK_PENDING_OFFICIAL_SOURCE -- same reasoning as RAU-003; additionally flag the pending wage-ceiling review for the reviewer's awareness`**

---

## RIN-002 — PPF Explained for Beginners
**Jurisdiction:** India | **Risk class:** AMBER

**Material current-rule claim(s):** Current rate 7.1% (unchanged since April 2020), Rs 500-1.5 lakh annual limits, 15-year term

**Official source used:** India Post / Dept of Economic Affairs | **URL:** https://www.indiapost.gov.in/ | **Authority type:** Government agency

**Effective date:** 2026-06-30 (Q2 FY2026-27 notification) | **Verification date:** 2026-08-21

**Wording time-aware?** PARTIAL

**Uncertainty / source-fetch limitation:** Direct fetch to indiapost.gov.in returned 404 on the path tried (genuinely attempted, R1.7C and R1.7D)

**Material change since R1.7C:** None

**Claude compliance recommendation (advisory only): `BLOCK_PENDING_OFFICIAL_SOURCE -- same reasoning as RAU-003`**

---

## RIN-003 — NPS Explained for Beginners
**Jurisdiction:** India | **Risk class:** AMBER

**Material current-rule claim(s):** PFRDA-regulated; Tier I core, Tier II optional; draft deliberately states NO specific lump-sum/annuity percentage

**Official source used:** PFRDA | **URL:** https://www.pfrda.org.in/ | **Authority type:** Government agency

**Effective date:** 2026 (amendment confirmed live) | **Verification date:** 2026-08-21

**Wording time-aware?** PARTIAL

**Uncertainty / source-fetch limitation:** Direct WebFetch to pfrda.org.in succeeded at homepage level; full gazette/amendment text not read directly

**Material change since R1.7C:** MATERIAL FINDING: a real December 2025 PFRDA change raised the non-government normal-exit lump-sum limit from 60% to 80% (min annuity purchase 40%->20%; government employees remain 60/40) and removed the 5-year premature-exit lock-in. The July 2026 'Exits and Withdrawals Amendment Regulations 2026' (gazetted 14 Jul 2026) was separately confirmed to be about pension-fund operational outsourcing/liability, NOT eligibility or withdrawal percentages. The draft's own text explicitly avoids stating any specific lump-sum/annuity percentage ('should not hard-code a simplified X% must always be annuitised statement as if it were timeless'), so neither real change creates a factual error in the draft as currently written.

**Claude compliance recommendation (advisory only): `RETURN_FOR_COMPLIANCE_REVISION -- the spec's RIN-003 gate requires a FULL authoritative review of the 2026 amendment; this pass confirmed the amendment's existence and general scope (operational outsourcing, not substantive to this draft) but did not read the full regulation text. Recommend: (1) remove the internal 'compliance reviewer should verify...' instruction text from the body (minor editorial correction), (2) have a human compliance reviewer read the actual gazette notification directly to close the gate formally, (3) decide whether to proactively state the current 80/20 (non-government) vs 60/40 (government) split or keep the current deliberately-abstracted approach`**

---

## IP-001 — Why Insurance Is Part of Financial Health
**Jurisdiction:** Global | **Risk class:** AMBER

**Material current-rule claim(s):** No date-sensitive claim

**Official source used:** N/A | **URL:** N/A | **Authority type:** N/A

**Effective date:** N/A | **Verification date:** 2026-08-21

**Wording time-aware?** N/A

**Uncertainty / source-fetch limitation:** None

**Material change since R1.7C:** None

**Claude compliance recommendation (advisory only): `COMPLIANCE_APPROVE -- no current-rule claim to verify; AMBER classification is precautionary (insurance topic generally)`**

---

## IP-002 — Life Insurance Explained in Plain English
**Jurisdiction:** Global | **Risk class:** AMBER

**Material current-rule claim(s):** No date-sensitive claim

**Official source used:** N/A | **URL:** N/A | **Authority type:** N/A

**Effective date:** N/A | **Verification date:** 2026-08-21

**Wording time-aware?** N/A

**Uncertainty / source-fetch limitation:** None

**Material change since R1.7C:** None

**Claude compliance recommendation (advisory only): `COMPLIANCE_APPROVE -- same as IP-001`**

---

## CB-001 — Understanding Your Financial Life Across Australia and India
**Jurisdiction:** Australia-India Cross-Border | **Risk class:** AMBER

**Material current-rule claim(s):** FX rate explicitly illustrative, never live

**Official source used:** N/A | **URL:** N/A | **Authority type:** N/A

**Effective date:** N/A | **Verification date:** 2026-08-21

**Wording time-aware?** N/A

**Uncertainty / source-fetch limitation:** None

**Material change since R1.7C:** None

**Claude compliance recommendation (advisory only): `COMPLIANCE_APPROVE -- no live-rate claim; verifying a deliberately illustrative number against today's real market rate would be a category error`**

---

## CB-002 — AUD and INR Currency Risk Explained
**Jurisdiction:** Australia-India Cross-Border | **Risk class:** AMBER

**Material current-rule claim(s):** Same illustrative-FX pattern

**Official source used:** N/A | **URL:** N/A | **Authority type:** N/A

**Effective date:** N/A | **Verification date:** 2026-08-21

**Wording time-aware?** N/A

**Uncertainty / source-fetch limitation:** None

**Material change since R1.7C:** None

**Claude compliance recommendation (advisory only): `COMPLIANCE_APPROVE -- same as CB-001`**

---
