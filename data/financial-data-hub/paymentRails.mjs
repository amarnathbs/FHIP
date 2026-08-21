// FDH-2 — payment-rail master. A payment rail is a MECHANISM, never an
// economic category (specification section 38-43 — critical). None of these
// rows carries a category_id, and no classification rule may set
// economic_transaction_type purely from a rail match.
function rail(key, display_name, country_code, rail_category, description, source_key) {
  return { rail_key: key, display_name, country_code, rail_category, description, active: true, source_key };
}

const AU_SRC = 'au_payment_rail_public_documentation';
const IN_SRC = 'in_payment_rail_public_documentation';

export const paymentRails = [
  // Australia
  rail('au_eftpos', 'EFTPOS', 'AU', 'card', 'Electronic Funds Transfer at Point Of Sale — Australia\'s domestic debit-card payment network.', AU_SRC),
  rail('au_bpay', 'BPAY', 'AU', 'bill_payment', 'Australian bill-payment scheme used to pay a biller via a Biller Code and Customer Reference Number.', AU_SRC),
  rail('au_osko', 'Osko', 'AU', 'p2p_transfer', 'Near-real-time payment service built on Australia\'s New Payments Platform (NPP), commonly used for fast account-to-account transfers.', AU_SRC),
  rail('au_payid', 'PayID', 'AU', 'p2p_transfer', 'An NPP addressing service allowing a payment to be sent to a registered identifier (email/phone) instead of a BSB and account number.', AU_SRC),
  rail('au_direct_debit', 'Direct Debit', 'AU', 'direct_debit', 'A pre-authorised debit initiated by a biller/merchant against the account, commonly used for recurring bills and loan repayments.', AU_SRC),
  rail('au_direct_credit', 'Direct Credit', 'AU', 'direct_credit', 'A credit deposited directly into the account, commonly used for salary/payroll and government payments.', AU_SRC),
  rail('au_atm', 'ATM', 'AU', 'atm', 'Automated teller machine cash withdrawal or balance transaction.', AU_SRC),
  rail('au_card_purchase', 'Card Purchase', 'AU', 'card', 'A card-present or card-not-present purchase transaction (debit or credit card).', AU_SRC),

  // India
  rail('in_upi', 'UPI', 'IN', 'p2p_transfer', 'Unified Payments Interface — India\'s real-time payment system (NPCI) for account-to-account and merchant payments via a UPI ID/handle.', IN_SRC),
  rail('in_imps', 'IMPS', 'IN', 'p2p_transfer', 'Immediate Payment Service — a 24x7 interbank electronic fund-transfer service in India.', IN_SRC),
  rail('in_neft', 'NEFT', 'IN', 'direct_credit', 'National Electronic Funds Transfer — a batched interbank electronic fund-transfer system in India.', IN_SRC),
  rail('in_rtgs', 'RTGS', 'IN', 'wire', 'Real Time Gross Settlement — India\'s real-time, high-value interbank funds-transfer system.', IN_SRC),
  rail('in_nach', 'NACH', 'IN', 'direct_debit', 'National Automated Clearing House — used for bulk/recurring debits and credits in India (e.g. EMI collection, salary disbursement).', IN_SRC),
  rail('in_ecs', 'ECS', 'IN', 'direct_debit', 'Electronic Clearing Service — an older bulk payment mechanism in India, largely superseded by NACH.', IN_SRC),
  rail('in_atm', 'ATM', 'IN', 'atm', 'Automated teller machine cash withdrawal or balance transaction.', IN_SRC),
  rail('in_pos_card', 'POS / Card', 'IN', 'card', 'A card-present or card-not-present purchase transaction (debit or credit card) at point of sale.', IN_SRC),

  // Global / country-neutral
  rail('global_wire', 'Wire Transfer', null, 'wire', 'A cross-border or high-value bank wire transfer (e.g. SWIFT).', 'fhip_taxonomy_design'),
  rail('global_transfer', 'Bank Transfer (General)', null, 'p2p_transfer', 'A generic bank-to-bank transfer whose specific local rail could not be determined from the narrative alone.', 'fhip_taxonomy_design'),
  rail('global_cash', 'Cash', null, 'cash', 'A cash transaction with no electronic payment rail.', 'fhip_taxonomy_design'),
  rail('global_other', 'Other', null, 'other', 'A payment mechanism that does not fit any other defined rail.', 'fhip_taxonomy_design'),
];
