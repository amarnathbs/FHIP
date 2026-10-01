"""BENCH-1 Phase 2 - build the REAL scheme -> required-benchmark matrix, the catalogue manifest and the
governed seed SQL from the two evidence sets collected on 2026-10-01:

  docs/investment-intelligence/bench1_phase2/inventory/inventory_combined.csv      (held schemes, DEV+PROD, read-only)
  docs/investment-intelligence/bench1_phase2/mapping_evidence/mapping_evidence.json (AMC scheme documents, public)

Nothing here is invented: every catalogue and mapping row traces to a retrieved public document; where evidence is
weaker than a scheme document the row is marked and routed to admin review. The seed SQL calls ONLY the governed
RPCs (upsert_benchmark_catalogue_entry, propose_benchmark_mapping), under an admin identity the PO sets, so every row
is audited; it creates DRAFT catalogue entries and PROPOSALS - it verifies and approves nothing.

Run: python scripts/bench1_build_matrix_and_seed.py
"""
import csv
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
B = os.path.join(ROOT, 'docs', 'investment-intelligence', 'bench1_phase2')
OUT_MATRIX_MD = os.path.join(ROOT, 'docs', 'investment-intelligence', 'BENCH1_PHASE2_SCHEME_BENCHMARK_MATRIX_2026-10-01.md')
OUT_MATRIX_CSV = os.path.join(B, 'scheme_benchmark_matrix.csv')
OUT_MANIFEST = os.path.join(B, 'catalogue_manifest.json')
OUT_SQL = os.path.join(ROOT, 'docs', 'admin', 'po_apply_bench1_phase2', '03_seed_catalogue_and_mapping_proposals.sql')

NSE = 'NSE Indices Limited'
BSE = 'BSE Index Services Private Limited (formerly Asia Index; renamed 2025-08-01 per BSE page)'

# amfi_scheme_code (or 'ISIN:<isin>') -> (catalogue key, official name as written in the scheme document, owner (inferred), asset class)
KEYMAP = {
    '103174': ('IN_NIFTY_100_TRI', 'NIFTY 100 TRI', NSE, 'equity'),
    '119018': ('IN_NIFTY_100_TRI', 'NIFTY 100 TRI', NSE, 'equity'),
    '102000': ('IN_NIFTY_100_TRI', 'NIFTY 100 TRI', NSE, 'equity'),
    '112277': ('IN_BSE_100_TRI', 'BSE 100 TRI', BSE, 'equity'),
    '103504': ('IN_BSE_100_TRI', 'BSE 100 TRI', BSE, 'equity'),
    '100520': ('IN_NIFTY_500_TRI', 'Nifty 500 TRI', NSE, 'equity'),
    '118955': ('IN_NIFTY_500_TRI', 'Nifty 500 TRI', NSE, 'equity'),
    '101762': ('IN_NIFTY_500_TRI', 'Nifty 500 TRI', NSE, 'equity'),
    '122639': ('IN_NIFTY_500_TRI', 'Nifty 500 TRI', NSE, 'equity'),
    '129310': ('IN_NIFTY_500_TRI', 'Nifty 500 TRI', NSE, 'equity'),
    '100473': ('IN_NIFTY_MIDCAP_150_TRI', 'Nifty Midcap 150 TRI', NSE, 'equity'),
    '105758': ('IN_NIFTY_MIDCAP_150_TRI', 'Nifty Midcap 150 TRI', NSE, 'equity'),
    '104908': ('IN_NIFTY_MIDCAP_150_TRI', 'Nifty Midcap 150 TRI', NSE, 'equity'),
    '102414': ('IN_BSE_500_TRI', 'BSE 500 TRI', BSE, 'equity'),
    '130502': ('IN_BSE_250_SMALLCAP_TRI', 'BSE 250 SmallCap TRI', BSE, 'equity'),
    '118834': ('IN_NIFTY_LARGEMIDCAP_250_TRI', 'Nifty LargeMidcap 250 TRI', NSE, 'equity'),
    '101262': ('IN_NIFTY_INFRASTRUCTURE_TRI', 'Nifty Infrastructure TRI', NSE, 'equity'),
    '100740': ('IN_NIFTY_MNC_TRI', 'Nifty MNC TRI', NSE, 'equity'),
    '100119': ('IN_NIFTY50_HYBRID_COMP_DEBT_5050_TRI', 'NIFTY 50 Hybrid Composite Debt 50:50 Index TRI', NSE, 'hybrid'),
    'ISIN:INF109KA1Z62': ('IN_NIFTY_CORPORATE_BOND_A2_TRI', 'NIFTY Corporate Bond Index A-II (TRI per SID heading)', NSE, 'debt'),
}
UNSUPPORTED = {
    '103408': 'Composite benchmark (45% BSE 500 TRI + 40% CRISIL Composite Bond Fund Index + 10% domestic gold + 5% domestic silver). One ii_benchmarks series cannot represent it: it needs a blended-benchmark definition and four component series (one CRISIL, two commodity price series whose source no document names). Not built; shown as UNSUPPORTED, never approximated by its equity leg.',
    '115934': 'Benchmark is the "domestic price of physical gold" - not an index and no scheme document names the price source. Needs a PO decision on a permitted gold-price series. Shown as source-blocked.',
}


def csv_rows():
    with open(os.path.join(B, 'inventory', 'inventory_combined.csv'), encoding='utf-8') as f:
        return list(csv.DictReader(f))


def main():
    inv = [r for r in csv_rows() if r['likely_test_fixture'] != 'true']
    ev = json.load(open(os.path.join(B, 'mapping_evidence', 'mapping_evidence.json'), encoding='utf-8'))
    by_key = {}
    for e in ev:
        k = e['amfi_scheme_code'] if e['amfi_scheme_code'] else None
        if k is None:
            m = re.search(r'INF\w{9}', ' '.join(e['isins'])) if e.get('isins') else None
            k = 'ISIN:' + m.group(0) if m else None
        by_key[k] = e
    rows = []
    for r in inv:
        code = r['amfi_scheme_code'] or None
        isin = (r['isins'] or '').split(';')[0].strip()
        k = code if code else 'ISIN:' + isin
        e = by_key.get(k)
        key = KEYMAP.get(k)
        rows.append({
            'scheme_family_key': r['scheme_family_key'], 'scheme_name': r['scheme_name'], 'amc_name': r['amc_name'],
            'plan': r['plan_type'], 'option': r['option_type'], 'amfi_scheme_code': code or '', 'isins': r['isins'],
            'sub_category': r['sub_category'], 'prod_instrument_id': r['prod_instrument_id'], 'dev_instrument_id': r['dev_instrument_id'],
            'in_prod': r['in_prod'], 'in_dev': r['in_dev'],
            'earliest_transaction_date': r['first_transaction_date'], 'earliest_nav_on_file': r['earliest_nav_date_on_file'],
            'required_series_from_investor_rule': r['required_series_from_tx_rule'], 'required_series_from_engine_rule': r['required_series_from_nav_rule'],
            'current_mapping_state': r['mapping_state'], 'availability_state': r['availability_state'],
            'declared_benchmark_in_scheme_document': e['declared_primary_benchmark_exact_name'] if e else '',
            'declared_variant': e['return_variant'] if e else '',
            'evidence_status': e['evidence_status'] if e else 'not_collected',
            'proposed_catalogue_key': key[0] if key else ('UNSUPPORTED' if k in UNSUPPORTED else ''),
            'note': UNSUPPORTED.get(k, ''),
        })
    with open(OUT_MATRIX_CSV, 'w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)

    # distinct catalogue demand
    demand = {}
    for row in rows:
        k = row['proposed_catalogue_key']
        if not k or k == 'UNSUPPORTED':
            continue
        d = demand.setdefault(k, {'rows': 0, 'families': set(), 'from_engine': row['required_series_from_engine_rule'], 'from_investor': row['required_series_from_investor_rule']})
        d['rows'] += 1
        d['families'].add(row['scheme_family_key'])
        d['from_engine'] = min(d['from_engine'], row['required_series_from_engine_rule'])
        d['from_investor'] = min(d['from_investor'], row['required_series_from_investor_rule'])

    manifest = []
    for code, (key, name, owner, ac) in {v[0]: (v[0], v[1], v[2], v[3]) for v in KEYMAP.values()}.items():
        pass
    seen = set()
    for k, (key, name, owner, ac) in KEYMAP.items():
        if key in seen:
            continue
        seen.add(key)
        sample = by_key.get(k)
        doc = (sample['evidence_document'][0] if sample and sample.get('evidence_document') else {})
        manifest.append({
            'benchmark_key': key, 'official_name': name, 'owner_name': owner, 'owner_evidence': 'INFERRED from the index name; no scheme document names the owner (verify on the owner page before verification)',
            'asset_class': ac, 'country_code': 'IN', 'currency_code': 'INR', 'return_type': 'TRI', 'return_variant': 'total_return',
            'history_class': 'unknown', 'base_date': None, 'launch_date': None, 'official_identifier': None,
            'evidence_ref': f"{doc.get('title', 'scheme document')} ({doc.get('doc_date', 'n/a')})", 'evidence_url': doc.get('url'),
            'evidence_retrieved_at': doc.get('retrieval_date', '2026-10-01'),
            'catalogue_status_to_set': 'draft (verification is a human step: owner page not reachable from this environment)',
            'scheme_rows_demanding': demand.get(key, {}).get('rows', 0),
            'scheme_families_demanding': len(demand.get(key, {}).get('families', [])),
            'required_from_engine_rule': demand.get(key, {}).get('from_engine'),
            'required_from_investor_rule': demand.get(key, {}).get('from_investor'),
        })
    json.dump({'generated': '2026-10-01', 'note': 'Draft catalogue entries only. Owners are inferred; official identifiers, base dates and launch dates are NOT verified and are left null.', 'unsupported': UNSUPPORTED, 'entries': manifest}, open(OUT_MANIFEST, 'w', encoding='utf-8'), indent=2)

    # ---- matrix markdown
    md = ['# BENCH-1 Phase 2 - Held-scheme to required-benchmark matrix (REAL demand)', '',
          'Date: 2026-10-01. Source of demand: a read-only inventory of DEV and PRODUCTION (public scheme identifiers and aggregates only; no user, account, folio, unit or amount data). Source of benchmarks: each scheme\'s OWN public document (SID/KIM/factsheet) - AMFI category guidance is not used as evidence.', '',
          f'* Held, eligible scheme rows (real, excluding DEV test fixtures): **{len(rows)}** across **{len(set(r["scheme_family_key"] for r in rows))}** scheme families. All are Indian mutual funds in INR.',
          f'* Distinct benchmark identities demanded by evidenced single-index mappings: **{len(demand)}**. Two further schemes declare benchmarks that one catalogue series cannot represent (see Unsupported).',
          '* Every held scheme is currently **unmapped**; `ii_benchmarks`, `ii_benchmark_series` and `ii_instrument_benchmarks` hold zero rows in DEV and production (verified 2026-10-01).',
          '* Required-from dates: the *engine rule* (first transaction or earliest NAV on file, minus the 10-day alignment lookback the SIP/benchmark engines already use) and the narrower *investor rule* (first transaction only) are both shown; see the coverage report.', '',
          '## Distinct required benchmarks', '', '| Catalogue key (proposed) | Official name in scheme documents | Owner (inferred) | Variant | Scheme rows | Families | Required from (engine rule) | Required from (investor rule) |', '|---|---|---|---|---|---|---|---|']
    for k, d in sorted(demand.items()):
        m = next(x for x in manifest if x['benchmark_key'] == k)
        md.append(f"| `{k}` | {m['official_name']} | {m['owner_name'].split(' (')[0]} | total return (TRI) | {d['rows']} | {len(d['families'])} | {d['from_engine']} | {d['from_investor']} |")
    md += ['', '## Scheme -> benchmark matrix', '', '| Scheme (plan/option) | AMFI code | Category | Declared benchmark (scheme document) | Variant | Evidence | Proposed key | Current mapping | Earliest tx | Required from (engine) |', '|---|---|---|---|---|---|---|---|---|---|']
    for r in sorted(rows, key=lambda x: (x['scheme_family_key'], x['plan'])):
        md.append(f"| {r['scheme_name']} ({r['plan']}/{r['option']}) | {r['amfi_scheme_code'] or 'ISIN ' + r['isins']} | {r['sub_category']} | {r['declared_benchmark_in_scheme_document'][:60]} | {r['declared_variant'][:16]} | {r['evidence_status']} | {r['proposed_catalogue_key'] or '-'} | {r['current_mapping_state']} | {r['earliest_transaction_date']} | {r['required_series_from_engine_rule']} |")
    md += ['', '## Unsupported / source-blocked (not approximated)', '']
    for k, why in UNSUPPORTED.items():
        md.append(f'* AMFI {k}: {why}')
    md += ['', '## Reading the evidence status', '', '* `verified_scheme_document`: the benchmark is stated in the scheme\'s own SID/KIM. Plans/options of one scheme share it.', '* `factsheet_only`: only a monthly factsheet or AMC scheme page was found (ICICI Dividend Yield, Kotak Mid Cap, UTI MNC); UTI MNC evidence is from 2022. These go to admin review, never auto-publish.', '* The full per-scheme evidence (document URLs, document dates, retrieval dates, excerpts, benchmark-change history) is in `docs/investment-intelligence/bench1_phase2/mapping_evidence/`.', '* Known benchmark CHANGES (effective-dated mappings are required): SBI Multi Asset (2023-10-31), ICICI Corporate Bond (2024-03-12), ICICI Dividend Yield (2022-01-01), DSP Large Cap (2026-05-16, not currently held), Franklin Mid (2018, effective date unverified).', '']
    with open(OUT_MATRIX_MD, 'w', encoding='utf-8') as f:
        f.write('\n'.join(md))

    # ---- seed SQL
    sql = ['-- BENCH-1 Phase 2 - governed seed: DRAFT catalogue entries + mapping PROPOSALS (nothing verified or approved).',
           '-- Generated by scripts/bench1_build_matrix_and_seed.py from retrieved public scheme documents (2026-10-01).',
           '--',
           '-- PRECONDITIONS: migrations 0232 and 0239 applied; the admin user named below holds',
           '-- can_manage_benchmark_catalogue (granted by the PO through the normal capability process).',
           '-- WHAT IT DOES: calls ONLY upsert_benchmark_catalogue_entry() and propose_benchmark_mapping() - the same RPCs the',
           '-- Admin UI calls - under that admin identity, so every row is audited in ii_benchmark_governance_events.',
           '-- WHAT IT DOES NOT DO: verify an entry, approve a mapping, create an entitlement, load any index level.',
           '-- Mapping effective_from is the evidence DOCUMENT date (the benchmark is proven from then on); earlier history is',
           '-- left unmapped rather than assumed. Run in the Supabase SQL editor (DEV first). Replace <ADMIN_USER_UUID>.',
           '', "select set_config('request.jwt.claims', json_build_object('sub', '<ADMIN_USER_UUID>', 'role', 'authenticated')::text, true);", '']
    for m in manifest:
        entry = {k: m[k] for k in ('benchmark_key', 'official_name', 'owner_name', 'asset_class', 'country_code', 'currency_code', 'return_type', 'return_variant', 'history_class', 'evidence_ref', 'evidence_retrieved_at')}
        entry['benchmark_category'] = 'index'
        entry['frequency'] = 'business_daily'
        entry['calendar_code'] = 'IN_EXCHANGE'
        entry['source_url'] = m['evidence_url']
        sql.append(f"select upsert_benchmark_catalogue_entry($j${json.dumps(entry)}$j$::jsonb);")
    sql.append('')
    for row in sorted(rows, key=lambda x: x['scheme_name']):
        k = row['proposed_catalogue_key']
        if not k or k == 'UNSUPPORTED':
            continue
        code = row['amfi_scheme_code']
        key_for_ev = code if code else 'ISIN:' + (row['isins'].split(';')[0].strip())
        e = by_key[key_for_ev]
        doc = e['evidence_document'][0]
        status = e['evidence_status']
        weak = status != 'verified_scheme_document' or 'ICICI' in row['scheme_name'] and 'Corporate' in row['scheme_name'] or code in ('100520', '100473', '100740')
        method = 'admin_judgement' if weak else 'deterministic_exact'
        conf = 'medium' if weak else 'high'
        amb = None
        if status != 'verified_scheme_document':
            amb = 'Evidence is a factsheet / scheme page, not the scheme document' + ('; the only retrieved documents are from 2022' if code == '100740' else '')
        elif code in ('100520', '100473'):
            amb = 'Benchmark stated under a Total Return Index heading without the letters TRI in the name; variant inferred from the heading'
        elif 'Corporate' in row['scheme_name']:
            amb = 'Index identity and the ISIN-to-plan mapping are not verified'
        doc_date = doc['doc_date'] if re.match(r'\d{4}-\d{2}-\d{2}$', str(doc['doc_date'])) else '2026-10-01'
        prop = {
            'proposed_benchmark_name': e['declared_primary_benchmark_exact_name'][:190], 'relationship_type': 'primary', 'effective_from': doc_date,
            'evidence_source': {'verified_scheme_document': 'amc_sid', 'factsheet_only': 'amc_factsheet'}.get(status, 'other'),
            'evidence_url': doc['url'], 'evidence_title': doc['title'][:290], 'evidence_document_date': doc_date, 'evidence_retrieved_at': doc.get('retrieval_date', '2026-10-01'),
            'evidence_excerpt': (doc.get('excerpt') or '')[:380], 'resolution_method': method, 'confidence': conf,
        }
        if amb:
            prop['ambiguity_reason'] = amb
        ident = f"(select instrument_id from ii_instrument_identifiers where identifier_scheme = 'amfi_scheme_code' and identifier_value = '{code}' and country_code = 'IN' limit 1)" if code else f"(select instrument_id from ii_instrument_identifiers where identifier_scheme = 'isin' and identifier_value = '{row['isins'].split(';')[0].strip()}' limit 1)"
        sql.append(f"-- {row['scheme_name']} ({row['plan']}/{row['option']}) -> {k} [{status}]")
        sql.append(f"select propose_benchmark_mapping(($j${json.dumps(prop)}$j$::jsonb) || jsonb_build_object('instrument_id', {ident}, 'benchmark_id', (select id from ii_benchmarks where benchmark_key = '{k}')))")
        sql.append(f" where {ident} is not null;")
    os.makedirs(os.path.dirname(OUT_SQL), exist_ok=True)
    with open(OUT_SQL, 'w', encoding='utf-8') as f:
        f.write('\n'.join(sql) + '\n')
    print('rows', len(rows), 'demand', len(demand), 'catalogue entries', len(manifest))


if __name__ == '__main__':
    main()
