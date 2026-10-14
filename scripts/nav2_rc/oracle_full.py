#!/usr/bin/env python3
"""
NAV2 release candidate, D4 -- INDEPENDENT full oracle for an issued Fund analytics report.

INDEPENDENCE STATEMENT. Imports nothing from lib/engines/nav2 or any FHIP TypeScript. It reads (a) the report as issued, (b) the raw effective NAV series of
each fund and (c) the risk-free observations, all exported by oracle_export.mjs, and re-derives every number below from the published conventions in
docs/nav2/NAV2_METRIC_DEFINITION_REGISTER.md, in a different language, with Decimal arithmetic (50 digits) for sums and roots. The analysis WINDOW of each
metric is taken from the report's own declared actual window (and cross-checked: the observation count the report states must equal the count found here).

    python scripts/nav2_rc/oracle_full.py <export.json> [--tol 1e-9]

Exit code 1 if any check fails. Prints one line per check.
"""
import json
import sys
from bisect import bisect_right
from datetime import date
from decimal import Decimal as D, getcontext
from math import isnan

getcontext().prec = 50
DPY = D("365.2425")
TOL = D(sys.argv[sys.argv.index("--tol") + 1]) if "--tol" in sys.argv else D("1e-9")


def dt(s):
    y, m, d = s[:10].split("-")
    return date(int(y), int(m), int(d))


def days(a, b):
    return (dt(b) - dt(a)).days


def sub_months(iso, n):
    y, m, d = (int(x) for x in iso[:10].split("-"))
    total = y * 12 + (m - 1) - n
    ty, tm = divmod(total, 12)
    # last day of target month
    if tm == 11:
        last = 31
    else:
        last = (date(ty, tm + 2, 1) - date(ty, tm + 1, 1)).days
    return f"{ty:04d}-{tm + 1:02d}-{min(d, last):02d}"


def mean(xs):
    return sum(xs, D(0)) / D(len(xs))


def sample_sd(xs):
    m = mean(xs)
    return (sum(((x - m) ** 2 for x in xs), D(0)) / D(len(xs) - 1)).sqrt()


def median(xs):
    s = sorted(xs)
    n = len(s)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


def on_or_before(series, iso, look=10):
    dates = [p[0] for p in series]
    i = bisect_right(dates, iso) - 1
    if i < 0:
        return None
    if days(series[i][0], iso) > look:
        return None
    return series[i]


results = []


def check(label, ok, detail=""):
    results.append(ok)
    print(f"  {'PASS' if ok else 'FAIL'}  {label}{('  (' + detail + ')') if detail and not ok else ''}")


def close(a, b, tol=None):
    if a is None or b is None:
        return False
    a, b = D(str(a)), D(str(b))
    t = (tol or TOL) * max(D(1), abs(b))
    return abs(a - b) <= t


def res(r):
    """The 'available' value of a typed result, else None."""
    return r["value"] if isinstance(r, dict) and r.get("state") == "available" else None


def window_obs(series, w):
    return [p for p in series if w["start"] <= p[0] <= w["end"]]


def rf_rate_factory(rf_obs, stale=21, carry=35):
    """Step function over VALUE observations with the 21 day staleness, plus the documented-gap carry of at most 35 days from the last VALUE."""
    values = [(o["date"], D(str(o["value"]))) for o in rf_obs if o["kind"] == "value" and o["value"] is not None]
    gaps = sorted(o["date"] for o in rf_obs if o["kind"] == "gap")
    vd = [v[0] for v in values]

    def at(iso):
        i = bisect_right(vd, iso) - 1
        if i < 0:
            return None
        age = days(vd[i], iso)
        if age <= stale:
            return values[i][1]
        # older than 21 days: carried only across documented gap rows, at most 35 days from the last value
        if age <= carry and any(vd[i] < g <= iso for g in gaps):
            return values[i][1]
        return None

    return at


def periodic(y, n):
    return (D(1) + y / D(100)) ** (D(1) / D(n)) - D(1)


def simple_returns(obs):
    return [(obs[i - 1][0], obs[i][0], obs[i][1] / obs[i - 1][1] - D(1)) for i in range(1, len(obs))]


def pearson(x, y):
    mx, my = mean(x), mean(y)
    sxy = sum(((a - mx) * (b - my) for a, b in zip(x, y)), D(0))
    sxx = sum(((a - mx) ** 2 for a in x), D(0))
    syy = sum(((b - my) ** 2 for b in y), D(0))
    return sxy / (sxx * syy).sqrt()


def main():
    exp = json.load(open(sys.argv[1], encoding="utf-8"))
    report = exp["report"]
    as_of = report["asOfDate"]
    navs = {f["instrumentId"]: [(p["date"], D(str(p["nav"]))) for p in f["nav"] if p["date"] <= as_of] for f in exp["funds"]}
    print(f"report {exp['reportId']}  as of {as_of}  funds {len(exp['funds'])}  tolerance {TOL}")
    for sc in report["schemes"]:
        iid = sc["instrumentId"]
        series = navs[iid]
        a = sc["analytics"]["scheme"]
        print(f"\n--- {sc['schemeName']} ({len(series)} NAV points {series[0][0]} .. {series[-1][0]})")
        check("series ends on the report's NAV date", a["navSeries"]["lastDate"] == series[-1][0] and a["navSeries"]["count"] == len(series), f"{a['navSeries']['lastDate']} {a['navSeries']['count']} vs {series[-1][0]} {len(series)}")

        # ---- point to point: absolute return and CAGR
        for item in a["pointToPoint"]:
            v = res(item["result"])
            if v is None:
                continue
            s = on_or_before(series, v["requestedStart"])
            e = on_or_before(series, v["requestedEnd"])
            ok = s and e and s[0] == v["startDate"] and e[0] == v["endDate"] and close(s[1], v["startNav"]) and close(e[1], v["endNav"])
            check(f"{item['id']} boundaries (latest NAV on or before each requested date, within 10 days)", ok)
            if not ok:
                continue
            ratio = e[1] / s[1]
            check(f"{item['id']} absolute return", close(ratio - 1, v["absoluteReturn"]))
            actual = days(s[0], e[0])
            check(f"{item['id']} actual days", actual == v["actualDays"])
            req = days(v["requestedStart"], v["requestedEnd"])
            cagr_res = res(item["cagr"])
            if req >= 365 or actual >= 365:
                check(f"{item['id']} CAGR on actual days / 365.2425", cagr_res is not None and close(ratio ** (DPY / D(actual)) - 1, cagr_res["cagr"]))

        # ---- the declared analysis window comes from the volatility provenance (daily returns over the window)
        vol = a["volatility"]
        w = None
        if vol.get("provenance"):
            aw = vol["provenance"]["actualWindow"]
            if aw["start"] and aw["end"]:
                w = {"start": aw["start"], "end": aw["end"]}
        if w is None:
            print("  (no analysis window declared: window metrics are unavailable for this fund)")
            continue
        obs = window_obs(series, w)
        rets = simple_returns(obs)
        check("observation count in the declared window", vol["provenance"]["observationCount"] == len(rets), f"{vol['provenance']['observationCount']} vs {len(rets)}")

        # ---- volatility
        v = res(vol)
        if v:
            check("volatility returnCount", v["returnCount"] == len(rets))
            sd = sample_sd([r[2] for r in rets])
            check("volatility periodic sample sd", close(sd, v["periodicSampleSd"]))
            check("volatility annualised (x sqrt 252)", close(sd * D(252).sqrt(), v["annualisedVolatility"]))

        # ---- extremes and averages (window)
        ex = res(a["extremes"])
        if ex:
            hi = max(p[1] for p in obs)
            lo = min(p[1] for p in obs)
            check("highest NAV and its earliest date", close(hi, ex["highestNav"]) and next(p[0] for p in obs if p[1] == hi) == ex["highestNavDate"])
            check("lowest NAV and its earliest date", close(lo, ex["lowestNav"]) and next(p[0] for p in obs if p[1] == lo) == ex["lowestNavDate"])
        av = res(a["average"])
        if av:
            check("mean NAV", close(mean([p[1] for p in obs]), av["meanNav"]))
            check("median NAV", close(median([p[1] for p in obs]), av["medianNav"]))

        # ---- maximum drawdown
        md = res(a["maxDrawdown"])
        if md:
            peak = obs[0][1]
            worst = D(0)
            for p in obs:
                peak = max(peak, p[1])
                worst = min(worst, p[1] / peak - 1)
            check("maximum drawdown", close(worst, md["maxDrawdown"]))

        # ---- rolling returns
        for item in a["rolling"]:
            v = res(item["result"])
            if v is None:
                continue
            months = v["horizonMonths"]
            wins = []
            dates = [p[0] for p in series]
            for p in obs:
                s = on_or_before(series, sub_months(p[0], months))
                if s is None:
                    continue
                ratio = p[1] / s[1]
                if months < 12:
                    wins.append(ratio - 1)
                else:
                    wins.append(ratio ** (DPY / D(days(s[0], p[0]))) - 1)
            ok = len(wins) == v["windowCount"]
            check(f"rolling {item['horizonId']} window count", ok, f"{len(wins)} vs {v['windowCount']}")
            sm = v.get("summary")
            if ok and sm:
                check(f"rolling {item['horizonId']} min/max/mean/median/positive share", close(min(wins), sm["min"]) and close(max(wins), sm["max"]) and close(mean(wins), sm["mean"]) and close(median(wins), sm["median"]) and close(D(sum(1 for x in wins if x > 0)) / D(len(wins)), sm["positiveWindowShare"]))

        # ---- SMA / EMA / ROC (latest value, warm-up on the whole series)
        for item in a["movingAverages"]:
            v = res(item["result"])
            if v is None:
                continue
            n = item["period"]
            prices = [p[1] for p in series]
            if item["kind"] == "sma":
                val = mean(prices[-n:])
            else:
                k = D(2) / D(n + 1)
                ema = mean(prices[:n])
                for p in prices[n:]:
                    ema = p * k + ema * (1 - k)
                val = ema
            check(f"{item['kind'].upper()}{n} latest value", close(val, v["latest"]["value"]))
        for item in a["rateOfChange"]:
            v = res(item["result"])
            if v is None:
                continue
            n = item["period"]
            prices = [p[1] for p in series]
            check(f"ROC{n} latest value", close(prices[-1] / prices[-1 - n] - 1, v["latest"]["value"]))

        # ---- Sharpe and Sortino (risk-free: latest VALUE on or before each interval start, 21 day staleness, 35 day documented-gap carry)
        for key in ("sharpe", "sortino"):
            v = res(a[key])
            if v is None:
                continue
            rfp = a[key]["provenance"]["riskFree"]
            at = rf_rate_factory(exp["riskFree"][rfp["seriesId"]])
            excess, mar_excess = [], []
            for (d0, d1, r) in rets:
                y = at(d0)
                if y is None:
                    continue
                rf = periodic(y, 252)
                excess.append(r - rf)
            coverage = D(len(excess)) / D(len(rets))
            check(f"{key}: risk-free coverage is at least 95 percent and the count matches", coverage >= D("0.95") and len(excess) == v["returnCount"], f"{len(excess)}/{len(rets)} vs {v['returnCount']}")
            if len(excess) != v["returnCount"]:
                continue
            m = mean(excess)
            if key == "sharpe":
                sd = sample_sd(excess)
                check("sharpe mean excess return", close(m, v["meanExcessReturn"]))
                check("sharpe sample sd of excess", close(sd, v["sampleSdExcessReturn"]))
                check("sharpe periodic ratio", close(m / sd, v["periodicRatio"]))
                check("sharpe annualised (x sqrt 252)", close(m / sd * D(252).sqrt(), v["annualisedRatio"]))
            else:
                dd = (sum((min(D(0), x) ** 2 for x in excess), D(0)) / D(len(excess))).sqrt()
                if dd == 0:
                    continue
                keyp = "periodicRatio" if "periodicRatio" in v else next((k for k in v if "eriodic" in k), None)
                keya = "annualisedRatio" if "annualisedRatio" in v else next((k for k in v if "nnualised" in k), None)
                if keyp:
                    check("sortino periodic ratio (all periods, population denominator)", close(m / dd, v[keyp]))
                if keya:
                    check("sortino annualised (x sqrt 252)", close(m / dd * D(252).sqrt(), v[keya]))
                else:
                    print("  note: sortino value keys:", sorted(v))

    # ---- correlations between held schemes (aligned common dates, simple returns, Pearson)
    cmp_ = report.get("comparison") or {}
    corr = cmp_.get("correlations")
    if corr:
        rows = corr if isinstance(corr, list) else corr.get("pairs", [])
        print(f"\n--- correlations ({len(rows)} pairs)")
        for p in rows[:60]:
            v = res(p.get("result", p))
            if not v:
                continue
            prov = (p.get("result") or {}).get("provenance", {})
            a_id = prov.get("instrumentId")
            b_id = (prov.get("convention") or {}).get("pairedInstrumentId")
            if not a_id or not b_id or a_id not in navs or b_id not in navs:
                continue
            sa = {d: n for d, n in window_obs(navs[a_id], {"start": v["windowStart"], "end": v["windowEnd"]})}
            sb = {d: n for d, n in window_obs(navs[b_id], {"start": v["windowStart"], "end": v["windowEnd"]})}
            common = sorted(set(sa) & set(sb))
            ra = [sa[common[i]] / sa[common[i - 1]] - 1 for i in range(1, len(common))]
            rb = [sb[common[i]] / sb[common[i - 1]] - 1 for i in range(1, len(common))]
            check(f"correlation count {a_id[:6]}/{b_id[:6]}", len(ra) == v["commonReturnCount"], f"{len(ra)} vs {v['commonReturnCount']}")
            if len(ra) == v["commonReturnCount"]:
                check(f"correlation value {a_id[:6]}/{b_id[:6]}", close(pearson(ra, rb), v["correlation"]))

    # ---- held ranking: the ranked value is the fund's own point-to-point CAGR for the horizon; ranks run from the highest value down
    for rk in (cmp_.get("rankings") or []):
        v = res(rk.get("result", rk))
        if not v:
            continue
        for g in v.get("groups", []):
            hid = g.get("horizonId") or rk.get("horizonId")
            metric = g.get("metricId")
            rows = g.get("rows", [])
            if metric != "cagr" or not hid:
                continue
            own = {}
            for sc in report["schemes"]:
                for item in sc["analytics"]["scheme"]["pointToPoint"]:
                    if item["id"] == hid and res(item["cagr"]):
                        own[sc["instrumentId"]] = D(str(res(item["cagr"])["cagr"]))
            ok = all(r["instrumentId"] in own and close(own[r["instrumentId"]], r["value"]) for r in rows)
            check(f"ranking {hid} {g.get('category')}: values are the funds' own CAGR", ok)
            ordered = [r["value"] for r in sorted(rows, key=lambda r: r["rank"])]
            check(f"ranking {hid} {g.get('category')}: rank 1 is the highest value, descending", all(D(str(ordered[i])) >= D(str(ordered[i + 1])) for i in range(len(ordered) - 1)))

    bad = results.count(False)
    print(f"\n{results.count(True)} PASS, {bad} FAIL")
    sys.exit(1 if bad else 0)


main()
