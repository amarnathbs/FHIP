#!/usr/bin/env python3
"""
R7 -- Bank CSV Engine: INDEPENDENT certification oracle (spec section 65).

This script imports NOTHING from the production TypeScript engine
(lib/financial-data-hub/bank-csv/**). It is a from-scratch re-implementation
of CSV parsing, date parsing, amount canonicalisation and balance
reconciliation, written in a different language against Python's own
standard library only (csv, decimal, datetime, json, argparse, hashlib).

Its job is to compute an INDEPENDENT expectation for a fixture file, given a
declared "profile" (delimiter, header row index, per-column canonical role,
date format, amount convention) equivalent to the same evidence a certified
adapter would supply. `scripts/r7_oracle_compare.ts` then runs the SAME
fixture through the real production pipeline and diffs the two outputs
field-by-field (spec section 66).

Money is handled exclusively with decimal.Decimal -- never a Python float --
so oracle output is never itself a source of rounding error (spec 67).
"""

import argparse
import csv
import datetime
import json
import sys
from decimal import Decimal, InvalidOperation
from pathlib import Path

DATE_FORMATS = {
    "DD/MM/YYYY": "%d/%m/%Y",
    "MM/DD/YYYY": "%m/%d/%Y",
    "YYYY-MM-DD": "%Y-%m-%d",
    "DD-MM-YYYY": "%d-%m-%Y",
    "DD.MM.YYYY": "%d.%m.%Y",
}


def parse_date(raw: str, fmt: str) -> str:
    """Deterministic date parse under an EXPLICIT format -- never guessed."""
    py_fmt = DATE_FORMATS[fmt]
    dt = datetime.datetime.strptime(raw.strip(), py_fmt)
    return dt.date().isoformat()


def parse_amount(raw: str):
    """Returns (Decimal magnitude, is_negative) or (None, None) on failure."""
    s = raw.strip()
    if not s:
        return None, None
    is_negative = False
    if s.startswith("(") and s.endswith(")"):
        is_negative = True
        s = s[1:-1].strip()
    if s.startswith("-"):
        is_negative = True
        s = s[1:].strip()
    elif s.startswith("+"):
        s = s[1:].strip()
    for symbol in ("$", "₹", "€", "£"):
        s = s.replace(symbol, "")
    s = s.replace(",", "").strip()
    try:
        magnitude = Decimal(s)
    except InvalidOperation:
        return None, None
    return magnitude, is_negative


def normalise_description(raw: str) -> str:
    return " ".join(raw.strip().split())


def load_fixture(path: Path, delimiter: str, header_row_index: int):
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = list(csv.reader(f, delimiter=delimiter))
    header = [c.strip() for c in reader[header_row_index]]
    rows = [[c.strip() for c in r] for r in reader[header_row_index + 1:] if any(c.strip() for c in r)]
    return header, rows


def col(header, row, name):
    if name is None:
        return None
    try:
        idx = header.index(name)
    except ValueError:
        return None
    return row[idx] if idx < len(row) else ""


def normalise_rows(header, rows, profile):
    amount_convention = profile["amount_convention"]
    date_format = profile["date_format"]
    roles = profile["column_roles"]

    accepted = []
    rejected = []

    for i, row in enumerate(rows, start=1):
        date_raw = col(header, row, roles["transaction_date"])
        if not date_raw or not date_raw.strip():
            rejected.append({"row": i, "reason": "missing_transaction_date"})
            continue
        try:
            iso_date = parse_date(date_raw, date_format)
        except ValueError:
            rejected.append({"row": i, "reason": "invalid_transaction_date"})
            continue

        description_raw = col(header, row, roles.get("description")) or ""
        description_clean = normalise_description(description_raw)
        reference_raw = col(header, row, roles.get("reference"))

        magnitude = None
        direction = None

        if amount_convention == "single_signed":
            amt_raw = col(header, row, roles["amount"])
            magnitude, is_negative = parse_amount(amt_raw or "")
            if magnitude is None:
                rejected.append({"row": i, "reason": "invalid_amount"})
                continue
            if magnitude == 0:
                rejected.append({"row": i, "reason": "zero_amount"})
                continue
            direction = "debit" if is_negative else "credit"
        elif amount_convention == "debit_credit_columns":
            debit_raw = col(header, row, roles.get("debit"))
            credit_raw = col(header, row, roles.get("credit"))
            debit_mag, _ = parse_amount(debit_raw or "")
            credit_mag, _ = parse_amount(credit_raw or "")
            has_debit = debit_mag is not None and debit_mag > 0
            has_credit = credit_mag is not None and credit_mag > 0
            if has_debit and has_credit:
                rejected.append({"row": i, "reason": "ambiguous_direction"})
                continue
            if not has_debit and not has_credit:
                rejected.append({"row": i, "reason": "zero_or_missing_amount"})
                continue
            magnitude = debit_mag if has_debit else credit_mag
            direction = "debit" if has_debit else "credit"
        elif amount_convention == "dr_cr_indicator":
            amt_raw = col(header, row, roles["amount"])
            indicator_raw = (col(header, row, roles["dr_cr_indicator"]) or "").strip().upper()
            magnitude, _ = parse_amount(amt_raw or "")
            if magnitude is None or magnitude == 0:
                rejected.append({"row": i, "reason": "invalid_or_zero_amount"})
                continue
            if indicator_raw in ("DR", "D", "DEBIT"):
                direction = "debit"
            elif indicator_raw in ("CR", "C", "CREDIT"):
                direction = "credit"
            else:
                rejected.append({"row": i, "reason": "ambiguous_direction"})
                continue
        else:
            raise ValueError(f"unknown amount_convention {amount_convention}")

        balance_raw = col(header, row, roles.get("balance"))
        balance_after = None
        if balance_raw and balance_raw.strip():
            bal_mag, bal_neg = parse_amount(balance_raw)
            if bal_mag is not None:
                balance_after = -bal_mag if bal_neg else bal_mag

        accepted.append(
            {
                "row": i,
                "date": iso_date,
                "description_raw": description_raw,
                "description_clean": description_clean,
                "reference": reference_raw.strip() if reference_raw else None,
                "amount": str(magnitude.quantize(Decimal("0.0001"))),
                "direction": direction,
                "balance_after": str(balance_after.quantize(Decimal("0.0001"))) if balance_after is not None else None,
            }
        )

    return accepted, rejected


def reconcile(accepted):
    with_balance = [t for t in accepted if t["balance_after"] is not None]
    credits = sum((Decimal(t["amount"]) for t in accepted if t["direction"] == "credit"), Decimal("0"))
    debits = sum((Decimal(t["amount"]) for t in accepted if t["direction"] == "debit"), Decimal("0"))

    if not with_balance:
        return {
            "status": "not_available",
            "extracted_credits": str(credits),
            "extracted_debits": str(debits),
            "opening_balance": None,
            "expected_closing_balance": None,
            "reported_closing_balance": None,
            "variance": None,
        }

    first = with_balance[0]
    first_signed = Decimal(first["amount"]) if first["direction"] == "credit" else -Decimal(first["amount"])
    opening = Decimal(first["balance_after"]) - first_signed

    # Row-level continuity check, in source row order.
    prev_balance = None
    broke = False
    for t in accepted:
        if t["balance_after"] is None:
            prev_balance = None
            continue
        if prev_balance is not None:
            signed = Decimal(t["amount"]) if t["direction"] == "credit" else -Decimal(t["amount"])
            expected = prev_balance + signed
            if expected != Decimal(t["balance_after"]):
                broke = True
        prev_balance = Decimal(t["balance_after"])

    reported_closing = Decimal(with_balance[-1]["balance_after"])
    expected_closing = opening + credits - debits
    variance = expected_closing - reported_closing

    partial = len(with_balance) < len(accepted)
    if partial:
        status = "pending"
    elif broke or variance != 0:
        status = "failed"
    else:
        status = "reconciled"

    return {
        "status": status,
        "extracted_credits": str(credits),
        "extracted_debits": str(debits),
        "opening_balance": str(opening),
        "expected_closing_balance": str(expected_closing),
        "reported_closing_balance": str(reported_closing),
        "variance": str(variance),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("fixture", type=Path)
    parser.add_argument("profile", type=Path)
    args = parser.parse_args()

    profile = json.loads(args.profile.read_text(encoding="utf-8"))
    header, rows = load_fixture(args.fixture, profile.get("delimiter", ","), profile.get("header_row_index", 0))
    accepted, rejected = normalise_rows(header, rows, profile)
    reconciliation = reconcile(accepted)

    result = {
        "fixture": args.fixture.name,
        "declared_row_count": len(rows),
        "parsed_row_count": len(accepted),
        "rejected_row_count": len(rejected),
        "accepted": accepted,
        "rejected": rejected,
        "reconciliation": reconciliation,
    }
    json.dump(result, sys.stdout, indent=2)
    print()


if __name__ == "__main__":
    main()
