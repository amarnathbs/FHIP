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
    aliases: ['BANK AUSTRALIA', 'QUDOS BANK'],
    source_checked_at: '2026-08-22',
    notes: 'Customer-owned bank, formerly bankmecu. CLOSURE-RESEARCH UPDATE 2026-08-22 (live web search): Bank Australia Ltd completed its merger with Qudos Bank on 1 July 2025; both retail brands now operate under the single Bank Australia Ltd legal entity, so a "QUDOS BANK" statement narrative now resolves to this institution — added as an alias. A further prospective merger with P&N Group is under member consideration (vote expected 2027) and is NOT yet reflected here — not asserted as complete. See FDH2_RESEARCH_EVIDENCE.md closure-research section.',
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
    legal_name: 'Bank of Queensland Limited',
    parent_group: 'Bank of Queensland Group',
    website_domain: 'mebank.com.au',
    aliases: ['ME BANK', 'MEMBERS EQUITY BANK', 'ME'],
    source_checked_at: '2026-08-22',
    notes: 'CLOSURE-RESEARCH VERIFIED 2026-08-22 (live web search): APRA revoked Members Equity Bank Limited\'s ADI licence following the transfer of ME Bank\'s banking assets and liabilities to Bank of Queensland Limited (BOQ) after BOQ\'s 2021 acquisition; ME Bank\'s own official site footer now states "ME Bank – a division of Bank of Queensland Limited ABN 32 009 656 740". ME Bank is therefore no longer a separately licensed legal entity — legal_name corrected from the pre-acquisition "Members Equity Bank Pty Limited" to the current licence holder. The ME retail brand remains actively operated. See FDH2_RESEARCH_EVIDENCE.md closure-research section.',
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
    legal_name: 'Norfina Limited',
    parent_group: 'ANZ Group Holdings Limited',
    website_domain: 'suncorp.com.au',
    aliases: ['SUNCORP', 'SUNCORP BANK', 'SUNCORP-METWAY', 'NORFINA'],
    source_checked_at: '2026-08-22',
    notes: 'CLOSURE-RESEARCH VERIFIED 2026-08-22 (live web search): ANZ completed the $4.9bn acquisition of Suncorp Bank on 31 July 2024. As part of the transition, Suncorp-Metway Limited legally changed its name to Norfina Limited (same ABN 66 010 831 722), while continuing to trade under the Suncorp Bank brand (AFCA confirms complaints against "Suncorp Bank" are filed against Norfina Limited). Norfina Limited remains a separate ADI within the ANZ Group pending an eventual single-licence merger; legal_name corrected from the pre-rename "Suncorp-Metway Limited". See FDH2_RESEARCH_EVIDENCE.md closure-research section.',
  }),
  inst('commsec', 'CommSec', 'broker', {
    legal_name: 'Commonwealth Securities Limited',
    parent_group: 'Commonwealth Bank of Australia',
    website_domain: 'commsec.com.au',
    aliases: ['COMMSEC', 'COMMONWEALTH SECURITIES'],
  }),
  inst('selfwealth', 'SelfWealth', 'broker', {
    legal_name: 'SelfWealth Limited',
    parent_group: 'Syfe (Svava Pte Ltd)',
    website_domain: 'selfwealth.com.au',
    aliases: ['SELFWEALTH'],
    source_checked_at: '2026-08-22',
    notes: 'CLOSURE-RESEARCH CORRECTED 2026-08-22 (live web search): SelfWealth was the subject of a competing 2024-2025 takeover contest (Bell Financial Group vs. AxiCorp vs. Syfe); Singapore-based fintech Syfe (via its holding vehicle Svava Pte Ltd) won with a binding $65m proposal after Bell declined to counter-bid (26 Feb 2025). SelfWealth was subsequently delisted from the ASX and now trades as "Selfwealth by Syfe". parent_group added to reflect the new ownership; the exact post-delisting legal-entity name could not be independently confirmed in this pass and legal_name is left as the last-known "SelfWealth Limited" rather than guessed. See FDH2_RESEARCH_EVIDENCE.md closure-research section.',
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
