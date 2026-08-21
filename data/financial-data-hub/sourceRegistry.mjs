// FDH-2 — shared provenance-source registry.
//
// Every source_key referenced by any other data module in this directory
// must appear here. `source_category` follows FDH_SOURCE_CATEGORIES
// (lib/financial-data-hub/constants/enums.ts). `source_reference_note` is a
// short, non-scraped pointer (a domain or a document title) — never a
// verbatim copy of proprietary or closed content. Full citation detail is in
// docs/financial-data-hub/FDH2_RESEARCH_EVIDENCE.md.
export const sourceRegistry = [
  {
    source_key: 'iso18245_mcc_public_reference',
    source_name: 'ISO 18245 Merchant Category Codes — public payment-network reference lists',
    source_category: 'official_mcc_reference',
    source_reference_note: 'Publicly documented MCC lists published by card-network reference materials (e.g. Visa/Mastercard merchant category tables) and cross-industry MCC directories',
    accessed_at: '2026-08-21',
    notes: 'Used for MCC code + standard description only. No proprietary per-merchant mapping was copied — mappings to FHIP categories are FHIP design decisions.',
  },
  {
    source_key: 'au_institution_public_websites',
    source_name: 'Australian financial institution official websites and public regulatory disclosures',
    source_category: 'institution_official_website',
    source_reference_note: 'Official corporate/brand websites and APRA-authorised-ADI public register',
    accessed_at: '2026-08-21',
    notes: 'Used for institution legal names, brand names, and ownership structure only. No customer data of any kind.',
  },
  {
    source_key: 'in_institution_public_websites',
    source_name: 'Indian financial institution official websites and RBI public bank list',
    source_category: 'institution_official_website',
    source_reference_note: 'Official corporate/brand websites and RBI-published scheduled commercial bank list',
    accessed_at: '2026-08-21',
    notes: 'Used for institution legal names, brand names, and ownership structure only. No customer data of any kind.',
  },
  {
    source_key: 'au_public_merchant_information',
    source_name: 'Australian merchant/retailer public company information',
    source_category: 'public_company_information',
    source_reference_note: 'Official corporate websites, ASX/ASIC public company records, publicly reported store-brand information',
    accessed_at: '2026-08-21',
    notes: 'Used for merchant identity (legal/trading name, sector, website domain) only.',
  },
  {
    source_key: 'in_public_merchant_information',
    source_name: 'Indian merchant/retailer/platform public company information',
    source_category: 'public_company_information',
    source_reference_note: 'Official corporate websites and publicly reported company/brand information',
    accessed_at: '2026-08-21',
    notes: 'Used for merchant identity (legal/trading name, sector, website domain) only.',
  },
  {
    source_key: 'au_government_payment_public_info',
    source_name: 'Services Australia / ATO public payment-description information',
    source_category: 'government_official_source',
    source_reference_note: 'Publicly published descriptions of Centrelink/Services Australia payment types and ATO refund/payment reference conventions',
    accessed_at: '2026-08-21',
    notes: 'Used to describe generic AU government payment/refund categories. No individual-level benefit data.',
  },
  {
    source_key: 'in_government_payment_public_info',
    source_name: 'EPFO / Income Tax Department India public payment-description information',
    source_category: 'government_official_source',
    source_reference_note: 'Publicly published descriptions of EPFO contribution/withdrawal conventions and income-tax refund reference conventions',
    accessed_at: '2026-08-21',
    notes: 'Used to describe generic India government/retirement payment categories. No individual-level benefit data.',
  },
  {
    source_key: 'au_payment_rail_public_documentation',
    source_name: 'Australian payment-system public documentation (BPAY, PayID/NPP, EFTPOS)',
    source_category: 'industry_public_documentation',
    source_reference_note: 'Publicly available scheme documentation describing BPAY, Osko/PayID (New Payments Platform) and EFTPOS as payment mechanisms',
    accessed_at: '2026-08-21',
    notes: 'Used to describe payment RAIL structure only — never as an economic category.',
  },
  {
    source_key: 'in_payment_rail_public_documentation',
    source_name: 'Indian payment-system public documentation (UPI/NPCI, IMPS, NEFT, RTGS)',
    source_category: 'industry_public_documentation',
    source_reference_note: 'Publicly available NPCI/RBI documentation describing UPI, IMPS, NEFT and RTGS as payment mechanisms',
    accessed_at: '2026-08-21',
    notes: 'Used to describe payment RAIL structure only — never as an economic category.',
  },
  {
    source_key: 'fhip_taxonomy_design',
    source_name: 'FHIP-designed category/subcategory taxonomy',
    source_category: 'fhip_design_decision',
    source_reference_note: 'Internal FHIP design, informed by the personal-finance/banking-classification research summarised in FDH2_RESEARCH_EVIDENCE.md',
    accessed_at: '2026-08-21',
    notes: 'Structural taxonomy decisions (families, subcategories, economic-type assignment, essential/discretionary defaults) are FHIP-owned design, not a copied third-party taxonomy.',
  },
  {
    source_key: 'personal_finance_classification_research',
    source_name: 'Published personal-finance/banking transaction-classification concepts',
    source_category: 'industry_public_documentation',
    source_reference_note: 'Publicly documented concepts of category taxonomy structure, merchant normalisation, recurring/subscription handling, transfer treatment and user-rule precedence, as commonly described in personal-finance-software product documentation and payment-network category literature',
    accessed_at: '2026-08-21',
    notes: 'Used for CONCEPTS only (how such systems are commonly structured) — no proprietary source code, database or closed dataset was copied.',
  },
];
