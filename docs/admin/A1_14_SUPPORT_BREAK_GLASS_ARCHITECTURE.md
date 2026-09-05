# A1.3 — Support and Break-Glass Access Architecture (Design Only)

**Status:** Nothing in this document is implemented. No table, RPC, route, or role exists. This is the design Wave F (FDH-13) and A4 (canonical) would both build from — one model, not two, per `A1_13`'s "one canonical platform" rule.

**PO-6: APPROVED** — the Product Owner has approved this model as: consented, time-limited, audited access with separate emergency controls. The specific approved parameters (§3 updates below): no standing access to personal financial information or uploaded documents; normal support access requires a recorded purpose, narrow scope, user consent where applicable, a named operator, and automatic expiry; sensitive access additionally requires an independent approver; **default access duration is a maximum of 60 minutes, with a new approval required for any extension**; raw document viewing remains prohibited unless separately and explicitly authorized for that specific case; break-glass is reserved for genuine security or availability emergencies and requires immediate immutable logging, prominent alerts, automatic expiry, and a mandatory after-action review; access grants must never be reusable across users or incidents. This resolves `REG-12`/`REG-13`'s prior "no recommendation, Wave F's own first deliverable" status — the consent/approval model itself is now decided; only UI/notification-channel specifics remain for Wave F/A4 to build (§5).

## 1. Why this is needed

Two named future capabilities require it: `canAccessFdhSupportData` (CAP-27, purpose-bound access to one user's FDH *operational* record, not a raw document) and `canUseFdhBreakGlassAccess` (CAP-28, time-boxed raw-*document* access in a genuine incident). A generalised version (CAP-35/36, ADM-43) is the canonical, cross-domain form both FDH and any future domain (Investment Intelligence's raw CAS statements are named as a structurally identical sensitivity class) would consume — **one model, never a second bespoke one per domain.**

## 2. The two distinct mechanisms, deliberately not merged

| | Support access (CAP-27/35/36 ordinary case) | Break-glass (CAP-28) |
|---|---|---|
| Trigger | A named operational reason (e.g. investigating a user-reported ingestion failure) | A genuine security or availability emergency where no other path exists (PO-6: reserved for genuine emergencies, not routine support) |
| Scope | Narrow — one user's operational record, never a raw document | Narrowest possible — a specific raw document, time-boxed |
| Consent | Required where appropriate (e.g. contacting the user first) — **PO-6-approved model**: recorded purpose + narrow scope + user consent where applicable + named operator + automatic expiry, for every ordinary-case grant | Not required (by definition, an incident) — but every other control below is *stricter*, not looser |
| Independent approver | Required for **sensitive** access specifically (PO-6) — not every ordinary grant needs a second approver, but any grant touching sensitive financial data does | Implicit in "genuine emergency" framing; the after-action review (§3, new) is break-glass's own independent-approver-equivalent, applied after rather than before |
| Duration | **Time-limited grant, maximum 60 minutes by default (PO-6) — a new approval is required for any extension**, never a silent renewal | Time-boxed, auto-expiring, shorter by default than the 60-minute ordinary-case maximum |
| Raw document viewing | **Prohibited, always, unless separately and explicitly authorized for that specific case** (PO-6) — an active ordinary support grant never itself unlocks document viewing | The one path that can reach a raw document at all, and only when separately authorized per PO-6's own rule restated for this mechanism |
| Reusability | **Grants must not be reusable across users or incidents** (PO-6) — a grant is single-user, single-purpose, and expires into nothing reusable | Same — a break-glass grant is single-incident, never a standing "emergency mode" toggle |
| Combinable with audit-editing capability | **Never**, for either mechanism | **Never**, structural DB-level guarantee, not a role convention |

## 3. Required properties (every one, for both mechanisms) — PO-6-approved, no longer "genuinely undecided"

1. **Defined purpose** — a grant is issued against a named reason, not a general "just in case" allocation.
2. **Consent where appropriate, PO-6-resolved model** — for the ordinary support-access case: recorded purpose, narrow scope, user consent where applicable, named operator, and automatic expiry are now the approved standard (`REG-12` resolved by PO-6; the exact consent *notification copy/channel* remains a Wave F/A4 implementation detail, §5).
3. **Narrow scope** — the grant names exactly what it covers (one user, one record class, never "everything").
4. **Time-limited grant with automatic expiry, 60-minute default maximum (PO-6)** — a grant that is not explicitly renewed lapses on its own after at most 60 minutes; extension requires a **new** approval, never a silent renewal; expiry failure must fail closed (access denied), never fail open.
5. **Named operator** — the grant identifies exactly who holds it, never a shared/anonymous credential.
6. **Independent approver for sensitive access (PO-6, new)** — any grant touching sensitive financial data (beyond ordinary operational metadata) requires approval from someone other than the requesting operator, before the grant is issued.
7. **Immutable audit** — every grant issuance, use, and expiry/revocation writes an append-only event to the canonical audit sink (`A1_12`), `domain: security`, with `privacy_classification` reflecting what was accessed.
8. **Visible active-support indicator** — while a grant is active, both the grantee's own UI and (where feasible) a Super-Admin-visible "who currently has an active grant" list show it; a silent, invisible grant is not acceptable.
9. **No document download without separate explicit authorization** — even an active support-access grant (CAP-27/36) does not itself authorize downloading a raw document; that requires the stricter break-glass path (CAP-28) specifically, authorized separately, per PO-6's own restatement of this rule.
10. **Grants are not reusable across users or incidents (PO-6, new)** — a grant is minted for exactly one user (ordinary support) or one incident (break-glass) and cannot be repurposed, extended to a different subject, or silently carried into a second incident.
11. **Break-glass reserved for genuine emergencies, with immediate immutable logging, prominent alerts, automatic expiry, and mandatory after-action review (PO-6, new)** — break-glass is not a faster path to ordinary support access; every invocation logs immediately (not batched), triggers a prominent alert to Super Admin, expires automatically on its own (shorter than the 60-minute ordinary maximum), and is followed by a mandatory after-action review before the mechanism may be considered closed for that incident.
12. **Break-glass separated from ordinary support, structurally** — a person holding an active break-glass grant cannot, by database constraint (not merely role convention), simultaneously hold any capability able to edit or delete an audit record. This mirrors the FDH-13 baseline's own binding rule verbatim.

## 4. Page pattern

Uses Page Pattern 10 (`A1_10`) — grant-request/consent-capture/active-with-visible-expiry/expired/revoked/denied states. No page exists yet.

## 5. What PO-6 resolved, and what is still explicitly NOT decided

**Resolved by PO-6:** the consent *model* for ordinary support access (recorded purpose, narrow scope, consent-where-applicable, named operator, automatic expiry — §3.2); the default grant duration (60 minutes maximum, new approval required to extend — §3.4); the requirement for an independent approver on sensitive access (§3.6); the break-glass emergency-only framing and its logging/alerting/expiry/after-action-review requirements (§3.11); and the no-reuse-across-users-or-incidents rule (§3.10). `REG-12` is no longer "Wave F's own first deliverable" for the *model* — only its exact UI/copy remains Wave F's to build.

**Still genuinely open, not decided by PO-6 or anywhere else in A1:**
- Whether `canAccessFdhSupportData` and `canApproveFdhMasterData` may coexist on one person (`REG-13`, unresolved — a different question from the consent model PO-6 answered).
- The retention period for support-access/break-glass audit evidence: **now has an interim answer** (7 years, per `A1_12` §2.4, PO-5) but that number is explicitly interim, pending the same jurisdiction review `A1_13` §3 requires before A4 production activation.
- Any UI copy or notification channel specifics — the *model* PO-6 approved (§3.2) still needs concrete implementation (exact wording, which channel) at Wave F/A4 build time.

## 6. What A1 contributes

The shape above — so that when Wave F (FDH-13) or A4 (canonical) is authorised to actually build this, it builds **one** mechanism against **twelve already-agreed properties** (nine originally, three added by PO-6's own ruling — §3), not an invented one under implementation pressure, and not two competing mechanisms for FDH vs. everything else.
