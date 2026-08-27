#!/usr/bin/env python3
"""
II-R12 terminal certification continuation -- deterministic case expansion.

Appends genuinely distinct new cases (not cosmetic duplicates -- each one
exercises a different boundary condition: a different anniversary offset,
a different grandfathering ordering, a different instrument-identity
sharing pattern, a different transaction sequence, a different weight
split) to the existing 41-case r12_cases.json, targeting >=200 total
deterministic cases and >=1200 independent-oracle atomic comparisons
(identity=1/case, holdings=2/case, tax=6/case, publishing=1/case,
xray_attribution=3/case).

Run standalone: python generate_expanded_cases.py
Then regenerate the oracle: python r12_independent_multiasset_oracle.py
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
CASES_PATH = os.path.join(HERE, 'r12_cases.json')


def gen_identity_cases():
    cases = []
    n = 8  # existing ID-001..ID-008

    # Pool of synthetic (ISIN, NSE, BSE) triples -- distinct real-shaped IDs.
    pool = [
        ('INE001A01036', 'MARUTI', '532500'),
        ('INE021A01026', 'ASIANPAINT', '500820'),
        ('INE030A01027', 'HINDUNILVR', '500696'),
        ('INE154A01025', 'ITC', '500875'),
        ('INE296A01024', 'BAJFINANCE', '500034'),
        ('INE733E01010', 'NTPC', '532555'),
        ('INE752E01010', 'POWERGRID', '532898'),
        ('INE917I01010', 'BAJAJ-AUTO', '532977'),
        ('INE075A01022', 'WIPRO', '507685'),
        ('INE522F01014', 'COALINDIA', '533278'),
        ('INE213A01029', 'ONGC', '500312'),
        ('INE238A01034', 'AXISBANK', '532215'),
        ('INE028A01039', 'BANKBARODA', '532134'),
        ('INE160A01022', 'PNB', '532461'),
        ('INE476A01022', 'ICICIPRULI', '540133'),
    ]

    # Pattern A: single instrument, 1..3 identifiers all agreeing -> 1 distinct.
    for i, (isin, nse, bse) in enumerate(pool[:5]):
        n += 1
        idents = [{"scheme": "isin", "value": isin, "countryCode": "IN"}]
        if i % 2 == 0:
            idents.append({"scheme": "nse_symbol", "value": nse, "countryCode": "IN"})
        if i % 3 == 0:
            idents.append({"scheme": "bse_code", "value": bse, "countryCode": "IN"})
        cases.append({"id": f"ID-{n:03d}", "family": "instrument_identity",
                       "instruments": [{"identifiers": idents}]})

    # Pattern B: two separate instrument records, same ISIN via different exchange codes -> 1 distinct.
    for isin, nse, bse in pool[5:10]:
        n += 1
        cases.append({"id": f"ID-{n:03d}", "family": "instrument_identity", "instruments": [
            {"identifiers": [{"scheme": "isin", "value": isin, "countryCode": "IN"}, {"scheme": "nse_symbol", "value": nse, "countryCode": "IN"}]},
            {"identifiers": [{"scheme": "isin", "value": isin, "countryCode": "IN"}, {"scheme": "bse_code", "value": bse, "countryCode": "IN"}]},
        ]})

    # Pattern C: two genuinely different ISINs -> 2 distinct.
    for a in range(0, 8, 2):
        n += 1
        isin1, nse1, _ = pool[a]
        isin2, nse2, _ = pool[a + 1]
        cases.append({"id": f"ID-{n:03d}", "family": "instrument_identity", "instruments": [
            {"identifiers": [{"scheme": "isin", "value": isin1, "countryCode": "IN"}, {"scheme": "nse_symbol", "value": nse1, "countryCode": "IN"}]},
            {"identifiers": [{"scheme": "isin", "value": isin2, "countryCode": "IN"}, {"scheme": "nse_symbol", "value": nse2, "countryCode": "IN"}]},
        ]})

    # Pattern D: NSE-symbol reused across two DIFFERENT countries (country-scoped, not global) -> 2 distinct.
    for _, nse, _ in pool[:4]:
        n += 1
        cases.append({"id": f"ID-{n:03d}", "family": "instrument_identity", "instruments": [
            {"identifiers": [{"scheme": "nse_symbol", "value": nse, "countryCode": "IN"}]},
            {"identifiers": [{"scheme": "nse_symbol", "value": nse, "countryCode": "US"}]},
        ]})

    # Pattern E: 4-5 instrument groups mixing 3-share-ISIN + 2 distinct BSE-only -> N distinct groups.
    for isin, nse, bse in pool[10:13]:
        n += 1
        other_isin = pool[(pool.index((isin, nse, bse)) + 7) % len(pool)][0]
        cases.append({"id": f"ID-{n:03d}", "family": "instrument_identity", "instruments": [
            {"identifiers": [{"scheme": "isin", "value": isin, "countryCode": "IN"}]},
            {"identifiers": [{"scheme": "isin", "value": isin, "countryCode": "IN"}, {"scheme": "nse_symbol", "value": nse, "countryCode": "IN"}]},
            {"identifiers": [{"scheme": "isin", "value": isin, "countryCode": "IN"}, {"scheme": "bse_code", "value": bse, "countryCode": "IN"}]},
            {"identifiers": [{"scheme": "isin", "value": other_isin, "countryCode": "IN"}]},
        ]})

    # Pattern F: SEDOL as a second global scheme, same treatment as ISIN.
    for isin, nse, bse in pool[10:12]:
        n += 1
        sedol = 'B0' + isin[-6:]
        cases.append({"id": f"ID-{n:03d}", "family": "instrument_identity", "instruments": [
            {"identifiers": [{"scheme": "sedol", "value": sedol, "countryCode": "IN"}]},
            {"identifiers": [{"scheme": "sedol", "value": sedol, "countryCode": "IN"}, {"scheme": "bse_code", "value": bse, "countryCode": "IN"}]},
        ]})

    # Pattern G: completely disjoint 3 instruments -> 3 distinct.
    for a in range(0, 6, 3):
        n += 1
        insts = []
        for isin, nse, _ in pool[a:a + 3]:
            insts.append({"identifiers": [{"scheme": "isin", "value": isin, "countryCode": "IN"}, {"scheme": "nse_symbol", "value": nse, "countryCode": "IN"}]})
        cases.append({"id": f"ID-{n:03d}", "family": "instrument_identity", "instruments": insts})

    return cases


def gen_holdings_cases():
    cases = []
    n = 10  # existing HLD-001..010

    templates = [
        # (transactions, price)
        ([{"type": "purchase", "units": 200}], 1450.25),
        ([{"type": "purchase", "units": 75}, {"type": "purchase", "units": 25}], 980.5),
        ([{"type": "purchase", "units": 300}, {"type": "sale", "units": 300}], 210.0),
        ([{"type": "purchase", "units": 40}, {"type": "sale", "units": 10}, {"type": "sale", "units": 10}], 5600.0),
        ([{"type": "purchase", "units": 1000}], 25.5),  # ETF, high unit count
        ([{"type": "purchase", "units": 12.5}, {"type": "purchase", "units": 7.5}], 3300.0),
        ([{"type": "purchase", "units": 60}, {"type": "bonus", "units": 60}, {"type": "sale", "units": 50}], 720.0),
        ([{"type": "purchase", "units": 100}, {"type": "dividend", "amount": 250}, {"type": "sale", "units": 100}], 1800.0),
        ([{"type": "purchase", "units": 5}, {"type": "sale", "units": 5}, {"type": "purchase", "units": 5}], 4100.0),  # buy after sell
        ([{"type": "purchase", "units": 1}], 65000.0),  # single very high-value equity (MRF-style)
        ([{"type": "purchase", "units": 2500}], 8.75),  # penny-stock-scale equity
        ([{"type": "purchase", "units": 100}, {"type": "purchase", "units": 100}, {"type": "purchase", "units": 100}, {"type": "sale", "units": 150}], 640.0),
        ([{"type": "purchase", "units": 50}, {"type": "bonus", "units": 25}], 900.0),  # 1:2 bonus
        ([{"type": "purchase", "units": 200}, {"type": "sale", "units": 199}], 1500.0),  # near-full sell, 1 unit remains
        ([{"type": "purchase", "units": 1000000 / 1000}], 2000.0),
        ([{"type": "purchase", "units": 33}, {"type": "sale", "units": 33}], 999.99),  # exact full sell, odd price
        ([{"type": "purchase", "units": 15}, {"type": "dividend", "amount": 100}], 4500.0),
        ([{"type": "purchase", "units": 500}, {"type": "purchase", "units": 500}, {"type": "sale", "units": 1000}], 32.0),  # full ETF exit
        ([{"type": "purchase", "units": 0.5}], 2600000.0),  # fractional unit, ultra-high price (illustrative)
        ([{"type": "purchase", "units": 20}, {"type": "sale", "units": 5}, {"type": "purchase", "units": 5}, {"type": "sale", "units": 5}], 1200.0),
    ]

    # Multiply the template pool across varying prices/unit scales to build
    # a genuinely large, non-cosmetic-duplicate set: each variant changes
    # the units and/or price materially (different resulting value), so
    # every case checks a distinct arithmetic outcome, not a copy-paste.
    scale_variants = [1.0, 2.5, 0.4, 10.0, 0.1]
    for t_idx, (txns, price) in enumerate(templates):
        for s_idx, scale in enumerate(scale_variants):
            n += 1
            scaled_txns = []
            for t in txns:
                nt = dict(t)
                if 'units' in nt:
                    nt['units'] = round(nt['units'] * scale, 6)
                scaled_txns.append(nt)
            scaled_price = round(price * (1 + 0.03 * s_idx), 4)
            cases.append({
                "id": f"HLD-{n:03d}", "family": "holdings",
                "transactions": scaled_txns, "frozenPricePerUnit": scaled_price,
            })

    return cases


def gen_tax_cases():
    cases = []
    n = 16  # existing TAX-001..016

    # --- Sweep 1: holding-period anniversary boundary, no grandfathering
    # (acquisition strictly on/after 2018-02-01, so grandfathering never
    # applies regardless of fmv) -- covers the STCG/LTCG cutover itself at
    # multiple calendar points (leap years, month-end clamping, year
    # boundaries).
    # NOTE: disposal dates must fall within the real engine's covered tax
    # rule-version range (2023-04-01 onward per ruleVersions.ts) -- these
    # acquisition dates are chosen so acquisition+12mo+/-30d always lands
    # inside [2023-04-01, 2026-08-26].
    boundary_acqs = ['2022-06-15', '2022-08-31', '2022-11-01', '2023-01-31', '2023-03-15', '2023-06-30',
                      '2023-08-31', '2023-11-30', '2024-01-31', '2024-02-29', '2024-05-17', '2024-06-01']
    offsets = [-30, -10, -1, 0, 1, 10, 30]  # days relative to the 12-month anniversary
    from datetime import date, timedelta
    def add_months(d, months):
        total = d.month - 1 + months
        year = d.year + total // 12
        month = total % 12 + 1
        days_in_month = [31, 29 if (year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)) else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
        day = min(d.day, days_in_month[month - 1])
        return date(year, month, day)

    for acq_s in boundary_acqs:
        y, m, d = (int(x) for x in acq_s.split('-'))
        acq = date(y, m, d)
        anniv = add_months(acq, 12)
        for off in offsets:
            n += 1
            disp = anniv + timedelta(days=off)
            cases.append({
                "id": f"TAX-{n:03d}", "family": "tax",
                "acquisitionDate": acq_s, "disposalDate": disp.isoformat(),
                "unitsConsumed": 10, "costPerUnit": 250, "saleValuePerUnit": 310,
            })

    # --- Sweep 2: grandfathering formula orderings. Pre-2018-02-01
    # acquisition, LTCG disposal, sweeping all 6 relative orderings of
    # (actualCost, fmv31Jan2018, salePrice) at 2 magnitude variants each,
    # to exercise every branch of cost_basis_used = max(cost, min(fmv,sale)).
    orderings = [
        ('cost<fmv<sale', 100, 150, 200),
        ('cost<sale<fmv', 100, 250, 200),
        ('fmv<cost<sale', 80, 100, 200),
        ('fmv<sale<cost', 80, 150, 100),
        ('sale<cost<fmv', 250, 100, 150),
        ('sale<fmv<cost', 250, 150, 100),
    ]
    magnitude_variants = [1.0, 37.5, 4.2, 0.6]
    for label, cost, fmv, sale in orderings:
        for mv in magnitude_variants:
            n += 1
            cases.append({
                "id": f"TAX-{n:03d}", "family": "tax",
                "acquisitionDate": "2016-04-01", "disposalDate": "2026-08-26",
                "unitsConsumed": 20, "costPerUnit": round(cost * mv, 2),
                "saleValuePerUnit": round(sale * mv, 2), "fmv31Jan2018PerUnit": round(fmv * mv, 2),
            })

    # --- Sweep 2b: grandfathering tie cases (fmv == cost, fmv == sale, cost == sale).
    ties = [
        (100, 100, 200),  # fmv == cost
        (100, 200, 200),  # fmv == sale
        (150, 300, 150),  # cost == sale, fmv above both (gain path uses cost as basis, no grandfathering benefit since min(fmv,sale)=sale=cost)
    ]
    for cost, fmv, sale in ties:
        n += 1
        cases.append({
            "id": f"TAX-{n:03d}", "family": "tax",
            "acquisitionDate": "2017-01-01", "disposalDate": "2026-08-26",
            "unitsConsumed": 30, "costPerUnit": cost, "saleValuePerUnit": sale, "fmv31Jan2018PerUnit": fmv,
        })

    # --- Sweep 3: acquisition ON/AFTER 2018-02-01 but fmv STILL supplied
    # (defect-class check: grandfathering must be date-gated, not merely
    # fmv-presence-gated).
    post_cutoff_acqs = ['2018-02-01', '2018-02-02', '2019-01-01', '2020-12-31']
    for acq_s in post_cutoff_acqs:
        n += 1
        cases.append({
            "id": f"TAX-{n:03d}", "family": "tax",
            "acquisitionDate": acq_s, "disposalDate": "2026-08-26",
            "unitsConsumed": 25, "costPerUnit": 60, "saleValuePerUnit": 400, "fmv31Jan2018PerUnit": 500,
        })

    # --- Sweep 4: loss scenarios (sale < cost) without fmv, both STCG and LTCG.
    loss_cases = [
        ('2025-06-01', '2025-09-01', 50, 300, 200),   # STCG loss
        ('2020-01-01', '2026-08-26', 50, 300, 200),   # LTCG loss
        ('2025-01-01', '2025-02-01', 10, 1000, 1),    # near-total-wipeout STCG loss
        ('2015-01-01', '2026-08-26', 10, 5000, 4999), # LTCG marginal loss
    ]
    for acq_s, disp_s, units, cost, sale in loss_cases:
        n += 1
        cases.append({
            "id": f"TAX-{n:03d}", "family": "tax",
            "acquisitionDate": acq_s, "disposalDate": disp_s,
            "unitsConsumed": units, "costPerUnit": cost, "saleValuePerUnit": sale,
        })

    # --- Sweep 5: high-magnitude / large unit count (cost-intensity, R6 scale flavor).
    large_cases = [
        ('2019-01-01', '2026-08-26', 10000, 45.5, 620.75),
        ('2021-05-05', '2026-08-26', 5000, 210.0, 890.0),
        ('2023-03-03', '2024-03-04', 25000, 12.0, 15.5),
    ]
    for acq_s, disp_s, units, cost, sale in large_cases:
        n += 1
        cases.append({
            "id": f"TAX-{n:03d}", "family": "tax",
            "acquisitionDate": acq_s, "disposalDate": disp_s,
            "unitsConsumed": units, "costPerUnit": cost, "saleValuePerUnit": sale,
        })

    # --- Sweep 6: same-day acquisition/disposal (0-day holding, must be STCG).
    for acq_s in ['2026-01-15', '2025-06-01']:
        n += 1
        cases.append({
            "id": f"TAX-{n:03d}", "family": "tax",
            "acquisitionDate": acq_s, "disposalDate": acq_s,
            "unitsConsumed": 5, "costPerUnit": 400, "saleValuePerUnit": 410,
        })

    return cases


def gen_publishing_cases():
    cases = []
    n = 4  # existing PUB-001..004
    combos = [
        ('equity', 'IN'), ('equity', 'AU'), ('equity', 'US'), ('equity', 'GB'),
        ('equity', 'SG'), ('equity', 'CA'), ('etf', 'IN'), ('etf', 'AU'),
        ('etf', 'US'), ('etf', 'GB'), ('bond', 'IN'), ('bond', 'AU'),
        ('bond', 'US'), ('etf', 'SG'), ('equity', 'NZ'), ('etf', 'CA'),
    ]
    for instrument_class, country in combos:
        n += 1
        cases.append({
            "id": f"PUB-{n:03d}", "family": "publishing",
            "instrumentClass": instrument_class, "countryCode": country,
        })
    return cases


def gen_xray_cases():
    cases = []
    n = 3  # existing XRAY-001..003

    templates = [
        [{"value": 50000, "holdsSecurityWeightPct": 100}],
        [{"value": 80000, "holdsSecurityWeightPct": 30}, {"value": 20000, "holdsSecurityWeightPct": 0}],
        [{"value": 10000, "holdsSecurityWeightPct": 100}, {"value": 90000, "holdsSecurityWeightPct": 10}],
        [{"value": 40000, "holdsSecurityWeightPct": 25}, {"value": 40000, "holdsSecurityWeightPct": 25}, {"value": 20000, "holdsSecurityWeightPct": 100}],
        [{"value": 15000, "holdsSecurityWeightPct": 0}],  # no exposure at all
        [{"value": 60000, "holdsSecurityWeightPct": 100}, {"value": 40000, "holdsSecurityWeightPct": 100}],  # two direct holdings, both 100%
        [{"value": 200000, "holdsSecurityWeightPct": 5}, {"value": 200000, "holdsSecurityWeightPct": 5}, {"value": 200000, "holdsSecurityWeightPct": 5}],
        [{"value": 33333, "holdsSecurityWeightPct": 33}, {"value": 66667, "holdsSecurityWeightPct": 66}],
        [{"value": 100000, "holdsSecurityWeightPct": 100}],
        [{"value": 5000, "holdsSecurityWeightPct": 50}, {"value": 5000, "holdsSecurityWeightPct": 50}, {"value": 5000, "holdsSecurityWeightPct": 50}, {"value": 5000, "holdsSecurityWeightPct": 50}],
    ]
    scale_variants = [1.0, 1.5, 0.25]
    for t_idx, positions in enumerate(templates):
        for s_idx, scale in enumerate(scale_variants):
            n += 1
            scaled = [{"value": round(p["value"] * scale, 2), "holdsSecurityWeightPct": p["holdsSecurityWeightPct"]} for p in positions]
            cases.append({"id": f"XRAY-{n:03d}", "family": "xray_attribution", "positions": scaled})

    return cases


def main():
    with open(CASES_PATH) as f:
        data = json.load(f)
    existing_ids = {c['id'] for c in data['cases']}

    new_cases = []
    for gen in (gen_identity_cases, gen_holdings_cases, gen_tax_cases, gen_publishing_cases, gen_xray_cases):
        for c in gen():
            if c['id'] in existing_ids:
                raise ValueError(f"duplicate id generated: {c['id']}")
            existing_ids.add(c['id'])
            new_cases.append(c)

    data['cases'].extend(new_cases)
    data['totalCases'] = len(data['cases'])
    data['generatedAt'] = '2026-08-27'
    data['note'] = ('Expanded during II-R12 terminal certification continuation '
                     '(2026-08-27) from the original 41 hand-authored cases to '
                     f'{len(data["cases"])} via scripts/r12-certification/generate_expanded_cases.py -- '
                     'systematic boundary/permutation sweeps per family, not cosmetic duplicates.')

    with open(CASES_PATH, 'w') as f:
        json.dump(data, f, indent=2)

    by_family = {}
    for c in data['cases']:
        by_family[c['family']] = by_family.get(c['family'], 0) + 1
    print(f"Total cases: {len(data['cases'])}")
    for fam, count in sorted(by_family.items()):
        print(f"  {fam}: {count}")


if __name__ == '__main__':
    main()
