#!/usr/bin/env python3
"""
Investment Intelligence R12 -- Independent Multi-Asset Oracle.

Deliberately does NOT import any production TypeScript code (impossible
across languages anyway, but more importantly: the LOGIC below is a fresh,
independent re-derivation from the underlying Indian tax rule and from
R12's own frozen scope decisions, not a port of
lib/engines/investment-intelligence/tax/*.ts). It independently computes,
for each deterministic case:

  - instrument identity (does a set of (scheme, value) identifiers collapse
    to ONE economic instrument, keyed by ISIN when present)
  - transaction interpretation (unit delta per transaction type)
  - expected quantity after a transaction sequence
  - expected market value from a frozen price (units * price)
  - expected economic position count (post-dedup)
  - holding period classification (calendar-month-anniversary rule,
    Section 2(42A)) and STCG/LTCG under Section 111A/112A for a direct
    listed equity / equity-oriented ETF (12-month threshold, no
    indexation, LTCG in excess of Rs 1,00,000 aggregate taxed at rate --
    the oracle checks GAIN TYPE and TAXABLE GAIN AMOUNT, not the final tax
    payable, matching the production engine's own scope)
  - asset-class allocation / net-worth contribution (one contribution per
    economic position, never per source)

Output: r12_oracle_results.json, consumed by
tests/unit/iiR12IndependentOracle.test.ts, which runs the SAME case list
through the REAL production engine and diffs against this file.
"""
import json
import os
from datetime import date, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))


def parse_date(s):
    y, m, d = (int(x) for x in s.split('-'))
    return date(y, m, d)


def add_months(d, months):
    total = d.month - 1 + months
    year = d.year + total // 12
    month = total % 12 + 1
    # Clamp day to the target month's real length (independent, no libs).
    days_in_month = [31, 29 if (year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)) else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    day = min(d.day, days_in_month[month - 1])
    return date(year, month, day)


def holding_period(acq, disp, threshold_months=12):
    """Section 2(42A) anniversary rule: long-term iff disposal is STRICTLY
    AFTER the (acquisition + threshold_months) anniversary date."""
    a = parse_date(acq)
    dd = parse_date(disp)
    anniversary = add_months(a, threshold_months)
    is_long_term = dd > anniversary
    holding_days = (dd - a).days
    return {'holdingDays': holding_days, 'anniversaryDate': anniversary.isoformat(), 'isLongTerm': is_long_term}


def resolve_instrument_identity(instruments):
    """Given a list of instrument records each with a list of
    (scheme, value) identifiers, collapse to canonical instrument groups
    keyed by ISIN when present (globally unique), else by
    (scheme, value, country) for country-scoped schemes. Returns the
    number of DISTINCT economic instruments."""
    # Union-find over instrument indices, unioned whenever they share ANY
    # identifier under the correct uniqueness scope.
    parent = list(range(len(instruments)))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    GLOBAL_SCHEMES = {'isin', 'sedol'}
    key_to_idx = {}
    for i, instr in enumerate(instruments):
        for ident in instr['identifiers']:
            scheme, value, country = ident['scheme'], ident['value'], ident.get('countryCode')
            key = (scheme, value) if scheme in GLOBAL_SCHEMES else (scheme, value, country)
            if key in key_to_idx:
                union(i, key_to_idx[key])
            else:
                key_to_idx[key] = i
    groups = set(find(i) for i in range(len(instruments)))
    return len(groups)


def replay_position(transactions):
    """Independent transaction replay: purchase/sale/dividend/bonus.
    Returns (units, cash_flows) where cash_flows is a list of signed
    amounts for an XIRR-style check (not computed here -- R4 remains
    authoritative for XIRR; the oracle only checks unit/value arithmetic)."""
    units = 0.0
    for t in transactions:
        ttype = t['type']
        if ttype == 'purchase':
            units += t['units']
        elif ttype == 'sale':
            units -= t['units']
        elif ttype == 'bonus':
            units += t['units']
        elif ttype == 'dividend':
            pass  # no unit impact
        else:
            raise ValueError(f'unhandled transaction type in oracle: {ttype}')
    return units


def compute_case(case):
    result = {'id': case['id'], 'family': case['family']}

    if case['family'] == 'instrument_identity':
        result['distinctInstrumentCount'] = resolve_instrument_identity(case['instruments'])

    elif case['family'] == 'holdings':
        units_after = replay_position(case['transactions'])
        result['unitsAfter'] = round(units_after, 6)
        result['valueAfter'] = round(units_after * case['frozenPricePerUnit'], 2)

    elif case['family'] == 'tax':
        hp = holding_period(case['acquisitionDate'], case['disposalDate'], 12)
        gain_type = 'ltcg' if hp['isLongTerm'] else 'stcg'
        sale_value = case['unitsConsumed'] * case['saleValuePerUnit']
        cost_basis = case['unitsConsumed'] * case['costPerUnit']
        # Grandfathering (Section 55(2)(ac) / Section 90(7)-(9) under the
        # 2025 Act): only for LTCG, only when acquired before 1-Feb-2018,
        # only when a real FMV is available. CORRECT three-way formula,
        # independently re-derived from the statute (per-unit, then scaled):
        #   cost_of_acquisition = max( actualCost, min(fmv, salePrice) )
        # NOT min(max(fmv, actualCost), salePrice) -- that superficially
        # similar formula silently erases a genuine pre-existing LOSS
        # (actualCost > salePrice) to zero, because capping the OUTER max
        # at salePrice discards actualCost even when actualCost properly
        # dominates. The oracle deliberately re-derives this independently
        # (not copied from the TS implementation) so a shared bug in both
        # could not hide from certification -- see TAX-016 below for the
        # exact case that distinguishes the two formulas.
        cost_basis_used = cost_basis
        grandfathered = False
        if gain_type == 'ltcg' and case.get('fmv31Jan2018PerUnit') is not None and parse_date(case['acquisitionDate']) < date(2018, 2, 1):
            fmv_per_unit = case['fmv31Jan2018PerUnit']
            cost_per_unit = case['costPerUnit']
            sale_per_unit = case['saleValuePerUnit']
            lower_of_fmv_and_sale = min(fmv_per_unit, sale_per_unit)
            basis_per_unit = max(cost_per_unit, lower_of_fmv_and_sale)
            cost_basis_used = basis_per_unit * case['unitsConsumed']
            grandfathered = basis_per_unit > cost_per_unit
        taxable_gain = round(sale_value - cost_basis_used, 2)
        result.update({
            'gainType': gain_type,
            'holdingDays': hp['holdingDays'],
            'isLongTerm': hp['isLongTerm'],
            'saleValue': round(sale_value, 2),
            'costBasisUsed': round(cost_basis_used, 2),
            'grandfatheringApplied': grandfathered,
            'taxableGain': taxable_gain,
        })

    elif case['family'] == 'publishing':
        # One economic position -> exactly one net-worth contribution,
        # regardless of how many times it might be READ/displayed.
        result['netWorthContributionCount'] = 1
        if case['instrumentClass'] == 'equity':
            # Reuses the already-shipped migration 0073 rule independently:
            # IN -> international_shares, else -> australian_shares.
            result['masterItemKey'] = 'international_shares' if case['countryCode'] == 'IN' else 'australian_shares'
        elif case['instrumentClass'] == 'etf':
            result['masterItemKey'] = 'etfs'  # country-independent
        else:
            result['masterItemKey'] = None  # bond/etc. -- still deferred, no R12 publication target

    elif case['family'] == 'xray_attribution':
        total_value = sum(p['value'] for p in case['positions'])
        # Direct security contributes its own value at 100% weight; a fund
        # holding it at some internal weight contributes value*weight.
        contribution = 0.0
        for p in case['positions']:
            if p.get('holdsSecurityWeightPct') is not None:
                contribution += p['value'] * (p['holdsSecurityWeightPct'] / 100.0)
        effective_weight = round(contribution / total_value, 6) if total_value else 0
        result['totalPortfolioValue'] = round(total_value, 2)
        result['effectiveSecurityWeight'] = effective_weight
        result['effectiveSecurityValue'] = round(contribution, 2)

    else:
        raise ValueError(f'unknown case family: {case["family"]}')

    return result


def main():
    with open(os.path.join(HERE, 'r12_cases.json')) as f:
        data = json.load(f)
    results = [compute_case(c) for c in data['cases']]
    out = {'generatedBy': 'r12_independent_multiasset_oracle.py', 'totalCases': len(results), 'results': results}
    with open(os.path.join(HERE, 'r12_oracle_results.json'), 'w') as f:
        json.dump(out, f, indent=2)
    print(f'{len(results)} oracle results written to r12_oracle_results.json')


if __name__ == '__main__':
    main()
