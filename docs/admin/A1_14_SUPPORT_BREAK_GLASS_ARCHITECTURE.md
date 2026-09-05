# A1.3 — Support and Break-Glass Access Architecture (Design Only)

**Status:** Nothing in this document is implemented. No table, RPC, route, or role exists. This is the design Wave F (FDH-13) and A4 (canonical) would both build from — one model, not two, per `A1_13`'s "one canonical platform" rule.

## 1. Why this is needed

Two named future capabilities require it: `canAccessFdhSupportData` (CAP-27, purpose-bound access to one user's FDH *operational* record, not a raw document) and `canUseFdhBreakGlassAccess` (CAP-28, time-boxed raw-*document* access in a genuine incident). A generalised version (CAP-35/36, ADM-43) is the canonical, cross-domain form both FDH and any future domain (Investment Intelligence's raw CAS statements are named as a structurally identical sensitivity class) would consume — **one model, never a second bespoke one per domain.**

## 2. The two distinct mechanisms, deliberately not merged

| | Support access (CAP-27/35/36 ordinary case) | Break-glass (CAP-28) |
|---|---|---|
| Trigger | A named operational reason (e.g. investigating a user-reported ingestion failure) | A genuine incident where no other path exists |
| Scope | Narrow — one user's operational record, never a raw document | Narrowest possible — a specific raw document, time-boxed |
| Consent | Required where appropriate (e.g. contacting the user first) — exact model TBD, `A1_19` PO-6 | Not required (by definition, an incident) — but every other control below is *stricter*, not looser |
| Duration | Time-limited grant, explicit expiry | Time-boxed, auto-expiring, shorter by default |
| Combinable with audit-editing capability | **Never**, for either mechanism | **Never**, structural DB-level guarantee, not a role convention |

## 3. Required properties (every one, for both mechanisms)

1. **Defined purpose** — a grant is issued against a named reason, not a general "just in case" allocation.
2. **Consent where appropriate** — for the ordinary support-access case, a model for whether/how the affected user is notified or asked; genuinely undecided (`REG-12`, `A1_19` PO-6).
3. **Narrow scope** — the grant names exactly what it covers (one user, one record class, never "everything").
4. **Time-limited grant with automatic expiry** — a grant that is not explicitly renewed lapses on its own; expiry failure must fail closed (access denied), never fail open.
5. **Named operator** — the grant identifies exactly who holds it, never a shared/anonymous credential.
6. **Immutable audit** — every grant issuance, use, and expiry/revocation writes an append-only event to the canonical audit sink (`A1_12`), `domain: security`, with `privacy_classification` reflecting what was accessed.
7. **Visible active-support indicator** — while a grant is active, both the grantee's own UI and (where feasible) a Super-Admin-visible "who currently has an active grant" list show it; a silent, invisible grant is not acceptable.
8. **No document download without separate explicit authorization** — even an active support-access grant (CAP-27/36) does not itself authorize downloading a raw document; that requires the stricter break-glass path (CAP-28) specifically, authorized separately.
9. **Break-glass separated from ordinary support, structurally** — a person holding an active break-glass grant cannot, by database constraint (not merely role convention), simultaneously hold any capability able to edit or delete an audit record. This mirrors the FDH-13 baseline's own binding rule verbatim.

## 4. Page pattern

Uses Page Pattern 10 (`A1_10`) — grant-request/consent-capture/active-with-visible-expiry/expired/revoked/denied states. No page exists yet.

## 5. What is explicitly NOT decided here

- The exact consent mechanism for ordinary support access (`REG-12`, unresolved by design — Wave F's own first deliverable).
- Whether `canAccessFdhSupportData` and `canApproveFdhMasterData` may coexist on one person (`REG-13`, unresolved).
- The retention period for support-access audit evidence specifically vs. the platform-wide `REG-14` question.
- Any UI copy, exact grant-duration defaults, or notification channel.

## 6. What A1 contributes

The shape above — so that when Wave F (FDH-13) or A4 (canonical) is authorised to actually build this, it builds **one** mechanism against **nine already-agreed properties**, not an invented one under implementation pressure, and not two competing mechanisms for FDH vs. everything else.
