# NAV2 risk-free data: capability segregation (what is true today, and what is not)

Status as of 06-10-2026, checked against the code and migrations 0260 to 0263. Wording is deliberate: this is **logical segregation**, not full dual control.

## What exists (verified in code)

| Control | Where | State |
|---|---|---|
| Separate capabilities for **upload** and **activation** | `admin_users.can_upload_risk_free_data` (upload, preview, commit, review accept/reject, corrections) and `admin_users.can_switch_risk_free_series` (switch a series on or off, change its terms status). Neither is implied by `isAdmin`, by the other, or by the market-index, PC6 or benchmark capabilities. | **Done.** Four layers: database function checks `is_risk_free_data_admin()` / `is_risk_free_series_switch_admin()`; every API verb calls `requireRiskFreeCapability`; the page is gated; the nav entry is gated. A source contract (`nav2StageThreeFixesContract.test.ts`) proves every NAV2 POST route authorises before it reads or validates the body. |
| **Mandatory audit reason** | `set_risk_free_series_state` (activation / switch / terms status), `correct_risk_free_observation` and `resolve_risk_free_review_item` each refuse a reason or note shorter than 20 characters (error 22023); the Save button stays off until it is met and the correction form names the missing field inline. | **Done.** |
| **Preview / validation before activation** of data | An upload is always checked first (the file is parsed, every row validated, conflicts and counts shown, nothing written); commit needs the same file hash, a ticked attestation and the preview to have passed. Rows are append-only: an upload never changes a published value. | **Done for data.** |
| **Immutable audit** | `ii_risk_free_batches`, `ii_risk_free_observations` (insert only, guard function and triggers), `ii_risk_free_corrections` and `ii_risk_free_series_state_log` raise on any UPDATE or DELETE (`ii_risk_free_append_only`). The log keeps previous and new value, reason, acting user and time. | **Done.** |
| Weekly refresh switch | `ii_reference_job_control` row `nav2_risk_free_weekly_refresh`, shipped OFF, dry run by default; the job writes only through a service-role function. | **Done.** |

## What does NOT exist (gaps, listed rather than hidden)

1. **Re-authentication for activation.** Switching a series on or off, or changing its terms status, relies on the administrator's existing session. There is no step-up (re-enter password or a fresh sign-in challenge) in this repository for any admin action, so adding one for NAV2 alone would be a new authentication mechanism, not a small change. **Gap, not implemented.** Mitigation today: the action needs a separate capability, a written reason of at least 20 characters, and leaves an immutable log row.
2. **Preview for the series switch itself.** Data has a preview; the on/off switch applies when pressed (it is reversible and logged). A "what will change for customers" preview (which reports lose Sharpe, Sortino and alpha) is not built. **Gap.**
3. **Dual control (two people).** The database does not require that the person who uploads differs from the person who activates, or that a second administrator approves an activation. The two capabilities CAN be given to two people, and the README says they should be; nothing forces it.

## Single-operator limitation

If only one administrator exists in an environment (today: production has one), that person can hold both capabilities. In that case this is a **single-operator limitation, not full dual control**: the segregation is logical (separate capabilities, a mandatory reason, an immutable audit trail and a preview before data is written), and it is not a second-person check. It must not be described as dual control until a second administrator holds exactly one of the two capabilities and the PO has decided whether the database should refuse the same person doing both.
