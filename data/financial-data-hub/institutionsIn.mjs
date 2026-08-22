// FDH-2 — Indian institution master. Every row's coverage_status is
// 'master_only' — no parser exists yet (FDH-3+). See
// FDH2_RESEARCH_EVIDENCE.md and FDH2_INSTITUTION_MASTER.md section 4 for
// confidence disclosures on any institution whose current status could not
// be independently re-verified without live web access.
const S = 'in_institution_public_websites';

function inst(code, name, type, opts = {}) {
  return {
    institution_code: code,
    institution_name: name,
    institution_type: type,
    legal_name: opts.legal_name ?? name,
    parent_group: opts.parent_group ?? null,
    website_domain: opts.website_domain ?? null,
    coverage_status: 'master_only',
    source_key: opts.source_key ?? S,
    source_checked_at: '2026-08-21',
    capabilities: opts.capabilities ?? [],
    aliases: opts.aliases ?? [],
    notes: opts.notes ?? null,
  };
}

export const institutionsIn = [
  inst('sbi', 'State Bank of India', 'bank', {
    website_domain: 'sbi.co.in',
    aliases: ['SBI', 'STATE BANK OF INDIA'],
  }),
  inst('hdfc_bank', 'HDFC Bank', 'bank', {
    legal_name: 'HDFC Bank Limited',
    website_domain: 'hdfcbank.com',
    aliases: ['HDFC', 'HDFC BANK'],
    notes: 'HDFC Bank completed its merger with parent Housing Development Finance Corporation Limited (HDFC Ltd) in 2023.',
  }),
  inst('icici_bank', 'ICICI Bank', 'bank', {
    legal_name: 'ICICI Bank Limited',
    website_domain: 'icicibank.com',
    aliases: ['ICICI', 'ICICI BANK'],
  }),
  inst('axis_bank', 'Axis Bank', 'bank', {
    legal_name: 'Axis Bank Limited',
    website_domain: 'axisbank.com',
    aliases: ['AXIS', 'AXIS BANK'],
  }),
  inst('kotak_mahindra_bank', 'Kotak Mahindra Bank', 'bank', {
    legal_name: 'Kotak Mahindra Bank Limited',
    website_domain: 'kotak.com',
    aliases: ['KOTAK', 'KOTAK MAHINDRA BANK', 'KOTAK BANK'],
  }),
  inst('idfc_first_bank', 'IDFC FIRST Bank', 'bank', {
    legal_name: 'IDFC FIRST Bank Limited',
    website_domain: 'idfcfirstbank.com',
    aliases: ['IDFC FIRST', 'IDFC FIRST BANK', 'IDFC BANK'],
  }),
  inst('bank_of_baroda', 'Bank of Baroda', 'bank', {
    website_domain: 'bankofbaroda.in',
    aliases: ['BOB', 'BANK OF BARODA'],
    notes: 'Public-sector bank; Vijaya Bank and Dena Bank were amalgamated into Bank of Baroda in 2019.',
  }),
  inst('pnb', 'Punjab National Bank', 'bank', {
    website_domain: 'pnbindia.in',
    aliases: ['PNB', 'PUNJAB NATIONAL BANK'],
    notes: 'Public-sector bank; Oriental Bank of Commerce and United Bank of India were amalgamated into PNB in 2020.',
  }),
  inst('canara_bank', 'Canara Bank', 'bank', {
    website_domain: 'canarabank.com',
    aliases: ['CANARA', 'CANARA BANK'],
    notes: 'Public-sector bank; Syndicate Bank was amalgamated into Canara Bank in 2020.',
  }),
  inst('union_bank_of_india', 'Union Bank of India', 'bank', {
    website_domain: 'unionbankofindia.co.in',
    aliases: ['UNION BANK', 'UNION BANK OF INDIA'],
    notes: 'Public-sector bank; Andhra Bank and Corporation Bank were amalgamated into Union Bank of India in 2020.',
  }),
  inst('indian_bank', 'Indian Bank', 'bank', {
    website_domain: 'indianbank.in',
    aliases: ['INDIAN BANK'],
    notes: 'Public-sector bank; Allahabad Bank was amalgamated into Indian Bank in 2020.',
  }),
  inst('indusind_bank', 'IndusInd Bank', 'bank', {
    legal_name: 'IndusInd Bank Limited',
    website_domain: 'indusind.com',
    aliases: ['INDUSIND', 'INDUSIND BANK'],
  }),
  inst('federal_bank', 'Federal Bank', 'bank', {
    legal_name: 'The Federal Bank Limited',
    website_domain: 'federalbank.co.in',
    aliases: ['FEDERAL BANK'],
  }),
  inst('yes_bank', 'Yes Bank', 'bank', {
    legal_name: 'Yes Bank Limited',
    website_domain: 'yesbank.in',
    aliases: ['YES BANK'],
    source_checked_at: '2026-08-22',
    notes: 'Underwent an RBI-led reconstruction scheme in 2020, with a consortium led by State Bank of India taking an equity stake. CLOSURE-RESEARCH UPDATE 2026-08-22 (live web search): that SBI-led consortium stake has since been substantially sold down — Sumitomo Mitsui Banking Corporation (SMBC, Japan) completed a ~20% secondary purchase from SBI and other lenders in 2025 and, with RBI approval, an additional stake to reach ~24.2%, becoming Yes Bank\'s largest shareholder (SMBC nominee directors joined the board September 2025). Not a majority/controlling stake, so parent_group is deliberately left null rather than overstated. See FDH2_RESEARCH_EVIDENCE.md closure-research section.',
  }),
  inst('au_small_finance_bank', 'AU Small Finance Bank', 'bank', {
    legal_name: 'AU Small Finance Bank Limited',
    website_domain: 'aubank.in',
    aliases: ['AU SMALL FINANCE BANK', 'AU BANK'],
  }),
  inst('rbi', 'Reserve Bank of India', 'government_payment_source', {
    legal_name: 'Reserve Bank of India',
    website_domain: 'rbi.org.in',
    aliases: ['RBI', 'RESERVE BANK OF INDIA'],
    source_key: 'in_government_payment_public_info',
  }),
  inst('zerodha', 'Zerodha', 'broker', {
    legal_name: 'Zerodha Broking Limited',
    website_domain: 'zerodha.com',
    aliases: ['ZERODHA'],
  }),
  inst('groww', 'Groww', 'broker', {
    legal_name: 'Billionbrains Garage Ventures Limited',
    website_domain: 'groww.in',
    capabilities: ['mutual_fund_platform'],
    aliases: ['GROWW'],
    source_checked_at: '2026-08-22',
    notes: 'CLOSURE-RESEARCH CORRECTED 2026-08-22 (live web search): the holding company converted from a private to a public limited company (board resolution 29 Jan 2025, fresh certificate of incorporation 11 Apr 2025) ahead of its November 2025 IPO; legal_name corrected from "...Private Limited" to "...Limited". The Groww consumer brand name is unchanged. See FDH2_RESEARCH_EVIDENCE.md closure-research section.',
  }),
  inst('nsdl', 'NSDL', 'depository', {
    legal_name: 'National Securities Depository Limited',
    website_domain: 'nsdl.co.in',
    aliases: ['NSDL', 'NATIONAL SECURITIES DEPOSITORY'],
  }),
  inst('cdsl', 'CDSL', 'depository', {
    legal_name: 'Central Depository Services (India) Limited',
    website_domain: 'cdslindia.com',
    aliases: ['CDSL', 'CENTRAL DEPOSITORY SERVICES'],
  }),
  inst('cams', 'CAMS', 'mutual_fund_platform', {
    legal_name: 'Computer Age Management Services Limited',
    website_domain: 'camsonline.com',
    aliases: ['CAMS'],
    notes: 'Registrar and transfer agent (RTA) for a large share of the Indian mutual-fund industry.',
  }),
  inst('kfintech', 'KFintech', 'mutual_fund_platform', {
    legal_name: 'KFin Technologies Limited',
    website_domain: 'kfintech.com',
    aliases: ['KFINTECH', 'KARVY', 'KFIN'],
    notes: 'Formerly Karvy Fintech; registrar and transfer agent (RTA) for mutual funds.',
  }),
  inst('epfo', 'EPFO', 'retirement_provider', {
    legal_name: "Employees' Provident Fund Organisation",
    website_domain: 'epfindia.gov.in',
    aliases: ['EPFO', "EMPLOYEES' PROVIDENT FUND ORGANISATION", 'EPF'],
    source_key: 'in_government_payment_public_info',
  }),
  inst('protean_enps', 'Protean eGov Technologies (NPS)', 'retirement_provider', {
    legal_name: 'Protean eGov Technologies Limited',
    website_domain: 'npscra.proteantech.in',
    aliases: ['PROTEAN', 'NSDL E-GOV', 'NSDL E-GOVERNANCE', 'NPS TRUST'],
    source_checked_at: '2026-08-22',
    notes: 'Formerly NSDL e-Governance Infrastructure Limited; operates as a Central Recordkeeping Agency (CRA) for the National Pension System (NPS). CLOSURE-RESEARCH CORRECTED 2026-08-22 (live web search): the NPS CRA informational site has migrated from the legacy npscra.nsdl.co.in domain to npscra.proteantech.in; website_domain corrected to the current live domain. See FDH2_RESEARCH_EVIDENCE.md closure-research section.',
  }),
  inst('income_tax_department_india', 'Income Tax Department (India)', 'government_payment_source', {
    legal_name: 'Income Tax Department, Government of India',
    website_domain: 'incometax.gov.in',
    aliases: ['INCOME TAX DEPARTMENT', 'ITD'],
    source_key: 'in_government_payment_public_info',
  }),
];
