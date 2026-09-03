# G3 Closure Governance

Two items the Product Owner required before formal FULL PASS. Both answered with
evidence gathered read-only from live DEV (`vqycarelcoijzwlpkpcz`), reproducible via
`scripts/g3_missing_country_classification.mjs` and `scripts/g3_audit_residue_inspection.mjs`
— neither of which contains any write path.

---

## 1. Classification of the 132 missing-country DEV profiles

**129 of 132 are synthetic. 3 are potentially genuine. None of the 3 holds financial data.**

### Breakdown by identity pattern

| Count | Classification | Evidence |
|---|---|---|
| 81 | Resources phase certification fixtures | `r*` local part on reserved test domains |
| 27 | Reserved `.invalid` domain | RFC 2606 reserves `.invalid`; it can never resolve to a real mailbox |
| 11 | Investment Intelligence certification fixtures | `ii*` prefix |
| 7 | Financial Data Hub certification fixtures | `fdh*` prefix |
| 1 | `navigation.spec.ts` e2e fixture | `nav-test+` prefix |
| 1 | `onboarding.spec.ts` e2e fixture | `test+` prefix |
| 1 | Reserved `.local` domain | never routable mail |
| **129** | **Abandoned synthetic/test identities** | |
| **3** | **Potentially genuine** | real `@gmail.com` mailboxes — see below |

### The three potentially genuine profiles

| Created | Last sign-in | Onboarded | Currency | Financial rows |
|---|---|---|---|---|
| 2026-07-30 | never | false | null | none |
| 2026-07-30 | 2026-07-30 | false | null | none |
| 2026-08-21 | 2026-08-21 | **true** | null | none |

**Required treatment (spec §11.2, PO classification table): "Genuine existing users →
keep blocked and require explicit confirmation; never infer or silently confirm."**

This is **already in force and requires no action**. Verified live: both country tiers
return `false` for these profiles, so MCC blocks them from every financial table and G3's
registration tier blocks them from cross-border declarations. G3 changes nothing about
them — it neither infers, assigns, nor confirms a country for any existing row. When one
of these users next signs in they will be routed to `/confirm-country` and must choose
explicitly, exactly as intended.

### Which profiles hold financial data

Two missing-country profiles own financial rows (1 income, 11 investments, 12 goals).
**Both are synthetic** — one FDH fixture, one Resources fixture. **No potentially-genuine
profile owns a single financial row.** This is the decisive safety finding: there is no
real user whose data could be affected by any decision about this population.

(Those rows predate MCC. Since MCC shipped, a missing-country profile cannot create
financial rows at all — re-confirmed live in this phase's certification.)

### Recommendation — NOT executed, awaiting approval

The 129 synthetic identities are abandoned fixtures from six completed workstreams. They
inflate the missing-country metric and make the genuine population harder to see. A
controlled cleanup with a per-identity manifest and independent zero-residue proof would
be appropriate — but it spans other workstreams' fixtures, not G3's, so **G3 has taken no
destructive action and recommends this be scoped as its own governance task** rather than
folded into a feature phase.

**G3's own certification residue is separately at zero** (§2 below).

---

## 2. The orphaned `country_confirmed` audit events

The Product Owner asked for four points to be confirmed with evidence. Inspecting the rows
rather than reasoning about them showed that **an earlier statement in the G3 report was
wrong**, and the treatment changed as a result.

### CORRECTION to the earlier report

The previous report said these rows "carry no user identifier". **That was incorrect.**
`audit_events.user_id` is `ON DELETE SET NULL`, but **`entity_id` is a plain `uuid` column
with no foreign key**, so the deleted account's id survives there untouched — and 32 rows
also carried a UUID in `metadata.actor_id`. The claim was reasoned from the FK rather than
verified against the data.

### The four points

| # | Question | Answer |
|---|---|---|
| 1 | Contain user identifiers or secrets? | **No secrets** — 0 rows matched any secret-shaped or email pattern. **But yes, identifiers** — `entity_id` retained the deleted account's UUID on every row. |
| 2 | Unmistakably marked as certification events? | **No.** `written_by` names the writing *function*, not the purpose. A genuine user's confirmation produces the identical marker, and a genuine user who later deleted their account would also leave `user_id` NULL. They were **indistinguishable from real confirmations**. |
| 3 | Excluded from operational/user analytics? | **Yes, structurally.** `audit_events` has exactly two consumers in the entire application (`lib/services/countryAudit.ts`), **both INSERTs**. Nothing reads the table — no analytics surface, no admin screen, no API route. Its only RLS policy is `for select using (auth.uid() = user_id)`, so with `user_id` NULL **no authenticated user could read them at all**. |
| 4 | Retention documented? | Superseded — see below. |

### Resolution: removed, not retained

Because point 2 failed, retaining them was not acceptable: leaving synthetic confirmations
that cannot be told apart from genuine ones **pollutes a real audit trail**, which is worse
for audit integrity than removing them.

Provenance was established before deleting anything. `written_by:
confirm_country_of_residence` exists only in the RPC that migration `0127` introduced,
which reached DEV on 2026-09-03; all 39 such rows were created that day, and every one
traced to a certification identity. Rows **without** the marker (7) predate `0127`, are not
this session's, and were **left untouched**.

**Both certification harnesses now delete their own audit rows by id during cleanup**, so
this cannot recur:
- `scripts/g3_live_dev_certification.mjs` — deletes by `entity_id` for the identities that run created, then re-queries to prove zero.
- `tests/e2e/g3-registration.spec.ts` — same, and throws if any row survives.

### Final live state

```
G3 identities:                 0
session e2e-spec fixtures:     0
session audit rows:            0
untouched legacy audit rows:   7   (pre-0127, not this session's)
```

Existing-user aggregates re-verified after cleanup — **identical to the original
pre-certification baseline** on every field:

```
{"total":384,"au_confirmed":5,"in_confirmed":1,"generic_confirmed":0,
 "missing_country":132,"invalid_country":0,"currency_AUD":150,"currency_INR":97,
 "currency_other":0,"currency_null":137,"billing_confirmed":0,"generic_disclosure_rows":0}
```
