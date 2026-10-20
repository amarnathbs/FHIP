-- E07 READ-ONLY. The structured result of one payslip, liability, retirement or Australian investment document.
-- Replace the all-zero id with the document id. Rows that do not apply to the document class show as empty or zero.
-- Expected figures are in synthetic/EXPECTED_VALUES.md: DOC-P1 gross 3200.00 tax 512.00 net 2488.00, DOC-L1 closing 427.50,
-- DOC-R1 closing 10687.50, DOC-A1 a buy of 50 units at 40.00 and a dividend of 120.00.

with p as (select '00000000-0000-0000-0000-000000000000'::uuid as document_id)
select 'payroll' as result_kind,
       count(*) as records,
       max(e.gross_pay) as figure_1,
       max(e.tax_withheld) as figure_2,
       max(e.net_pay) as figure_3,
       max(e.pay_frequency) as text_1,
       max(e.payment_date::text) as text_2
  from fdh_payroll_events e join p on p.document_id = e.statement_upload_id
union all
select 'liability', count(*), max(s.opening_balance), max(s.closing_balance), max(s.payments_total), max(s.reconciliation_status), max(s.approval_status)
  from fdh_liability_statements s join p on p.document_id = s.statement_upload_id
union all
select 'liability_activities', count(*), coalesce(sum(a.amount) filter (where a.activity_type = 'PURCHASE'), 0), coalesce(sum(a.amount) filter (where a.activity_type = 'PAYMENT'), 0), null, null, null
  from fdh_liability_statement_activities a join fdh_liability_statements s on s.id = a.statement_id join p on p.document_id = s.statement_upload_id
union all
select 'retirement', count(*), max(r.opening_balance), max(r.closing_balance), max(r.fees), max(r.reconciliation_status), max(r.approval_status)
  from fdh_retirement_statements r join p on p.document_id = r.statement_upload_id
union all
select 'retirement_activities', count(*), coalesce(sum(a.amount) filter (where a.activity_type = 'EMPLOYER_CONTRIBUTION'), 0), coalesce(sum(a.amount) filter (where a.activity_type = 'PERSONAL_CONTRIBUTION'), 0), coalesce(sum(a.amount) filter (where a.activity_type = 'FEE'), 0), null, null
  from fdh_retirement_statement_activities a join fdh_retirement_statements r on r.id = a.statement_id join p on p.document_id = r.statement_upload_id
union all
select 'au_investment', count(*), max(i.opening_portfolio_value), max(i.closing_portfolio_value), max(i.cash_balance), max(i.extraction_status), max(i.approval_status)
  from fdh_investment_statements i join p on p.document_id = i.statement_upload_id
union all
select 'ai_draft', count(*), null, null, null, max(d.status), max(d.document_type)
  from fdh_ai_fallback_drafts d join p on p.document_id = d.statement_upload_id;
