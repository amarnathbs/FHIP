# Support runbook -- statement and document import is Premium

For FHIP support staff. Plain language; nothing here needs engineering.

**What changed.** Uploading a statement or document (bank statements, payslips, credit card / loan statements, investment statements, super / EPF /
NPS statements, India CAS statements) and having FHIP read it automatically is a **Premium** feature. Adding and editing your own figures **by hand**
is free, on every plan, for income, expenses, assets, liabilities, investments, retirement, insurance and goals.

**What a Free customer sees.** Next to the manual Add controls the Import control carries a **Premium** label. Opening it explains: *"Statement and
document import is available on Premium. You can continue to add and edit your financial information manually on the Free plan."* with a link to the plan
section of their Profile. No file can be chosen.

**What does NOT change when someone downgrades or their Premium ends.**
* Everything already imported stays: their income, expenses, liabilities, investments, retirement and insurance records are still visible and editable, still marked as imported.
* A statement they uploaded while Premium can still be reviewed, corrected, approved and applied, and can be deleted. A statement that failed to read cannot be retried while Free.
* Their privacy rights are never Premium: deleting a document, deleting their data, closing their account all work on every plan.
* Source files are still deleted on the normal schedule, whatever the plan.

**If a customer says "I paid but import is still locked".** Paying returns them to Profile, where the page says *"Activating your subscription"* for up to about a minute while the payment provider confirms.
If it still says Free after a few minutes, check their plan in Admin -> Premium (it is read from the same record). Do **not** grant access by editing import settings; there is none. Escalate to engineering if the payment shows as successful at the provider but the plan did not change.

**If a customer sees "We could not confirm your plan just now".** This is a temporary check failure, not a payment problem. Ask them to retry in a minute. If it persists, escalate; manual entry keeps working meanwhile.

**Admin staff** uploading Resources, Benchmarks, Recommendations or market data do **not** need a Premium plan; those screens are governed by Admin roles only. Separately, since the Product Owner decision of 16-10-2026, staff accounts (Super Admin, Resource Administrator or Editor) also hold **Premium as consumers**, automatically: a real entitlement row with source `staff_admin` that starts when the role is assigned and ends when the last staff role is removed. It shows in Admin -> Premium Access under "Staff Premium (automatic)", is not a paid subscription, cannot be granted, extended or revoked there, and never counts against grant, extension or promo limits. See `docs/admin/STAFF_ADMIN_PREMIUM_REPORT.md`.
