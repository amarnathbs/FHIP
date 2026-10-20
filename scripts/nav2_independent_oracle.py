#!/usr/bin/env python3
"""
NAV2 Stage 1 -- independent oracle for the golden fixtures.

INDEPENDENCE STATEMENT. This file imports NOTHING from lib/engines/nav2 or any
other FHIP TypeScript. It re-derives every expected number in
tests/unit/nav2/*.test.ts from the published formulas (docs/nav2/
NAV2_METRIC_DEFINITION_REGISTER.md, spec section 8) in a different language with
50-digit Decimal arithmetic, so the production engine is never its own oracle.
The numbers are PASTED into the test files (with their derivation in a comment);
this script is how they were produced and how a reviewer re-checks them:

    python scripts/nav2_independent_oracle.py

Where a closed form exists the test comment states it; the script confirms it.
"""
from datetime import date, timedelta
from decimal import Decimal as D, getcontext

getcontext().prec = 50
DPY = D("365.2425")


def d(s):
    y, m, dd = s.split("-")
    return date(int(y), int(m), int(dd))


def weekdays(start, n):
    out, cur = [], d(start)
    while len(out) < n:
        if cur.weekday() < 5:
            out.append(cur.isoformat())
        cur += timedelta(days=1)
    return out


def mean(xs):
    return sum(xs, D(0)) / D(len(xs))


def sample_sd(xs):
    m = mean(xs)
    return (sum(((x - m) ** 2 for x in xs), D(0)) / D(len(xs) - 1)).sqrt()


def median(xs):
    s = sorted(xs)
    n = len(s)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


def show(label, v):
    if isinstance(v, (list, tuple)):
        print(f"{label}: [" + ", ".join(f"{x:.17g}" if isinstance(x, (D, float)) else str(x) for x in v) + "]")
    elif isinstance(v, (D, float)):
        print(f"{label}: {v:.17g}")
    else:
        print(f"{label}: {v}")


def xirr_bisect(flows):
    """flows: [(date, amount D)]. Pure high-precision bisection on (-0.9999, 10)."""
    t0 = flows[0][0]

    def npv(r):
        return sum((a / (D(1) + r) ** (D((dt - t0).days) / D(365)) for dt, a in flows), D(0))

    lo, hi = D("-0.9999"), D(10)
    flo = npv(lo)
    for _ in range(300):
        mid = (lo + hi) / 2
        fm = npv(mid)
        if (fm > 0) == (flo > 0):
            lo, flo = mid, fm
        else:
            hi = mid
    return (lo + hi) / 2


print("=== A1 spec example 1: 100 on 2023-01-01, 121 on 2025-01-01 ===")
days = (d("2025-01-01") - d("2023-01-01")).days
show("days", days)
show("absolute", D(121) / D(100) - 1)
show("cagr_365.2425", D("1.21") ** (DPY / D(days)) - 1)
show("cagr_actual365 (R4 convention, for the register)", D("1.21") ** (D(365) / D(days)) - 1)

print("\n=== A2 twelve weekday NAVs from 2025-01-06 ===")
navs = [D(x) for x in [100, 102, 101, 105, 103, 107, 110, 108, 112, 111, 115, 120]]
dates = weekdays("2025-01-06", 12)
show("dates", dates)
simple = [navs[i] / navs[i - 1] - 1 for i in range(1, 12)]
logr = [(navs[i] / navs[i - 1]).ln() for i in range(1, 12)]
show("simple", simple)
show("log", logr)
show("cumulative_simple", navs[-1] / navs[0] - 1)
show("cumulative_from_log", logr and (sum(logr, D(0))).exp() - 1)
show("high", max(navs))
show("low", min(navs))
show("mean", mean(navs))
show("median", median(navs))
sma3 = [mean(navs[i - 2 : i + 1]) for i in range(2, 12)]
show("sma3", sma3)
sma5_last = mean(navs[-5:])
show("sma5_last", sma5_last)
m = D(2) / D(3 + 1)
ema = {2: mean(navs[:3])}
for i in range(3, 12):
    ema[i] = navs[i] * m + ema[i - 1] * (1 - m)
show("ema3", [ema[i] for i in range(2, 12)])
roc5 = [navs[i] / navs[i - 5] - 1 for i in range(5, 12)]
show("roc5", roc5)

print("\n=== A3 sixty-one weekday NAVs alternating +1% / -1% from 100 ===")
nav = [D(100)]
for i in range(60):
    nav.append(nav[-1] * (D("1.01") if i % 2 == 0 else D("0.99")))
rets = [nav[i] / nav[i - 1] - 1 for i in range(1, 61)]
show("n_returns", len(rets))
show("mean_return", mean(rets))
sd = sample_sd(rets)
show("sample_sd", sd)
show("closed_form_sd sqrt(60*1e-4/59)", (D(60) * D("0.0001") / D(59)).sqrt())
show("annualised_vol_252", sd * D(252).sqrt())
show("annualised_vol_52 (weekly factor, convention table)", sd * D(52).sqrt())
show("annualised_vol_12 (monthly factor, convention table)", sd * D(12).sqrt())
peak = nav[1]
show("mdd (trough/peak-1) closed form 100*0.9999^30/101-1", D(100) * D("0.9999") ** 30 / D(101) - 1)
run, worst, tr = nav[0], D(0), 0
for i, v in enumerate(nav):
    run = max(run, v)
    if v / run - 1 < worst:
        worst, tr = v / run - 1, i
show("mdd_scan", worst)
show("trough_index", tr)
show("peak_value", peak)
show("trough_value", nav[tr])
show("nav_last", nav[-1])

print("\n=== A4 thirteen month-start NAVs, 2024-01-01 .. 2025-01-01 ===")
mnav = [D(x) for x in [100, 102, 101, 105, 107, 104, 110, 112, 111, 115, 118, 117, 120]]
r1m = [mnav[i] / mnav[i - 1] - 1 for i in range(1, 13)]
show("rolling_1M", r1m)
show("rolling_1M_min", min(r1m))
show("rolling_1M_max", max(r1m))
show("rolling_1M_mean", mean(r1m))
show("rolling_1M_median", median(r1m))
show("rolling_1M_positive_share", D(sum(1 for x in r1m if x > 0)) / D(len(r1m)))
r3m = [mnav[i] / mnav[i - 3] - 1 for i in range(3, 13)]
show("rolling_3M", r3m)
days_1y = (d("2025-01-01") - d("2024-01-01")).days
show("days_2024-01-01_to_2025-01-01", days_1y)
show("rolling_1Y_single_window_cagr", (D(120) / D(100)) ** (DPY / D(days_1y)) - 1)

print("\n=== B weekday fixture: 61 NAVs from 2025-01-06, benchmark from 1000 ===")
b_pat = [D("0.01"), D("-0.01"), D("0.02"), D("-0.02")]
e_pat = [D("0.002"), D("0.002"), D("-0.002"), D("-0.002")]
bdates = weekdays("2025-01-06", 61)
show("first_date", bdates[0])
show("last_date", bdates[-1])
bret = [b_pat[i % 4] for i in range(60)]
sret = [D("1.5") * bret[i] + D("0.0005") + e_pat[i % 4] for i in range(60)]
show("scheme_return_cycle", sret[:4])
y_daily = (D("1.0001") ** 252 - 1) * 100  # yield percent whose daily periodic rate is exactly 0.0001
show("yield_percent_for_rf_0.0001_daily", y_daily)
rf = D("0.0001")
ex = [s - rf for s in sret]
sd_ex = sample_sd(ex)
show("sd_excess", sd_ex)
show("mean_excess", mean(ex))
show("sharpe_periodic", mean(ex) / sd_ex)
show("sharpe_annualised_252", mean(ex) / sd_ex * D(252).sqrt())
dd = (sum((min(D(0), x) ** 2 for x in ex), D(0)) / D(len(ex))).sqrt()
show("downside_deviation_all_periods", dd)
show("sortino_periodic", mean(ex) / dd)
show("sortino_annualised_252", mean(ex) / dd * D(252).sqrt())
mb, ms = mean(bret), mean(sret)
cov = sum(((s - ms) * (b - mb) for s, b in zip(sret, bret)), D(0)) / D(59)
varb = sum(((b - mb) ** 2 for b in bret), D(0)) / D(59)
beta = cov / varb
show("beta", beta)
alpha_p = ms - (rf + beta * (mb - rf))
show("alpha_periodic", alpha_p)
show("alpha_annualised_arithmetic_x252", alpha_p * 252)
corr = cov / (sample_sd(sret) * sample_sd(bret))
show("correlation_scheme_vs_benchmark", corr)
show("closed_form_corr 0.0225/sqrt(0.03399*0.015)", D("0.0225") / (D("0.03399") * D("0.015")).sqrt())
show("closed_form_sd_scheme sqrt(0.03399/59)", (D("0.03399") / D(59)).sqrt())

print("\n--- B conversion hand checks: (1+y)^(1/N)-1 ---")
y_m = (D("1.01") ** 12 - 1) * 100
y_w = (D("1.002") ** 52 - 1) * 100
show("yield_percent_for_monthly_1pct", y_m)
show("yield_percent_for_weekly_0.2pct", y_w)
for y in ["7.3", "6.5", "6.25", "5.5199"]:
    yy = D(y) / 100
    show(f"y={y}%: daily(252)", (1 + yy) ** (D(1) / 252) - 1)
    show(f"y={y}%: weekly(52)", (1 + yy) ** (D(1) / 52) - 1)
    show(f"y={y}%: monthly(12)", (1 + yy) ** (D(1) / 12) - 1)

print("\n--- B series switch: same scheme returns, T-bill 6.5% vs repo 6.0% ---")
for label, y in [("tbill_6.5", D("6.5")), ("repo_6.0", D("6.0"))]:
    r = (1 + y / 100) ** (D(1) / 252) - 1
    exs = [s - r for s in sret]
    show(f"{label} rf_daily", r)
    show(f"{label} sharpe_periodic", mean(exs) / sample_sd(exs))
    show(f"{label} sharpe_annualised", mean(exs) / sample_sd(exs) * D(252).sqrt())
    ddx = (sum((min(D(0), x) ** 2 for x in exs), D(0)) / D(60)).sqrt()
    show(f"{label} sortino_annualised", mean(exs) / ddx * D(252).sqrt())
    a = ms - (r + beta * (mb - r))
    show(f"{label} alpha_annualised", a * 252)

print("\n--- B step function: 6.5% in force until the auction of 2025-02-12, 6.25% from it ---")
change = "2025-02-12"
rf_old = (D("1.065")) ** (D(1) / 252) - 1
rf_new = (D("1.0625")) ** (D(1) / 252) - 1
rfs = []
n_old = 0
for i in range(60):
    start = bdates[i]  # interval start
    use_new = start >= change
    rfs.append(rf_new if use_new else rf_old)
    n_old += 0 if use_new else 1
show("intervals_at_old_rate", n_old)
exs = [s - r for s, r in zip(sret, rfs)]
show("mean_excess_stepped", mean(exs))
show("sd_excess_stepped", sample_sd(exs))
show("sharpe_periodic_stepped", mean(exs) / sample_sd(exs))
show("rf_old", rf_old)
show("rf_new", rf_new)
show("mean_rf_stepped (alpha uses it)", mean(rfs))
a_step = ms - (mean(rfs) + beta * (mb - mean(rfs)))
show("alpha_periodic_stepped", a_step)

print("\n=== C user transactions: SIPs, partial redemption, ending units ===")
flows = [
    (d("2024-01-05"), D(-10000)),
    (d("2024-02-05"), D(-10000)),
    (d("2024-03-05"), D(-10000)),
    (d("2024-06-05"), D(11000)),
    (d("2025-01-05"), D(24600)),
]
show("units_bought: 10000/100, 10000/125, 10000/80", [D(10000) / 100, D(10000) / 125, D(10000) / 80])
show("units_after_redemption of 100 @110", D(100) + D(80) + D(125) - D(100))
show("terminal_value 205 x 120", D(205) * 120)
rate = xirr_bisect(flows)
show("xirr", rate)
span = (d("2025-01-05") - d("2024-01-05")).days
show("days_2024-01-05_to_2025-01-05", span)
show("scheme_cagr_100_to_120_over_those_days", (D(120) / 100) ** (DPY / D(span)) - 1)
show("scheme_absolute_100_to_120", D(120) / 100 - 1)
invested = D(30000)
show("gain_loss = value + received - invested", D(24600) + D(11000) - invested)

print("\n=== F boundary and gap fixture (values are exact ratios) ===")
show("p2p 2025-01-03 (102) -> 2025-02-25 (110): absolute", D(110) / D(102) - 1)
show("days 2025-01-03 -> 2025-02-25", (d("2025-02-25") - d("2025-01-03")).days)
show("long gap days 2025-01-10 -> 2025-02-25", (d("2025-02-25") - d("2025-01-10")).days)

print("\n=== A5 other frequencies, alternating +1% / -1% returns ===")
# weekly: 32 NAVs seven days apart -> 31 returns, +,-,+,... (16 positive, 15 negative)
wr = [D("0.01") if i % 2 == 0 else D("-0.01") for i in range(31)]
show("weekly_31_mean", mean(wr))
show("weekly_31_sample_sd", sample_sd(wr))
show("weekly_31_annualised_vol_sqrt52", sample_sd(wr) * D(52).sqrt())
# monthly: 8 NAVs (month-ends) -> 7 returns, +,-,+,-,+,-,+ (4 positive, 3 negative)
mr = [D("0.01") if i % 2 == 0 else D("-0.01") for i in range(7)]
show("monthly_7_mean", mean(mr))
show("monthly_7_sample_sd", sample_sd(mr))
show("monthly_7_annualised_vol_sqrt12", sample_sd(mr) * D(12).sqrt())
# daily, 40 returns (20 + / 20 -)
dr = [D("0.01") if i % 2 == 0 else D("-0.01") for i in range(40)]
show("daily_40_sample_sd", sample_sd(dr))
show("daily_40_closed_form sqrt(40e-4/39)", (D(40) * D("0.0001") / D(39)).sqrt())

print("\n=== D1 drawdown, spec worked example 3: 100, 120, 90, 108, 125 ===")
ex3 = [D(x) for x in [100, 120, 90, 108, 125]]
run, worst = ex3[0], D(0)
for v in ex3:
    run = max(run, v)
    worst = min(worst, v / run - 1)
show("mdd", worst)

print("\n=== B6 correlation on returns, not levels ===")
# A returns 0.01 + 0.005*c, B returns 0.01 - 0.005*c, c alternating +1/-1 over 60 returns
ra = [D("0.01") + D("0.005") * (1 if i % 2 == 0 else -1) for i in range(60)]
rb2 = [D("0.01") - D("0.005") * (1 if i % 2 == 0 else -1) for i in range(60)]
cov2 = sum(((a - mean(ra)) * (b - mean(rb2)) for a, b in zip(ra, rb2)), D(0)) / D(59)
show("returns_corr", cov2 / (sample_sd(ra) * sample_sd(rb2)))
la, lb = [D(100)], [D(100)]
for a, b in zip(ra, rb2):
    la.append(la[-1] * (1 + a))
    lb.append(lb[-1] * (1 + b))
covl = sum(((a - mean(la)) * (b - mean(lb)) for a, b in zip(la, lb)), D(0)) / D(60)
show("levels_corr (the WRONG measure, for the negative control)", covl / (sample_sd(la) * sample_sd(lb)))
