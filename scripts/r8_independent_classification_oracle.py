#!/usr/bin/env python3
"""
R8 -- Transaction Categorisation & Merchant Intelligence: INDEPENDENT
certification oracle (spec section 70).

This script imports NOTHING from the production TypeScript engine
(lib/financial-data-hub/classification/**) and does not read the production
rule/reference-data JSON files either -- it is a from-scratch
re-implementation, in a different language, of:

  1. economic-type classification via a small, independently-authored set of
     narrative-pattern rules (salary/payroll income, bank fee, interest,
     cash withdrawal, refund) plus a tiny independently-authored merchant
     table -- deliberately NOT the same 60-row FDH-2 seed;
  2. internal-transfer/settlement pairing (same amount, opposite direction,
     different account, date window -- never amount alone);
  3. refund/reversal linking (same account, opposite direction, amount <=
     original, later date);
  4. recurring-series detection (consecutive-gap clustering into one of a
     small set of frequency buckets).

Given a case file (JSON), it computes an INDEPENDENT expectation for each
case. `scripts/r8_oracle_compare.mjs` then runs the SAME cases through the
real production engine and diffs the two outputs field-by-field.

Money/dates use only the Python standard library (decimal, datetime) --
never a float for money.
"""

import argparse
import datetime
import json
import sys
from decimal import Decimal


# -----------------------------------------------------------------------
# 1. Economic-type classification (independently authored, not FDH-2's set)
# -----------------------------------------------------------------------

NARRATIVE_RULES = [
    # (required_terms, excluded_terms, economic_type)
    (["SALARY"], ["SALARY SACRIFICE", "SALARY PACKAGING"], "income"),
    (["PAYROLL"], [], "income"),
    (["WAGES"], [], "income"),
    # Direction-aware interest: a rule matches TEXT only (no rule ever
    # inspects credit_debit directly -- confirmed against the real engine's
    # match_definition shape, which carries no direction field), so
    # "direction-aware" means two DISTINCT narrative patterns, exactly
    # mirroring how the real FDH-2 seed rules are actually authored.
    (["INTEREST CREDITED"], [], "income"),
    (["INTEREST CHARGED"], [], "debt_interest"),
    (["ACCOUNT FEE"], ["FEE WAIVED", "FEE REFUND", "FEE REVERSED"], "fee"),
    (["MONTHLY FEE"], ["FEE WAIVED"], "fee"),
    (["ATM WITHDRAWAL"], [], "cash_withdrawal"),
    (["CASH WITHDRAWAL"], [], "cash_withdrawal"),
    (["REFUND"], [], "refund"),
    (["REVERSAL"], [], "refund"),
    (["CHARGEBACK"], [], "refund"),
]

MERCHANT_TABLE = {
    # canonical_name (uppercase) -> (economic_type, category_key)
    "WOOLWORTHS": ("expense", "groceries"),
    "COLES": ("expense", "groceries"),
    "NETFLIX": ("expense", "entertainment_subscriptions"),
    "SPOTIFY": ("expense", "entertainment_subscriptions"),
}


def normalise(text):
    return (text or "").upper().strip()


def classify_economic_type(description, credit_debit):
    d = normalise(description)

    for merchant_name, (etype, category) in MERCHANT_TABLE.items():
        if merchant_name in d:
            return {"economic_type": etype, "category_key": category, "source": "merchant"}

    for required, excluded, etype in NARRATIVE_RULES:
        if all(t in d for t in required) and not any(t in d for t in excluded):
            return {"economic_type": etype, "category_key": None, "source": "narrative_pattern"}

    return {"economic_type": "unknown", "category_key": None, "source": "unresolved"}


# -----------------------------------------------------------------------
# 2. Transfer / settlement pairing
# -----------------------------------------------------------------------

def match_transfers(transactions, date_window_days=3):
    """transactions: list of dicts with id, financial_account_id,
    transaction_date (ISO), amount_original (str), currency_original,
    credit_debit. Returns list of {from, to, days}."""
    buckets = {}
    for t in transactions:
        key = (t["amount_original"], t["currency_original"])
        buckets.setdefault(key, []).append(t)

    results = []
    claimed = set()
    for bucket in buckets.values():
        pairs = []
        for i in range(len(bucket)):
            for j in range(i + 1, len(bucket)):
                a, b = bucket[i], bucket[j]
                if a["financial_account_id"] == b["financial_account_id"]:
                    continue
                if a["credit_debit"] == b["credit_debit"]:
                    continue
                da = datetime.date.fromisoformat(a["transaction_date"])
                db_ = datetime.date.fromisoformat(b["transaction_date"])
                days = abs((db_ - da).days)
                if days > date_window_days:
                    continue
                pairs.append((days, a, b))
        pairs.sort(key=lambda p: p[0])
        for days, a, b in pairs:
            if a["id"] in claimed or b["id"] in claimed:
                continue
            claimed.add(a["id"])
            claimed.add(b["id"])
            frm, to = (a, b) if a["credit_debit"] == "debit" else (b, a)
            results.append({"from": frm["id"], "to": to["id"], "days": days})
    return results


# -----------------------------------------------------------------------
# 3. Refund/reversal linking
# -----------------------------------------------------------------------

def match_refunds(transactions, is_refund_ids, lookback_days=90):
    by_account = {}
    for t in transactions:
        by_account.setdefault(t["financial_account_id"], []).append(t)

    results = []
    claimed = set()
    for refund in transactions:
        if refund["id"] not in is_refund_ids:
            continue
        best = None
        for cand in by_account.get(refund["financial_account_id"], []):
            if cand["id"] == refund["id"] or cand["id"] in claimed:
                continue
            if cand["credit_debit"] == refund["credit_debit"]:
                continue
            if cand["currency_original"] != refund["currency_original"]:
                continue
            if Decimal(cand["amount_original"]) < Decimal(refund["amount_original"]):
                continue
            d_refund = datetime.date.fromisoformat(refund["transaction_date"])
            d_cand = datetime.date.fromisoformat(cand["transaction_date"])
            days = (d_refund - d_cand).days
            if days < 0 or days > lookback_days:
                continue
            if best is None or days < best[1]:
                best = (cand, days)
        if best:
            claimed.add(best[0]["id"])
            results.append({"refund": refund["id"], "original": best[0]["id"]})
    return results


# -----------------------------------------------------------------------
# 4. Recurring-series detection
# -----------------------------------------------------------------------

FREQUENCY_BUCKETS = [
    ("weekly", 7, 2),
    ("fortnightly", 14, 3),
    ("monthly", 30, 5),
    ("quarterly", 91, 10),
    ("annual", 365, 15),
]


def bucket_for_delta(days):
    for name, nominal, tolerance in FREQUENCY_BUCKETS:
        if abs(days - nominal) <= tolerance:
            return name
    return None


def detect_recurring(transactions):
    """transactions: dicts with id, merchant_id, transaction_date,
    financial_account_id, credit_debit. Groups by (account, merchant,
    direction)."""
    groups = {}
    for t in transactions:
        key = (t["financial_account_id"], t.get("merchant_id"), t["credit_debit"])
        groups.setdefault(key, []).append(t)

    series = []
    for key, group in groups.items():
        if len(group) < 2:
            continue
        group_sorted = sorted(group, key=lambda t: t["transaction_date"])
        deltas = []
        for i in range(1, len(group_sorted)):
            d1 = datetime.date.fromisoformat(group_sorted[i - 1]["transaction_date"])
            d2 = datetime.date.fromisoformat(group_sorted[i]["transaction_date"])
            deltas.append((d2 - d1).days)
        first_bucket = bucket_for_delta(deltas[0])
        if first_bucket is None:
            continue
        if not all(bucket_for_delta(d) == first_bucket for d in deltas):
            continue
        series.append({
            "frequency": first_bucket,
            "members": [t["id"] for t in group_sorted],
            "insufficient_history": len(group_sorted) < 3,
        })
    return series


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("case_file", help="JSON file with {economic_type_cases, transfer_cases, refund_cases, recurring_cases}")
    parser.add_argument("-o", "--output", default=None)
    args = parser.parse_args()

    with open(args.case_file, "r", encoding="utf-8") as f:
        data = json.load(f)

    result = {"economic_type": [], "transfers": [], "refunds": [], "recurring": []}

    for case in data.get("economic_type_cases", []):
        r = classify_economic_type(case["description"], case["credit_debit"])
        result["economic_type"].append({"id": case["id"], **r})

    for case in data.get("transfer_cases", []):
        pairs = match_transfers(case["transactions"], case.get("date_window_days", 3))
        result["transfers"].append({"id": case["id"], "pairs": pairs})

    for case in data.get("refund_cases", []):
        links = match_refunds(case["transactions"], set(case["is_refund_ids"]), case.get("lookback_days", 90))
        result["refunds"].append({"id": case["id"], "links": links})

    for case in data.get("recurring_cases", []):
        series = detect_recurring(case["transactions"])
        result["recurring"].append({"id": case["id"], "series": series})

    output_json = json.dumps(result, indent=2)
    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(output_json)
    else:
        print(output_json)


if __name__ == "__main__":
    sys.exit(main())
