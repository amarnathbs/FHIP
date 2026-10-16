# PO decision, 16-10-2026: personal net worth excludes entity-held amounts

Source: the Product Owner, in chat, 16-10-2026 (genuine). His words on the SMSF amount of AUD 133,000 (retirement register, owner SMSF): "SMSF 133000 is member balance should not be inside the member; it is fund level amount that should not be included inside the user personal networth; if it is considered it is wrong."

## Decision

1. An amount held by an entity (the SMSF fund's own rows, a family trust, a company, the fund's own property loan, registered Companies, Trusts and HUFs) is NOT part of any PERSONAL net worth figure, at individual level or in the personal headline, and is never any member's balance.
2. It belongs only in the entity block and in the consolidated FAMILY net worth (the earlier decision of the same day stands: SMSF full, Trust full, HUF full, Company by ownership share).
3. The SMSF section fund row (retirement row with master_item_key smsf, owned by a person by construction) is the fund's own net balance and is entity-held. Genuine personal pension and super accounts stay personal. When a fund row and a fund-level (owner smsf) row both exist, the fund is counted once (the fund-level row) and a data-quality notice is shown.
4. Later the same day the PO added that the 503,000 retirement row (owner self) is the fund's gross asset, the fund has a liability of 370,000 (not recorded as a row) and the net is 133,000. Correct figures: personal 874,441; SMSF fund 503,000 - 370,000 = 133,000; family 874,441 + 133,000 = 1,007,441. Interim data advice to him: delete the 503,000 owner-self row and keep the 133,000 owner-smsf row as the fund net, until entity-level asset and liability input exists.

## Supersedes

- The statement in `docs/architecture/NET_WORTH_INDIVIDUAL_AND_FAMILY_LEVELS_2026-10-16.md` sections 2 and 5 that `summary.netWorth` and its readers stay on the family-basis figure.
- LR-FI-1 section 28 ("wealth stays whole": an SMSF-owned asset, investment or retirement balance keeps contributing to Net Worth) and the LR-FI Recovery restoring it, as far as PERSONAL figures are concerned. Those rows remain in the family figure.
- The comment in `lib/services/forecastData.ts` that SMSF wealth belongs in the household's retirement net worth.

## Unchanged

Free and Premium behaviour, day-first dates, certified formulas, cash-flow SMSF isolation (LR-FI-1 income, expenses, repayments, DTI and DSR), the 50/50 default joint split and recorded splits, entity treatment at the family level, no migration.

## Open PO decision

Stored month-on-month history stays on the earlier (family) basis and is never mixed with the personal figure. Recommendation and the optional migration 0288 are in section 10.3 of the design note.
