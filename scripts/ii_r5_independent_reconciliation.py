#!/usr/bin/env python3
"""
Investment Intelligence R5 — INDEPENDENT certification oracle.

=============================================================================
INDEPENDENCE STATEMENT (spec section 81)
=============================================================================
This file imports NOTHING from the FHIP production codebase. It does not
import, subprocess, transpile, or otherwise execute:
    lib/engines/investment-intelligence/sip/*
    lib/engines/investment-intelligence/xray/*
    lib/engines/investment-intelligence/xirr.ts
    lib/config/investment-intelligence/*
Its only input is scripts/ii-r5-certification/cases.json, which is raw case
DATA produced by a generator that itself imports no production code.

Every formula below is re-derived here from the documented R5 methodology.
In particular the XIRR solver is a PURE HIGH-PRECISION BISECTION with no
Newton step, whereas production uses a safeguarded Newton-Raphson bracketed
by bisection. The two implementations are numerically independent rather than
the same algorithm copy-pasted into two languages — a production Newton bug
would not be reproduced here.

Run:  python scripts/ii_r5_independent_reconciliation.py
Writes: scripts/ii-r5-certification/oracle_results.json
"""

import json
import math
import os
from datetime import date, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
CERT_DIR = os.path.join(HERE, "ii-r5-certification")

# ---------------------------------------------------------------------------
# Independent constants — transcribed from the documented R5 methodology,
# not imported from the TypeScript config modules.
# ---------------------------------------------------------------------------
MAX_FORWARD_SEARCH_DAYS = 10
MAX_BACKWARD_SEARCH_DAYS = 10
MIN_CONTRIBUTIONS_FOR_INFERENCE = 3
MIN_INTERVAL_CONSISTENCY_FOR_CADENCE = 0.7
AMOUNT_SIMILARITY_TOLERANCE = 0.05
GAP_MIN_MISSED_PERIODS = 1.5

CADENCE_BANDS = {
    "MONTHLY": (24, 38, 30.4375, 12),
    "QUARTERLY": (80, 105, 91.3125, 4),
    "WEEKLY": (5, 9, 7.0, 52),
    "FORTNIGHTLY": (12, 17, 14.0, 26),
    "ANNUAL": (350, 380, 365.25, 1),
}
# Iteration order must match production's Object.keys order for deterministic
# tie-breaking when two bands score identically.
CADENCE_ORDER = ["MONTHLY", "QUARTERLY", "WEEKLY", "FORTNIGHTLY", "ANNUAL"]

PAUSE_EXPECTED_MAX = 0.5
PAUSE_LATE_MAX = 1.5  # see sipThresholds.ts rationale: month-length drift
PAUSE_POSSIBLE_MAX = 3.0

FRESH_CURRENT_MAX = 45
FRESH_ACCEPTABLE_MAX = 100
FRESH_STALE_MAX = 210
COVERAGE_MIN_FOR_CONCLUSION = 0.5
COVERAGE_EFFECTIVELY_COMPLETE = 0.98
MIXED_DATE_WARN = 45
MIXED_DATE_SUPPRESS = 185
WEIGHT_SUM_ROUNDING_TOLERANCE_PCT = 0.5

CREDIT_BANDS = ["SOVEREIGN", "AAA", "AA", "A", "BELOW_A", "UNRATED", "OTHER_UNCLASSIFIED"]
MATURITY_BUCKETS = [
    ("LT_1Y", 0, 1),
    ("Y1_3", 1, 3),
    ("Y3_5", 3, 5),
    ("Y5_10", 5, 10),
    ("GT_10Y", 10, float("inf")),
]

ACQUISITION_TYPES = {"purchase", "sip", "switch_in", "reinvestment", "merger"}
DISPOSAL_TYPES = {"redemption", "switch_out", "transfer"}
SERIES_MEMBER_TYPES = {"purchase", "sip"}
UNIT_EPSILON = 1e-9


def d(iso):
    y, m, dd = iso.split("-")
    return date(int(y), int(m), int(dd))


def days_between(a, b):
    return (d(b) - d(a)).days


# ---------------------------------------------------------------------------
# XIRR — PURE BISECTION (deliberately a different algorithm from production)
# ---------------------------------------------------------------------------
def npv(flows, r):
    """flows: list of (iso_date, amount). Uses ACT/365 from the earliest date."""
    if r <= -0.999999:
        return float("nan")
    d0 = d(min(f[0] for f in flows))
    total = 0.0
    for iso, amt in flows:
        years = (d(iso) - d0).days / 365.0
        total += amt / ((1.0 + r) ** years)
    return total


def xirr_bisection(flows):
    """Returns (status, rate_or_reason). Pure bisection, no derivative used."""
    if not flows or len(flows) < 2:
        return ("unavailable", "INSUFFICIENT_HISTORY")
    if not any(a > 0 for _, a in flows) or not any(a < 0 for _, a in flows):
        return ("unavailable", "ALL_SAME_SIGN")

    # Dense scan for sign changes across the same valid domain production uses.
    grid = []
    for r in [-0.999999, -0.9999, -0.999, -0.995, -0.99, -0.98, -0.95, -0.9]:
        grid.append(r)
    r = -0.8
    while r < 3:
        grid.append(round(r, 6))
        r += 0.02
    r = 3.0
    while r <= 10:
        grid.append(r)
        r += 0.25
    r = 10.0
    while r <= 100:
        grid.append(r)
        r += 5

    brackets = []
    prev_r = grid[0]
    prev_f = npv(flows, prev_r)
    for gr in grid[1:]:
        f = npv(flows, gr)
        if not math.isnan(prev_f) and not math.isnan(f):
            if prev_f == 0:
                brackets.append((prev_r, prev_r))
            elif (prev_f < 0 < f) or (f < 0 < prev_f):
                brackets.append((prev_r, gr))
        prev_r, prev_f = gr, f

    if not brackets:
        return ("unavailable", "NOT_BRACKETED")

    roots = []
    for lo, hi in brackets:
        if lo == hi:
            roots.append(lo)
            continue
        a, b = lo, hi
        fa = npv(flows, a)
        # 200 halvings drives the bracket width below 1e-15 of its start.
        for _ in range(200):
            mid = (a + b) / 2.0
            fm = npv(flows, mid)
            if abs(b - a) < 1e-12:
                break
            if (fa < 0 and fm < 0) or (fa > 0 and fm > 0):
                a, fa = mid, fm
            else:
                b = mid
        root = (a + b) / 2.0
        if not any(abs(root - x) < 1e-6 for x in roots):
            roots.append(root)

    if len(roots) > 1:
        return ("unavailable", "MULTIPLE_ROOTS_AMBIGUOUS")
    return ("ok", roots[0])


# ---------------------------------------------------------------------------
# Date alignment — the single documented R5 rule, re-implemented
# ---------------------------------------------------------------------------
def obs_on_or_after(series, iso):
    for o in series:
        delta = days_between(iso, o["date"])
        if delta < 0:
            continue
        if delta > MAX_FORWARD_SEARCH_DAYS:
            return None
        return o
    return None


def obs_as_of(series, iso):
    for o in reversed(series):
        delta = days_between(o["date"], iso)
        if delta < 0:
            continue
        if delta > MAX_BACKWARD_SEARCH_DAYS:
            return None
        return o
    return None


def sorted_series(series):
    return sorted(series, key=lambda o: o["date"])


# ---------------------------------------------------------------------------
# SIP detection
# ---------------------------------------------------------------------------
def median(vals):
    if not vals:
        return 0.0
    s = sorted(vals)
    n = len(s)
    return (s[n // 2 - 1] + s[n // 2]) / 2.0 if n % 2 == 0 else s[n // 2]


def is_source_confirmed(t):
    if t.get("transactionType") == "sip":
        return True
    desc = (t.get("sourceDescription") or "").upper()
    import re
    return bool(re.search(r"\bSIP\b", desc)) or bool(re.search(r"SYSTEMATIC\s+INVESTMENT", desc))


def classify_cadence(intervals):
    if not intervals:
        return ("UNKNOWN", None)
    best_key, best_hits = None, -1
    for key in CADENCE_ORDER:
        lo, hi, _nom, ppy = CADENCE_BANDS[key]
        hits = sum(1 for x in intervals if lo <= x <= hi)
        if hits > best_hits:
            best_key, best_hits = key, hits
    if best_hits / len(intervals) >= MIN_INTERVAL_CONSISTENCY_FOR_CADENCE:
        return (best_key, CADENCE_BANDS[best_key][3])
    mean = sum(intervals) / len(intervals)
    if mean <= 0:
        return ("IRREGULAR", None)
    var = sum((x - mean) ** 2 for x in intervals) / len(intervals)
    cv = math.sqrt(var) / mean
    return ("OTHER_RECURRING", None) if cv <= 0.35 else ("IRREGULAR", None)


def classify_trend(amounts):
    if len(amounts) < 2:
        return "FLAT"
    med = median(amounts)
    if med > 0 and all(abs(a - med) / med <= AMOUNT_SIMILARITY_TOLERANCE for a in amounts):
        return "FLAT"
    up = down = 0
    for i in range(1, len(amounts)):
        ref = amounts[i - 1]
        if ref <= 0:
            continue
        rel = (amounts[i] - ref) / ref
        if rel > AMOUNT_SIMILARITY_TOLERANCE:
            up += 1
        elif rel < -AMOUNT_SIMILARITY_TOLERANCE:
            down += 1
    if up > 0 and down == 0:
        return "INCREASING"
    if down > 0 and up == 0:
        return "DECREASING"
    if up == 0 and down == 0:
        return "FLAT"
    return "MIXED"


def merge_step_up_clusters(clusters):
    if len(clusters) < 2:
        return clusters
    allt = sorted([t for c in clusters for t in c], key=lambda t: t["transactionDate"])
    intervals = [days_between(allt[i - 1]["transactionDate"], allt[i]["transactionDate"]) for i in range(1, len(allt))]
    cadence, _ = classify_cadence(intervals)
    periodic = cadence not in ("IRREGULAR", "UNKNOWN")
    trend = classify_trend([t["grossAmount"] for t in allt])
    if periodic and trend in ("INCREASING", "DECREASING"):
        return [allt]
    return clusters


def partition_mandates(txns):
    confirmed = [t for t in txns if is_source_confirmed(t)]
    others = [t for t in txns if not is_source_confirmed(t)]
    groups = []
    if confirmed:
        clusters = []
        for t in sorted(confirmed, key=lambda x: x["grossAmount"]):
            placed = False
            for c in clusters:
                m = median([x["grossAmount"] for x in c])
                if m > 0 and abs(t["grossAmount"] - m) / m <= AMOUNT_SIMILARITY_TOLERANCE:
                    c.append(t)
                    placed = True
                    break
            if not placed:
                clusters.append([t])
        for c in merge_step_up_clusters(clusters):
            s = sorted(c, key=lambda x: x["transactionDate"])
            disc = "sip-%d" % round(median([x["grossAmount"] for x in s]))
            groups.append((disc, s))
    if others:
        groups.append(("inferred", sorted(others, key=lambda x: x["transactionDate"])))
    return groups


def assess_series(members):
    s = sorted(members, key=lambda t: t["transactionDate"])
    intervals = [days_between(s[i - 1]["transactionDate"], s[i]["transactionDate"]) for i in range(1, len(s))]
    cadence, ppy = classify_cadence(intervals)
    amounts = [t["grossAmount"] for t in s]
    trend = classify_trend(amounts)
    confirmed = any(is_source_confirmed(t) for t in s)

    if confirmed:
        confidence = "CONFIRMED_SOURCE"
    elif len(s) < MIN_CONTRIBUTIONS_FOR_INFERENCE:
        confidence = "NOT_SIP" if len(s) <= 1 else "AMBIGUOUS"
    elif cadence in ("IRREGULAR", "UNKNOWN"):
        confidence = "AMBIGUOUS"
    else:
        med = median(amounts)
        similar = med > 0 and all(abs(a - med) / med <= AMOUNT_SIMILARITY_TOLERANCE for a in amounts)
        monotonic = trend in ("INCREASING", "DECREASING")
        confidence = "HIGH_CONFIDENCE" if (similar or monotonic) else "POSSIBLE"

    return {
        "contributions": s,
        "cadence": cadence,
        "periodsPerYear": ppy,
        "confidence": confidence,
        "trend": trend,
        "firstContributionDate": s[0]["transactionDate"] if s else "",
        "latestContributionDate": s[-1]["transactionDate"] if s else "",
    }


def detect_series(transactions):
    contribs = [t for t in transactions if t.get("transactionType") in SERIES_MEMBER_TYPES or is_source_confirmed(t)]
    by_pair = {}
    for t in contribs:
        k = "%s:%s" % (t["accountId"], t["instrumentId"])
        by_pair.setdefault(k, []).append(t)
    out = []
    for pair_key in sorted(by_pair.keys()):
        account_id, instrument_id = pair_key.split(":")
        for disc, members in partition_mandates(by_pair[pair_key]):
            a = assess_series(members)
            a["seriesKey"] = "%s:%s:%s" % (account_id, instrument_id, disc)
            a["accountId"] = account_id
            a["instrumentId"] = instrument_id
            out.append(a)
    return sorted(out, key=lambda s: s["seriesKey"])


def nominal_period_days(cadence):
    return CADENCE_BANDS[cadence][2] if cadence in CADENCE_BANDS else None


# ---------------------------------------------------------------------------
# FIFO unit attribution
# ---------------------------------------------------------------------------
def attribute_units(series, position_txns, as_of):
    series_ids = set(t["id"] for t in series["contributions"])
    in_scope = [t for t in position_txns if t["transactionDate"] <= as_of]

    def sort_key(t):
        acq = 0 if t["transactionType"] in ACQUISITION_TYPES else 1
        return (t["transactionDate"], acq, t["id"])

    in_scope.sort(key=sort_key)

    lots = []
    disposed_from_series = 0.0
    mixed = False
    for t in in_scope:
        tt = t["transactionType"]
        if tt in ACQUISITION_TYPES:
            is_series = t["id"] in series_ids
            u = t.get("units")
            if u is None:
                return {"status": "unavailable",
                        "reason": "MISSING_UNITS_ON_CONTRIBUTION" if is_series else "MISSING_UNITS_ON_NON_SERIES_ACQUISITION"}
            if u <= 0:
                continue
            if not is_series:
                mixed = True
            lots.append({"units": float(u), "fromSeries": is_series})
        elif tt in DISPOSAL_TYPES:
            u = t.get("units")
            if u is None:
                return {"status": "unavailable", "reason": "MISSING_UNITS_ON_DISPOSAL"}
            to_remove = abs(float(u))
            for lot in lots:
                if to_remove <= UNIT_EPSILON:
                    break
                if lot["units"] <= UNIT_EPSILON:
                    continue
                take = min(lot["units"], to_remove)
                lot["units"] -= take
                to_remove -= take
                if lot["fromSeries"]:
                    disposed_from_series += take
            if to_remove > 1e-6:
                return {"status": "unavailable", "reason": "DISPOSALS_EXCEED_ACQUISITIONS"}

    series_remaining = sum(l["units"] for l in lots if l["fromSeries"])
    position_remaining = sum(l["units"] for l in lots)
    if series_remaining <= UNIT_EPSILON:
        return {"status": "unavailable", "reason": "NO_SERIES_UNITS", "positionIsMixed": mixed}
    return {
        "status": "ok",
        "seriesUnitsRemaining": series_remaining,
        "positionUnitsRemaining": position_remaining,
        "seriesShareOfPosition": series_remaining / position_remaining if position_remaining > 0 else 0.0,
        "positionIsMixed": mixed,
        "seriesUnitsDisposed": disposed_from_series,
    }


# ---------------------------------------------------------------------------
# Per-family oracle computations
# ---------------------------------------------------------------------------
def oracle_sip(inp):
    txns = inp["transactions"]
    as_of = inp["asOfDate"]
    nav = inp.get("navAtAsOf")
    inflows = inp.get("attributableInflows") or []
    position_txns = inp.get("positionTransactions") or txns

    all_series = detect_series(txns)
    out = {"seriesCount": len(all_series)}
    if not all_series:
        out.update({"cadence": None, "confidence": None, "contributionCount": 0,
                    "actualSipXirrStatus": "unavailable", "actualSipXirr": None,
                    "consistencyPct": None, "activityStatus": None})
        return out

    # Certify against the LARGEST series (most contributions), deterministic
    # tie-break by seriesKey — the same rule the production harness applies.
    primary = sorted(all_series, key=lambda s: (-len(s["contributions"]), s["seriesKey"]))[0]
    out["cadence"] = primary["cadence"]
    out["confidence"] = primary["confidence"]
    out["contributionCount"] = len(primary["contributions"])
    out["trend"] = primary["trend"]
    out["allCadences"] = sorted(s["cadence"] for s in all_series)
    out["allConfidences"] = sorted(s["confidence"] for s in all_series)
    out["allContributionCounts"] = sorted(len(s["contributions"]) for s in all_series)

    # Actual SIP XIRR
    attr = attribute_units(primary, position_txns if position_txns else primary["contributions"], as_of)
    if attr["status"] != "ok":
        out["actualSipXirrStatus"] = "unavailable"
        out["actualSipXirrReason"] = "ATTRIBUTION_UNAVAILABLE"
        out["actualSipXirr"] = None
        out["terminalValue"] = None
    elif nav is None:
        out["actualSipXirrStatus"] = "unavailable"
        out["actualSipXirrReason"] = "NAV_UNAVAILABLE"
        out["actualSipXirr"] = None
        out["terminalValue"] = None
    else:
        terminal = attr["seriesUnitsRemaining"] * nav
        flows = [(c["transactionDate"], -abs(c["grossAmount"])) for c in primary["contributions"]]
        flows += [(f["date"], abs(f["amount"])) for f in inflows]
        flows.append((as_of, terminal))
        st, val = xirr_bisection(flows)
        out["actualSipXirrStatus"] = "ok" if st == "ok" else "unavailable"
        out["actualSipXirr"] = val if st == "ok" else None
        out["actualSipXirrReason"] = None if st == "ok" else "XIRR_UNAVAILABLE"
        out["terminalValue"] = terminal
        out["seriesUnitsRemaining"] = attr["seriesUnitsRemaining"]

    # Consistency
    period_days = nominal_period_days(primary["cadence"])
    if period_days is None:
        out["consistencyPct"] = None
        out["expectedPeriods"] = None
        out["skippedPeriods"] = None
    else:
        span = days_between(primary["firstContributionDate"], primary["latestContributionDate"])
        expected = max(1, round(span / period_days) + 1)
        observed = len(primary["contributions"])
        out["expectedPeriods"] = expected
        out["skippedPeriods"] = max(0, expected - observed)
        out["consistencyPct"] = min(1.0, observed / expected) if expected > 0 else None

    # Activity status
    if period_days is None:
        out["activityStatus"] = "UNKNOWN"
    else:
        periods_since = days_between(primary["latestContributionDate"], as_of) / period_days
        if periods_since <= PAUSE_EXPECTED_MAX:
            out["activityStatus"] = "EXPECTED"
        elif periods_since <= PAUSE_LATE_MAX:
            out["activityStatus"] = "LATE"
        elif periods_since <= PAUSE_POSSIBLE_MAX:
            out["activityStatus"] = "POSSIBLE_PAUSE"
        else:
            out["activityStatus"] = "LIKELY_STOPPED"
    out["notConfirmed"] = out["confidence"] != "CONFIRMED_SOURCE"
    return out


def oracle_benchmark_sip(inp):
    contribs = inp["contributions"]
    series = sorted_series(inp["benchmarkSeries"] or [])
    as_of = inp["asOfDate"]

    if not contribs:
        return {"benchmarkSipStatus": "unavailable", "benchmarkSipReason": "NO_CONTRIBUTIONS",
                "benchmarkSipXirr": None, "syntheticUnits": None, "terminalValue": None,
                "noFabricatedBenchmarkRate": True}
    if not series:
        return {"benchmarkSipStatus": "unavailable", "benchmarkSipReason": "MISSING_BENCHMARK",
                "benchmarkSipXirr": None, "syntheticUnits": None, "terminalValue": None,
                "noFabricatedBenchmarkRate": True}

    synthetic = 0.0
    unaligned = 0
    for c in contribs:
        o = obs_on_or_after(series, c["date"])
        if o is None or o["value"] <= 0:
            unaligned += 1
            continue
        synthetic += abs(c["amount"]) / o["value"]

    if unaligned > 0:
        return {"benchmarkSipStatus": "unavailable", "benchmarkSipReason": "INCOMPLETE_BENCHMARK_HISTORY",
                "benchmarkSipXirr": None, "syntheticUnits": None, "terminalValue": None,
                "noFabricatedBenchmarkRate": True}

    term = obs_as_of(series, as_of)
    if term is None:
        return {"benchmarkSipStatus": "unavailable", "benchmarkSipReason": "BENCHMARK_TERMINAL_UNAVAILABLE",
                "benchmarkSipXirr": None, "syntheticUnits": None, "terminalValue": None,
                "noFabricatedBenchmarkRate": True}

    terminal_value = synthetic * term["value"]
    flows = [(c["date"], -abs(c["amount"])) for c in contribs]
    flows.append((as_of, terminal_value))
    st, val = xirr_bisection(flows)
    return {
        "benchmarkSipStatus": "ok" if st == "ok" else "unavailable",
        "benchmarkSipReason": None if st == "ok" else "XIRR_UNAVAILABLE",
        "benchmarkSipXirr": val if st == "ok" else None,
        "syntheticUnits": synthetic,
        "terminalValue": terminal_value,
        "noFabricatedBenchmarkRate": st == "ok",
    }


def add_months_clamped(iso, n):
    base = d(iso)
    tm = base.month - 1 + n
    y = base.year + tm // 12
    m = tm % 12 + 1
    # last day of target month
    if m == 12:
        dim = 31
    else:
        dim = (date(y, m + 1, 1) - timedelta(days=1)).day
    return date(y, m, min(base.day, dim)).isoformat()


def oracle_simulation(inp):
    series = sorted_series(inp["series"])
    start, end = inp["startDate"], inp["endDate"]
    starting = inp["startingContribution"]
    step = inp["annualStepUpPct"]
    interval = inp.get("contributionIntervalMonths") or 1

    if not series:
        return {"simulationStatus": "unavailable", "reason": "EMPTY_SERIES"}

    units = 0.0
    total = 0.0
    flows = []
    count = 0
    k = 0
    while True:
        dt = add_months_clamped(start, k * interval)
        if dt > end:
            break
        anniversary_year = (k * interval) // 12
        # round-half-away-from-zero to match JS Math.round on positive values
        raw = starting * ((1 + step) ** anniversary_year)
        amount = math.floor(raw + 0.5)
        o = obs_on_or_after(series, dt)
        if o is None or o["value"] <= 0:
            return {"simulationStatus": "unavailable", "reason": "ALIGNMENT_FAILED"}
        units += amount / o["value"]
        total += amount
        flows.append((dt, -amount))
        count += 1
        k += 1

    if count == 0:
        return {"simulationStatus": "unavailable", "reason": "NO_CONTRIBUTION_DATES"}
    term = obs_as_of(series, end)
    if term is None:
        return {"simulationStatus": "unavailable", "reason": "TERMINAL_UNAVAILABLE"}
    terminal_value = units * term["value"]
    flows.append((end, terminal_value))
    st, val = xirr_bisection(flows)
    return {
        "simulationStatus": "ok",
        "contributionCount": count,
        "totalContributed": total,
        "unitsAccumulated": units,
        "terminalValue": terminal_value,
        "simulationXirr": val if st == "ok" else None,
    }


def select_snapshot(snapshots, fund_id, as_of):
    eligible = [s for s in snapshots if s["fundInstrumentId"] == fund_id and s["holdingsAsOfDate"] <= as_of]
    eligible.sort(key=lambda s: (s["holdingsAsOfDate"], s["snapshotId"]), reverse=True)
    return eligible[0] if eligible else None


def classify_freshness(holdings_date, as_of):
    if not holdings_date:
        return "MISSING"
    age = days_between(holdings_date, as_of)
    if age < 0:
        return "MISSING"
    if age <= FRESH_CURRENT_MAX:
        return "CURRENT"
    if age <= FRESH_ACCEPTABLE_MAX:
        return "ACCEPTABLE"
    if age <= FRESH_STALE_MAX:
        return "STALE"
    return "VERY_STALE"


def fund_coverage(snapshot):
    resolved = unresolved = cash = deriv = other = 0.0
    for h in snapshot["holdings"]:
        w = h["weightPct"] / 100.0
        kind = h.get("assetKind") or "security"
        if kind == "cash":
            cash += w
        elif kind == "derivative":
            deriv += w
        elif kind == "other":
            other += w
        elif h.get("canonicalId"):
            resolved += w
        else:
            unresolved += w
    disclosed = resolved + unresolved + cash + deriv + other
    return {
        "disclosedWeightTotal": disclosed,
        "resolvedWeight": resolved,
        "unresolvedWeight": unresolved,
        "cashWeight": cash,
        "derivativeWeight": deriv,
        "otherWeight": other,
        "undisclosedRemainder": max(0.0, 1.0 - disclosed),
        "reportedHoldingsCoverage": min(1.0, disclosed),
    }


def oracle_lookthrough(inp):
    positions = inp["positions"]
    snapshots = inp["snapshots"]
    as_of = inp["asOfDate"]
    total = sum(p["value"] for p in positions)

    if not positions or total <= 0:
        return {"lookThroughStatus": "unavailable", "exposures": [], "effectiveCoverage": 0.0,
                "cashWeight": 0.0, "unresolvedWeight": 0.0, "noSnapshotWeight": 0.0,
                "freshness": "MISSING", "noFabricatedZeroSectors": True}

    exposures = {}
    cash = deriv = other = unresolved = no_snap = undisclosed = 0.0
    scheme_cov = 0.0
    cov_weighted = 0.0
    holdings_dates = []
    used = []

    for p in positions:
        pw = p["value"] / total
        snap = select_snapshot(snapshots, p["fundInstrumentId"], as_of)
        if snap is None:
            no_snap += pw
            continue
        scheme_cov += pw
        used.append(snap["snapshotId"])
        holdings_dates.append(snap["holdingsAsOfDate"])
        cov = fund_coverage(snap)
        cov_weighted += pw * cov["reportedHoldingsCoverage"]
        undisclosed += pw * cov["undisclosedRemainder"]
        cash += pw * cov["cashWeight"]
        deriv += pw * cov["derivativeWeight"]
        other += pw * cov["otherWeight"]
        unresolved += pw * cov["unresolvedWeight"]

        for h in snap["holdings"]:
            kind = h.get("assetKind") or "security"
            if kind != "security" or not h.get("canonicalId"):
                continue
            hw = h["weightPct"] / 100.0
            contribution = pw * hw  # THE CORE FORMULA
            cid = h["canonicalId"]
            if cid in exposures:
                exposures[cid]["effectiveWeight"] += contribution
                exposures[cid]["schemeCount"] += 1
                if exposures[cid]["sectorCode"] is None:
                    exposures[cid]["sectorCode"] = h.get("sectorCode")
                if exposures[cid]["marketCapClass"] is None:
                    exposures[cid]["marketCapClass"] = h.get("marketCapClass")
            else:
                exposures[cid] = {"canonicalId": cid, "displayName": h["displayName"],
                                  "effectiveWeight": contribution, "schemeCount": 1,
                                  "sectorCode": h.get("sectorCode"), "marketCapClass": h.get("marketCapClass")}

    if not used:
        return {"lookThroughStatus": "unavailable", "exposures": [], "effectiveCoverage": 0.0,
                "cashWeight": 0.0, "unresolvedWeight": 0.0, "noSnapshotWeight": no_snap,
                "freshness": "MISSING", "noFabricatedZeroSectors": True}

    holdings_cov = cov_weighted / scheme_cov if scheme_cov > 0 else 0.0
    effective = scheme_cov * holdings_cov
    sd = sorted(holdings_dates)
    oldest, newest = sd[0], sd[-1]
    spread = days_between(oldest, newest)
    exp_list = sorted(exposures.values(), key=lambda e: (-e["effectiveWeight"], e["canonicalId"]))

    return {
        "lookThroughStatus": "ok",
        "exposures": [{"canonicalId": e["canonicalId"], "effectiveWeight": e["effectiveWeight"],
                       "schemeCount": e["schemeCount"]} for e in exp_list],
        "effectiveCoverage": effective,
        "schemeCoverage": scheme_cov,
        "holdingsCoverageWithinSchemes": holdings_cov,
        "cashWeight": cash,
        "derivativeWeight": deriv,
        "otherWeight": other,
        "unresolvedWeight": unresolved,
        "noSnapshotWeight": no_snap,
        "undisclosedRemainderWeight": undisclosed,
        "freshness": classify_freshness(oldest, as_of),
        "oldestHoldingsDate": oldest,
        "newestHoldingsDate": newest,
        "mixedDateSpreadDays": spread,
        "mixedDateWarning": spread > MIXED_DATE_WARN,
        "hasStaleStatus": classify_freshness(oldest, as_of) in ("STALE", "VERY_STALE"),
        "hasUnresolvedStatus": unresolved > 0,
        "noFabricatedZeroSectors": True,
        # The weight identity that makes double-counting structurally impossible.
        "weightIdentity": sum(e["effectiveWeight"] for e in exp_list) + cash + deriv + other + unresolved + no_snap + undisclosed,
        "exactExposureX": next((e["effectiveWeight"] for e in exp_list if e["canonicalId"] == "X"), None),
    }


def resolved_weight_map(snapshot):
    m = {}
    unresolved = 0.0
    for h in snapshot["holdings"]:
        kind = h.get("assetKind") or "security"
        if kind != "security":
            continue
        w = h["weightPct"] / 100.0
        if not h.get("canonicalId"):
            unresolved += w
            continue
        m[h["canonicalId"]] = m.get(h["canonicalId"], 0.0) + w
    return m, unresolved


def overlap_pair(a, b, as_of):
    if a is None or b is None:
        return {"overlapStatus": "unavailable", "weightedOverlap": None, "commonSecurityCount": None}
    ma, ua = resolved_weight_map(a)
    mb, ub = resolved_weight_map(b)
    total = 0.0
    common = 0
    for cid, wa in ma.items():
        if cid in mb:
            total += min(wa, mb[cid])
            common += 1
    fa = classify_freshness(a["holdingsAsOfDate"], as_of)
    fb = classify_freshness(b["holdingsAsOfDate"], as_of)
    warn = (fa in ("STALE", "VERY_STALE") or fb in ("STALE", "VERY_STALE")
            or a["holdingsAsOfDate"] != b["holdingsAsOfDate"] or ua > 0 or ub > 0)
    return {"overlapStatus": "ok", "weightedOverlap": total, "commonSecurityCount": common,
            "hasQualityWarning": warn}


def oracle_overlap(inp):
    snaps = inp["snapshots"]
    as_of = inp["asOfDate"]
    if len(snaps) == 2:
        fwd = overlap_pair(snaps[0], snaps[1], as_of)
        rev = overlap_pair(snaps[1], snaps[0], as_of)
        fwd["symmetry"] = (fwd["weightedOverlap"] is not None and rev["weightedOverlap"] is not None
                           and abs(fwd["weightedOverlap"] - rev["weightedOverlap"]) < 1e-12)
        return fwd
    # Matrix case
    n = len(snaps)
    matrix = [[None] * n for _ in range(n)]
    values = []
    for i in range(n):
        matrix[i][i] = 1.0
        for j in range(i + 1, n):
            r = overlap_pair(snaps[i], snaps[j], as_of)
            v = r["weightedOverlap"]
            matrix[i][j] = v
            matrix[j][i] = v
            values.append(round(v, 12) if v is not None else None)
    symmetric = all(matrix[i][j] == matrix[j][i] for i in range(n) for j in range(n))
    bounded = all(v is None or (0.0 - 1e-12 <= v <= 1.0 + 1e-12) for row in matrix for v in row)
    return {"matrixSize": n, "matrixSymmetric": symmetric, "matrixBounded": bounded, "matrixValues": values}


def oracle_concentration(inp):
    lt = oracle_lookthrough(inp)
    out = {}
    if lt["lookThroughStatus"] != "ok" or not lt["exposures"]:
        return {"top1": None, "top5": None, "top10": None, "hhi": None,
                "sectorBuckets": [], "marketCapBuckets": []}
    ws = [e["effectiveWeight"] for e in lt["exposures"]]
    out["top1"] = ws[0]
    out["top5"] = sum(ws[:5])
    out["top10"] = sum(ws[:10])
    out["hhi"] = sum(w * w for w in ws)

    # Sector / market-cap aggregation needs the classification fields, which
    # oracle_lookthrough drops; recompute from raw input independently.
    positions = inp["positions"]
    snapshots = inp["snapshots"]
    as_of = inp["asOfDate"]
    total = sum(p["value"] for p in positions)
    sector = {}
    mcap = {}
    sector_classified = sector_unclassified = 0.0
    mcap_classified = mcap_unclassified = 0.0
    per_security = {}
    for p in positions:
        pw = p["value"] / total
        snap = select_snapshot(snapshots, p["fundInstrumentId"], as_of)
        if snap is None:
            continue
        for h in snap["holdings"]:
            if (h.get("assetKind") or "security") != "security" or not h.get("canonicalId"):
                continue
            cid = h["canonicalId"]
            contribution = pw * (h["weightPct"] / 100.0)
            if cid not in per_security:
                per_security[cid] = {"w": 0.0, "sectorCode": h.get("sectorCode"), "marketCapClass": h.get("marketCapClass")}
            per_security[cid]["w"] += contribution
            if per_security[cid]["sectorCode"] is None:
                per_security[cid]["sectorCode"] = h.get("sectorCode")
            if per_security[cid]["marketCapClass"] is None:
                per_security[cid]["marketCapClass"] = h.get("marketCapClass")
    for cid, v in per_security.items():
        if v["sectorCode"]:
            sector[v["sectorCode"]] = sector.get(v["sectorCode"], 0.0) + v["w"]
            sector_classified += v["w"]
        else:
            sector_unclassified += v["w"]
        if v["marketCapClass"]:
            mcap[v["marketCapClass"]] = mcap.get(v["marketCapClass"], 0.0) + v["w"]
            mcap_classified += v["w"]
        else:
            mcap_unclassified += v["w"]

    out["sectorBuckets"] = sorted([{"key": k, "effectiveWeight": v} for k, v in sector.items()],
                                  key=lambda b: (-b["effectiveWeight"], b["key"]))
    out["sectorClassifiedWeight"] = sector_classified
    out["sectorUnclassifiedWeight"] = sector_unclassified
    out["marketCapBuckets"] = sorted([{"key": k, "effectiveWeight": v} for k, v in mcap.items()],
                                     key=lambda b: (-b["effectiveWeight"], b["key"]))
    out["marketCapClassifiedWeight"] = mcap_classified
    out["marketCapUnclassifiedWeight"] = mcap_unclassified
    return out


def oracle_amc(inp):
    positions = inp["positions"]
    total = sum(p["value"] for p in positions)
    buckets = {}
    unattributed = 0.0
    for p in positions:
        if not p.get("amcId"):
            unattributed += p["value"]
            continue
        b = buckets.setdefault(p["amcId"], {"amcId": p["amcId"], "value": 0.0, "schemeCount": 0})
        b["value"] += p["value"]
        b["schemeCount"] += 1
    out = sorted([{"amcId": b["amcId"], "weight": b["value"] / total, "schemeCount": b["schemeCount"]}
                  for b in buckets.values()], key=lambda b: (-b["weight"], b["amcId"]))
    return {"amcBuckets": out, "amcUnattributedWeight": unattributed / total}


def oracle_debt(inp):
    lines = inp["lines"]
    as_of = inp["asOfDate"]
    consolidation = inp.get("consolidationMethodology")

    # Credit quality
    multi = [l for l in lines
             if l.get("agencyRatings") and len(set(r["rating"].strip().upper() for r in l["agencyRatings"])) > 1]
    if multi and not consolidation:
        credit = {"creditStatus": "unavailable", "creditBuckets": [], "consolidationSuppressed": True}
    else:
        cb = {}
        for l in lines:
            band = l.get("creditRatingBand")
            if band not in CREDIT_BANDS or band is None:
                band = "UNRATED"
            cb[band] = cb.get(band, 0.0) + l["effectiveWeight"]
        buckets = [{"key": k, "effectiveWeight": cb[k]} for k in CREDIT_BANDS if k in cb]
        credit = {"creditStatus": "ok" if buckets else "unavailable", "creditBuckets": buckets,
                  "consolidationSuppressed": False}

    # Maturity buckets
    mb = {}
    covered = uncovered = 0.0
    for l in lines:
        key = "PERPETUAL_UNKNOWN"
        if l.get("maturityDate"):
            years = (d(l["maturityDate"]) - d(as_of)).days / 365.25
            found = None
            for k, lo, hi in MATURITY_BUCKETS:
                if lo <= years < hi:
                    found = k
                    break
            if found:
                key = found
                covered += l["effectiveWeight"]
            else:
                uncovered += l["effectiveWeight"]
        else:
            uncovered += l["effectiveWeight"]
        mb[key] = mb.get(key, 0.0) + l["effectiveWeight"]
    order = [k for k, _, _ in MATURITY_BUCKETS] + ["PERPETUAL_UNKNOWN"]
    maturity_buckets = [{"key": k, "effectiveWeight": mb[k]} for k in order if k in mb]

    # Duration — source-provided only, min 80% coverage
    weighted = dcov = dtotal = 0.0
    for l in lines:
        dtotal += l["effectiveWeight"]
        md = l.get("modifiedDuration")
        if md is not None:
            weighted += l["effectiveWeight"] * md
            dcov += l["effectiveWeight"]
    if dcov <= 0:
        duration = {"durationStatus": "unavailable", "weightedDuration": None}
    elif (dcov / dtotal if dtotal > 0 else 0) < 0.8:
        duration = {"durationStatus": "unavailable", "weightedDuration": None}
    else:
        duration = {"durationStatus": "ok", "weightedDuration": weighted / dcov}

    # Issuer concentration
    ib = {}
    unattr = 0.0
    for l in lines:
        if not l.get("issuerId"):
            unattr += l["effectiveWeight"]
            continue
        ib[l["issuerId"]] = ib.get(l["issuerId"], 0.0) + l["effectiveWeight"]
    issuer_buckets = sorted([{"issuerId": k, "effectiveWeight": v} for k, v in ib.items()],
                            key=lambda b: (-b["effectiveWeight"], b["issuerId"]))

    res = {"maturityStatus": "ok" if maturity_buckets else "unavailable",
           "maturityBuckets": maturity_buckets,
           "issuerBuckets": issuer_buckets,
           "issuerUnattributedWeight": unattr}
    res.update(credit)
    res.update(duration)
    res["noFabricatedDuration"] = duration["durationStatus"] == "unavailable" or duration["weightedDuration"] is not None
    return res


def oracle_data_quality(inp):
    kind = inp["kind"]
    if kind == "xray":
        return oracle_lookthrough(inp)
    if kind == "benchmark_sip":
        return oracle_benchmark_sip(inp)
    if kind == "sip":
        return oracle_sip(inp)
    if kind == "debt":
        return oracle_debt(inp)
    return {}


# ---------------------------------------------------------------------------
def main():
    with open(os.path.join(CERT_DIR, "cases.json"), "r", encoding="utf-8") as f:
        payload = json.load(f)

    results = []
    for c in payload["cases"]:
        fam = c["family"]
        inp = c["input"]
        if fam == "sip":
            out = oracle_sip(inp)
        elif fam == "benchmark_sip":
            out = oracle_benchmark_sip(inp)
        elif fam == "simulation":
            out = oracle_simulation(inp)
        elif fam == "xray":
            out = oracle_lookthrough(inp)
        elif fam == "overlap":
            out = oracle_overlap(inp)
        elif fam == "concentration":
            out = oracle_concentration(inp)
        elif fam == "amc_concentration":
            out = oracle_amc(inp)
        elif fam == "debt":
            out = oracle_debt(inp)
        elif fam == "data_quality":
            out = oracle_data_quality(inp)
        else:
            raise SystemExit("Unknown family: %s" % fam)
        results.append({"id": c["id"], "family": fam, "certify": c["certify"], "expected": out})

    # newline='' prevents Python's universal-newline translation from turning
    # json.dump's '\n' line separators into CRLF on Windows — this repo's
    # convention (and a prior CRLF-broke-an-exact-match-test incident) requires LF.
    with open(os.path.join(CERT_DIR, "oracle_results.json"), "w", encoding="utf-8", newline="") as f:
        json.dump({"oracle": "ii_r5_independent_reconciliation.py",
                   "importsProductionCode": False,
                   "xirrAlgorithm": "pure-bisection (production uses safeguarded Newton-Raphson)",
                   "resultCount": len(results),
                   "results": results}, f, indent=2)
    print("Wrote %d oracle results to scripts/ii-r5-certification/oracle_results.json" % len(results))


if __name__ == "__main__":
    main()
