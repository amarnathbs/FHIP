# Operator action — map the CAMS statement to a household member

**Who does this:** the Product Owner, signed in as themselves.
**Why nobody else can:** the screen only ever shows *your own* statements, and
the decision is recorded against *your* account in an immutable audit trail. An
engineer cannot do it for you, and doing it by editing database rows would
bypass the audit trail the decision exists to create.

**Status of this sheet:** the flow described in Part B was verified end to end
on 2026-09-16 against a synthetic reproduction on DEV
(`scripts/m12c_pc5_owner_mapping_synthetic_repro.ts`, 33/33 assertions passing,
driven through the real screens and the real HTTP route). Part A describes
three prerequisites that are **not satisfied in production today** — read Part A
before Part B, because in production today the screen in Part B will be empty.

---

## Part A — read this first: what is true in production right now

A read-only probe of production on 2026-09-16 found:

| What | Production today |
| --- | --- |
| Blocked positions (`ii_portfolio_truth_status`) | 17, all `reconciliation_required`, none certified |
| Blocking reasons | `unresolved_owner` ×17, `open_blocking_reconciliation_case` ×17, `parser_fatal_error` ×17, `unit_variance_exceeds_tolerance` ×5, `material_unclassified_transaction` ×1 |
| Statements on file (`ii_source_documents`) | 3, **all with no owner recorded** |
| Open blocking reconciliation cases | 123, of which **120 are `owner_unmatched`** |
| Investment accounts (`ii_accounts`) | 12, **all with no owner recorded** |
| **Household members** | **0 — nobody has been added yet** |
| Documents in the newer AI-extraction pipeline | **0** |

Three consequences follow, and each is a real blocker rather than a caveat:

1. **There is nobody to map the statement to.** Your household has no members
   recorded. Until at least one exists, every owner-choice screen in the product
   will correctly tell you *"There is nothing available to choose from yet. Add
   the household member or entity this belongs to, then come back."*
   (`lib/pc5/projection.ts:132`.)

2. **There is no screen in the app that adds a household member.** The
   capability exists as an API (`POST /api/household-members`,
   `app/api/household-members/route.ts:14`) but no page in the product calls it.
   This is a genuine product gap, not something you are missing.

3. **Your three existing statements are in the older ingestion path, and the
   owner-mapping screen only covers the newer one.** The guided screen described
   in Part B reads the AI-extraction pipeline's exception records. Production has
   zero rows in that pipeline, so the screen will show *"Nothing is waiting on
   you right now."* — truthfully, because the older path's 120 `owner_unmatched`
   cases are not represented there. In the older path's own Review screen those
   cases say, in as many words, *"This issue requires owner/reconciliation
   functionality that is not yet available."*
   (`components/investment-intelligence/ReviewCentreClient.tsx:158`.)

**Also worth knowing before you try the obvious workaround:** re-uploading the
same PDF will not fix the owner. The upload endpoint de-duplicates by file
checksum and returns the existing document unchanged
(`app/api/investment-intelligence/source-documents/route.ts:56`), and the upload
form never sends an owner in the first place — it posts only
`{sourceKey, documentType, countryCode}`
(`components/investment-intelligence/InvestmentIntelligenceClient.tsx:236`),
which is precisely why all three documents have no owner.

So the sequence you actually need is:

- **A1.** Get at least one household member created (engineering can expose the
  existing API as a screen, or you can have the row created for you — but note
  it is *your* data, so you should be the one who supplies the name and
  relationship).
- **A2.** Have the statement ingested through the AI-extraction pipeline, which
  is what produces the guided question in Part B. That pipeline is behind
  feature flags that are off in production today
  (`AIE_DOCUMENT_INTAKE_ENABLED`, `AIE_II_ADAPTER_ENABLED`,
  `AIE_REVIEW_PC5_PROJECTION_ENABLED`, `AIE_REVIEW_UI_ENABLED`).
- **A3.** Then follow Part B.

Nothing in A1–A3 is a decision an engineer can take for you; they are the
prerequisites that must be arranged before your click-by-click step exists.

---

## Part B — the click-by-click owner mapping

Once a statement has produced an owner question, this is the whole journey.
Every label below is the exact text on screen.

### 1. Open Investment Intelligence

In the left-hand sidebar, under the group **Plan & improve**, click
**Investment Intelligence (India)**.
*(`components/ui/AppShell.tsx:139`. There is a second way in: the
**Investment & Retirement** page also carries an "India Investments" button.)*

### 2. Open the Resolutions tab

Along the top of the Investment Intelligence workspace there is a row of tabs:
**Overview · Statements & data · Performance · Recurring investments ·
Underlying fund holdings · Tax & cost · Review · Resolutions**.

Click **Resolutions** — the last one.
*(`lib/investment-intelligence/workspaceNav.ts:107-111`; the tab strip is
`components/investment-intelligence/InvestmentIntelligenceSubNav.tsx`.)*

> **Resolutions is not the same tab as Review.** *Review* holds advisory
> observations you may safely acknowledge or dismiss. *Resolutions* holds
> blocking questions: a statement cannot be imported until you answer them, and
> they cannot be dismissed at all. If you answer in the wrong tab, nothing
> unblocks.

### 3. Find the ownership question

The page is headed **Statement questions**. At the top you will see either

> *Nothing is waiting on you right now.*

or

> **N questions** must be answered before the affected statements can be
> imported. Holdings from those statements are not in your portfolio yet.

The item you want reads:

> **We could not confirm who owns this investment account.**
> Ownership must be confirmed before holdings from this statement can be
> recorded against the right person or entity.

It carries an amber badge reading **Needs a decision** and, beneath it, the note
**Blocks importing this statement**.

*(The underlying record type is `aie_unresolved_item` with reason code
`ii_adapter:owner_unresolved`, severity `blocking` —
`lib/aie/review/reasonCodes.ts:155-170`. Two sibling questions use the same
screen: `ii_adapter:owner_mismatch` — *"The name on this statement does not match
the person you selected."* — and `ii_adapter:owner_joint_allocation_required` —
*"This account is held jointly. How should it be split?"*.)*

### 4. Click **Answer this**

The blue link at the bottom of that item is labelled **Answer this**. It takes
you straight to that one question — not to a list you then have to search
through.
*(`components/pc5/ResolutionCentreClient.tsx:174-176`; the destination is
`/investment-intelligence/resolutions/<item id>`.)*

### 5. Choose the owner

The page is headed **Answer this question**, repeats the question, and then asks:

> **Who does this statement belong to?**

Beneath it is a list of radio buttons — one per active household member and
registered entity, each showing the person's name with their relationship
underneath (**You**, **Spouse**, **Partner**, **Child**, **Dependant**), then any
companies, family trusts or HUFs, and finally:

> **Jointly owned** — Choose two or more owners and their shares. The holdings
> are still counted once.

Click the radio button for the person or entity the statement belongs to.

- **The list is built from your own household only.** A name that is not yours
  cannot appear and cannot be submitted, even by a tampered browser
  (`lib/pc5/optionSets.ts:225-297`, re-checked server-side at
  `lib/pc5/decide.ts:240-248`).
- **If the list is empty**, the page will say *"There is nothing available to
  choose from yet. Add the household member or entity this belongs to, then come
  back — or discard this statement."* That is Part A, blocker 1.

### 6. If — and only if — the account is jointly held

Choosing **Jointly owned** opens a panel headed **Who owns which share?**:

> These holdings are still counted once in your net worth. This only records who
> owns which share of them, so reports attribute the position correctly. The
> shares must add up to 100%.

Each owner gets a percentage box, pre-filled with an equal split. Adjust them if
the split is not equal. A running total appears underneath — it turns red and
says *"the shares must add up to exactly 100%"* until it does.

There is also a field labelled **Account this applies to** expecting an account
id. *(Known rough edge: this asks for a raw identifier rather than offering a
picker — `components/pc5/ResolutionDetailClient.tsx:340-349`. If you do not have
the id to hand, ask engineering for the `ii_accounts` id of the folio, or choose
a single owner instead and record the split later.)*

### 7. Click **Save this answer**

The button stays greyed out until you have chosen an owner (and, for a joint
split, until the percentages total exactly 100%). While it is working it reads
**Saving…**.

### 8. Read the confirmation — and read it carefully

One of three messages appears in a green box:

| Message | What it means |
| --- | --- |
| **"Answer recorded and the statement re-checked — nothing else is outstanding on it."** | Done. This statement is now ready to import. |
| **"Answer recorded and the statement re-checked. N question(s) still outstanding."** | Your answer was accepted, but the statement has other blocking questions. Go back and answer those too. |
| **"Answer recorded. We could not re-check the statement just now, so this stays open until we can."** | Your answer is saved and audited, but the re-check did not run. The statement stays blocked. Report this one — it means something else went wrong. |

### 9. Confirm on the list

Click **← All statement questions**. The banner should now read
**Nothing is waiting on you right now.** To see what you just answered, click
**Show resolved history** *and* **Show everything** — you need both, because the
history view still hides non-blocking items by default, so resolved items stay
hidden until "Show everything" is also on.

Your answer then appears on the question's own page under **What has been
decided on this so far**, with the date, the reader version, and whether the
statement was re-checked afterwards.

---

## What the two buttons you should *not* use actually do

- **I have seen this** records that you looked at it. It does **not** fix
  anything, and the app says so: *"That does not fix it — the statement still
  cannot be imported until the question is answered."*
- **Hide this from my list** is not offered for an ownership question at all.
  The page instead says *"This one cannot be hidden — it blocks importing the
  statement."* That is deliberate: a hidden blocking question would leave you
  with a clean-looking list and a statement that still refuses to import.
- **Discard this statement…** deletes the original file and imports nothing.
  Use it only if the statement genuinely is not yours. You will be asked why,
  from a fixed list (*"It belongs to someone outside my household"*, *"It belongs
  to a different household"*, *"It is for an account that is not mine"*, *"I
  uploaded it by mistake"*, *"Another reason"*).

## One thing the screen will never offer you

If the statement shows a masked value (for example a partially hidden holder
name), there is no button to reveal it. Masking in this product is one-way by
design, so the original genuinely cannot be shown again — not by you and not by
support. The screen states this rather than offering a control that would always
fail.

---

## Where each step lands in the system, for the record

| Step | Route / file | Effect |
| --- | --- | --- |
| Open Resolutions | `app/(app)/investment-intelligence/resolutions/page.tsx` → `GET /api/pc5/resolutions` | Projects live exception rows; persists nothing |
| Open one question | `app/(app)/investment-intelligence/resolutions/[itemId]/page.tsx` → `GET /api/pc5/resolutions/{itemId}` | Loads the case and its decision history |
| Save the answer | `POST /api/pc5/resolutions/{itemId}/decide` → `lib/pc5/decide.ts:201` | Writes one immutable `aie_review_decision` row, then re-runs reconciliation |
| Joint split | `lib/pc5/allocationStore.ts` | Writes `ii_ownership_allocation` rows totalling exactly 10000 basis points |
| Automatic re-check | `lib/pc5/reReconciliation.ts:207` | Re-runs the checks; a question that no longer reproduces is resolved by the system, and the run moves to `awaiting_acceptance` |
| Importing the holdings | `POST /api/aie/review/runs/{runId}/accept` | The separate, later step that actually writes the owner onto the canonical statement record (`lib/aie/adapters/investment-intelligence/write.ts`) |

**Answering the question unblocks the statement; it does not by itself import
it.** The import is the acceptance step in the last row above. Both are needed
before a position can be certified.
