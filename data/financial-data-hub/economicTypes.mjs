// FDH-2 — descriptive metadata for FDH-1's existing economic_transaction_type
// vocabulary (fdh_economic_transaction_types). The check-constraint list
// itself is unchanged; this only adds display copy.
export const economicTypes = [
  { economic_type: 'income', display_name: 'Income', description: 'Money received that increases household resources — salary, wages, business income, rental income, interest, dividends, government benefits, pensions and similar.' },
  { economic_type: 'expense', display_name: 'Expense', description: 'A household outflow for goods, services or living costs.' },
  { economic_type: 'transfer', display_name: 'Transfer', description: 'A movement of money between the household\'s own accounts, or a settlement such as a credit-card bill payment. Not income or expense in itself.' },
  { economic_type: 'investment', display_name: 'Investment', description: 'A movement of money into or related to an investment or retirement-contribution activity.' },
  { economic_type: 'debt_principal', display_name: 'Debt principal repayment', description: 'The portion of a loan repayment that reduces the outstanding principal balance.' },
  { economic_type: 'debt_interest', display_name: 'Debt interest', description: 'Interest charged on a loan or credit facility.' },
  { economic_type: 'refund', display_name: 'Refund / reversal', description: 'Money returned for a prior purchase, or a reversed/charged-back transaction.' },
  { economic_type: 'asset_purchase', display_name: 'Asset purchase', description: 'Money used to acquire an investment or other recorded asset.' },
  { economic_type: 'asset_sale', display_name: 'Asset sale', description: 'Money received from disposing of an investment or other recorded asset.' },
  { economic_type: 'tax', display_name: 'Tax', description: 'A tax payment or a tax-related government charge.' },
  { economic_type: 'fee', display_name: 'Fee', description: 'A bank, card or account fee or charge, distinct from interest.' },
  { economic_type: 'cash_withdrawal', display_name: 'Cash withdrawal', description: 'Cash withdrawn from an account via ATM or branch. Not automatically household consumption — what the cash was later used for is unknown.' },
  { economic_type: 'unknown', display_name: 'Unknown', description: 'Not yet resolved to any of the above. The default state until a classification is made.' },
];
