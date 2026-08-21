// FDH-2 — Australian institution master. Every row's coverage_status is
// 'master_only' — no parser exists yet (FDH-3+). Ownership/name facts are
// stated at the confidence level actually held (see `notes`); where a recent
// ownership change could not be independently re-verified in this
// environment (no live web access), that uncertainty is disclosed rather
// than guessed away — see FDH2_RESEARCH_EVIDENCE.md and
// FDH2_INSTITUTION_MASTER.md section 4 ("Known Gaps / Lower-Confidence
// Entries").
const S = 'au_institution_public_websites';

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

export const institutionsAu = [
  inst('cba', 'Commonwealth Bank of Australia', 'bank', {
    website_domain: 'commbank.com.au',
    aliases: ['CBA', 'COMMBANK', 'COMMONWEALTH BANK', 'COMMONWEALTH BANK OF AUSTRALIA'],
  }),
  inst('westpac', 'Westpac Banking Corporation', 'bank', {
    website_domain: 'westpac.com.au',
    aliases: ['WESTPAC', 'WBC'],
  }),
  inst('nab', 'National Australia Bank', 'bank', {
    legal_name: 'National Australia Bank Limited',
    website_domain: 'nab.com.au',
    aliases: ['NAB', 'NATIONAL AUSTRALIA BANK'],
  }),
  inst('anz', 'ANZ', 'bank', {
    legal_name: 'Australia and New Zealand Banking Group Limited',
    website_domain: 'anz.com.au',
    aliases: ['ANZ', 'ANZ BANK', 'AUSTRALIA AND NEW ZEALAND BANKING GROUP'],
  }),
  inst('macquarie_bank', 'Macquarie Bank', 'bank', {
    legal_name: 'Macquarie Bank Limited',
    parent_group: 'Macquarie Group Limited',
    website_domain: 'macquarie.com.au',
    capabilities: ['broker', 'investment_platform'],
    aliases: ['MACQUARIE', 'MACQUARIE BANK'],
    notes: 'Macquarie Group operates retail banking and a wealth/investment platform under one group; recorded as two capabilities on one institution rather than a duplicate row.',
  }),
  inst('ing_australia', 'ING (Australia)', 'bank', {
    legal_name: 'ING Bank (Australia) Limited',
    parent_group: 'ING Groep N.V.',
    website_domain: 'ing.com.au',
    aliases: ['ING', 'ING DIRECT'],
  }),
  inst('bendigo_adelaide_bank', 'Bendigo and Adelaide Bank', 'bank', {
    legal_name: 'Bendigo and Adelaide Bank Limited',
    website_domain: 'bendigobank.com.au',
    aliases: ['BENDIGO BANK', 'ADELAIDE BANK', 'BENDIGO AND ADELAIDE BANK'],
  }),
  inst('bank_australia', 'Bank Australia', 'bank', {
    legal_name: 'Bank Australia Limited',
    website_domain: 'bankaust.com.au',
    aliases: ['BANK AUSTRALIA'],
    notes: 'Customer-owned bank, formerly bankmecu.',
  }),
  inst('amp_bank', 'AMP Bank', 'bank', {
    legal_name: 'AMP Bank Limited',
    parent_group: 'AMP Limited',
    website_domain: 'amp.com.au',
    aliases: ['AMP BANK', 'AMP'],
  }),
  inst('boq', 'Bank of Queensland', 'bank', {
    legal_name: 'Bank of Queensland Limited',
    website_domain: 'boq.com.au',
    aliases: ['BOQ', 'BANK OF QUEENSLAND'],
  }),
  inst('me_bank', 'ME Bank', 'bank', {
    legal_name: 'Members Equity Bank Pty Limited',
    parent_group: 'Bank of Queensland Group',
    website_domain: 'mebank.com.au',
    aliases: ['ME BANK', 'MEMBERS EQUITY BANK', 'ME'],
    notes: 'LOWER-CONFIDENCE ENTRY: acquired by Bank of Queensland Group in 2021. Public reporting has described an ongoing migration/consolidation of the ME retail brand into BOQ Group\'s digital platforms; the exact current operational status could not be independently re-verified without live web access in this environment. Seeded as a historically significant AU institution with disclosed uncertainty rather than an asserted current operating status — see FDH2_INSTITUTION_MASTER.md section 4.',
  }),
  inst('ubank', 'ubank', 'bank', {
    legal_name: 'ubank Limited',
    parent_group: 'National Australia Bank',
    website_domain: 'ubank.com.au',
    aliases: ['UBANK'],
    notes: 'Digital-only bank brand wholly owned by NAB.',
  }),
  inst('great_southern_bank', 'Great Southern Bank', 'bank', {
    legal_name: 'Great Southern Bank (a trading name of Credit Union Australia Limited)',
    website_domain: 'greatsouthernbank.com.au',
    aliases: ['GREAT SOUTHERN BANK', 'CUA', 'CREDIT UNION AUSTRALIA'],
    notes: 'Rebranded from Credit Union Australia (CUA) in 2021.',
  }),
  inst('hsbc_australia', 'HSBC Bank Australia', 'bank', {
    legal_name: 'HSBC Bank Australia Limited',
    parent_group: 'HSBC Holdings plc',
    website_domain: 'hsbc.com.au',
    aliases: ['HSBC', 'HSBC AUSTRALIA'],
  }),
  inst('suncorp_bank', 'Suncorp Bank', 'bank', {
    legal_name: 'Suncorp-Metway Limited',
    parent_group: 'ANZ Group Holdings Limited',
    website_domain: 'suncorp.com.au',
    aliases: ['SUNCORP', 'SUNCORP BANK', 'SUNCORP-METWAY'],
    notes: 'LOWER-CONFIDENCE ENTRY: ANZ\'s acquisition of Suncorp Bank was publicly announced in 2022 and reported completed in 2024; the precise current legal/operational structure could not be independently re-verified without live web access — see FDH2_INSTITUTION_MASTER.md section 4.',
  }),
  inst('commsec', 'CommSec', 'broker', {
    legal_name: 'Commonwealth Securities Limited',
    parent_group: 'Commonwealth Bank of Australia',
    website_domain: 'commsec.com.au',
    aliases: ['COMMSEC', 'COMMONWEALTH SECURITIES'],
  }),
  inst('selfwealth', 'SelfWealth', 'broker', {
    legal_name: 'SelfWealth Limited',
    website_domain: 'selfwealth.com.au',
    aliases: ['SELFWEALTH'],
  }),
  inst('australiansuper', 'AustralianSuper', 'super_fund', {
    website_domain: 'australiansuper.com',
    aliases: ['AUSTRALIANSUPER'],
  }),
  inst('australian_retirement_trust', 'Australian Retirement Trust', 'super_fund', {
    website_domain: 'art.com.au',
    aliases: ['AUSTRALIAN RETIREMENT TRUST', 'ART', 'SUNSUPER', 'QSUPER'],
    notes: 'Formed by the 2022 merger of Sunsuper and QSuper.',
  }),
  inst('hostplus', 'Hostplus', 'super_fund', {
    website_domain: 'hostplus.com.au',
    aliases: ['HOSTPLUS'],
  }),
  inst('services_australia', 'Services Australia', 'government_payment_source', {
    legal_name: 'Services Australia (Commonwealth of Australia)',
    website_domain: 'servicesaustralia.gov.au',
    aliases: ['SERVICES AUSTRALIA', 'CENTRELINK'],
    source_key: 'au_government_payment_public_info',
  }),
  inst('ato', 'Australian Taxation Office', 'government_payment_source', {
    legal_name: 'Australian Taxation Office (Commonwealth of Australia)',
    website_domain: 'ato.gov.au',
    aliases: ['ATO', 'AUSTRALIAN TAXATION OFFICE'],
    source_key: 'au_government_payment_public_info',
  }),
];
