-- P0-7: user-set "not applicable to me" opt-out per category, so the
-- completion score can distinguish "genuinely doesn't apply to this
-- household" from "not entered yet" instead of scoring every empty category
-- as missing data. Scoped to the three categories where genuine
-- inapplicability is plausible (investments, retirement, insurance) — the
-- other health-score components (cash flow, savings, debt, net worth) are
-- derived from income/expenses/assets/liabilities, which are not optional
-- inputs for any household, so an opt-out there would let the score be
-- gamed rather than reflect a real "not applicable" case.
alter table user_profiles
  add column not_applicable_investments boolean not null default false,
  add column not_applicable_retirement boolean not null default false,
  add column not_applicable_insurance boolean not null default false;
