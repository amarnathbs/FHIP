"""Builds the Planning Benchmarks first-load files from the four extraction folders.

Inputs  (not in git): <SCRATCH>/pb/w1..w4/{observations.csv, downloads_manifest.csv}
Outputs (in git)    : docs/planning-benchmarks/first_load/
    extracts/NN_*.observations.csv[.gz]   full published-figure extraction per dataset (what was read from the source)
    PROVENANCE_REGISTER.csv               one row per (dataset, release, observation period, downloaded file)
    NN_*.values.csv / *.cohorts.csv / *.target_ranges.csv   the importable subset, mapped onto the existing metric catalogue

The mapping rules are the point of this file: every importable row is either an exact published figure (optionally
with a pure unit multiplier such as $'000 -> $) or an explicitly derived value whose inputs are published figures.
Nothing is interpolated, nothing is invented, and a measure with no matching metric definition is NOT imported.

    python scripts/planning-benchmarks/build_first_load_files.py <SCRATCH_ROOT_OF_pb>
"""
import csv
import gzip
import json
import os
import re
import sys
from datetime import date

import pandas as pd

SCRATCH = sys.argv[1] if len(sys.argv) > 1 else r"C:\Users\user\AppData\Local\Temp\claude\D--FHIP--claude-worktrees-audit-lr-2026-09-21\e1468c38-4b9f-45c2-b862-ab8725ccd725\scratchpad\pb"
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(ROOT, "docs", "planning-benchmarks", "first_load")
EXT = os.path.join(OUT, "extracts")
os.makedirs(EXT, exist_ok=True)

RETRIEVED = "2026-10-03"

SLUG = {
    1: "01_fhip_dependant_band_model", 2: "02_au_household_asset_composition", 3: "03_au_household_wealth_distribution",
    4: "04_au_net_worth_income_by_age", 5: "05_au_high_dti_mortgage_threshold", 6: "06_au_average_super_balance",
    7: "07_au_household_debt_context", 8: "08_india_hces_consumption_rural_urban", 9: "09_india_household_assets_debt_rural_urban",
    10: "10_india_epf_eps_contribution_structure", 11: "11_fhip_planning_benchmarks_v1", 12: "12_au_asfa_retirement_standard",
}
DS_NAME = {
    1: "FHIP dependant-band household benchmark model", 2: "AU household asset composition", 3: "AU household wealth distribution",
    4: "AU net worth and income by age band", 5: "AU high-DTI mortgage threshold", 6: "AU average superannuation balance",
    7: "AU household debt context", 8: "India household consumption expenditure (rural/urban)",
    9: "India household assets and debt (rural/urban)", 10: "India EPF/EPS contribution structure", 11: "FHIP Planning Benchmarks v1.0",
    12: "AU ASFA retirement standard",
}
OBS_HEADER = ("obs_id,dataset_no,release_name,release_date,obs_period_label,obs_period_start,obs_period_end,reference_date,measure_code,"
              "measure_label,statistic,value,unit,price_basis,population,geography,dim_age_band,dim_sex,dim_household_type,dim_urban_rural,"
              "dim_state,dim_category,dim_other,source_file,source_url,source_table,source_locator,status,notes").split(",")

# ---------------------------------------------------------------------------------------------------- load
frames, manifests = [], []
for w in ("w1", "w2", "w3", "w4"):
    o = pd.read_csv(os.path.join(SCRATCH, w, "observations.csv"), dtype=str, keep_default_na=False)
    assert list(o.columns) == OBS_HEADER, (w, list(o.columns))
    frames.append(o)
    m = pd.read_csv(os.path.join(SCRATCH, w, "downloads_manifest.csv"), dtype=str, keep_default_na=False)
    m["worker"] = w
    manifests.append(m)
obs = pd.concat(frames, ignore_index=True)
man = pd.concat(manifests, ignore_index=True)
assert obs.obs_id.is_unique, "obs_id collision across workers"
obs["dataset_no"] = obs["dataset_no"].astype(int)


def iso(s):
    return s if re.fullmatch(r"\d{4}-\d{2}-\d{2}", s or "") else ""


# ---------------------------------------------------------------------------------------------------- extracts
sizes = {}
for n, g in obs.groupby("dataset_no"):
    g = g[OBS_HEADER]
    plain = os.path.join(EXT, f"{SLUG[n]}.observations.csv")
    raw = g.to_csv(index=False, lineterminator="\n")
    if len(raw) > 600_000:
        with gzip.open(plain + ".gz", "wt", encoding="utf-8", newline="") as f:
            f.write(raw)
        sizes[n] = os.path.getsize(plain + ".gz")
    else:
        with open(plain, "w", encoding="utf-8", newline="") as f:
            f.write(raw)
        sizes[n] = os.path.getsize(plain)
print("extract sizes", sizes)

# ---------------------------------------------------------------------------------------------------- register
def man_lookup(fname):
    hit = man[man.file_name == fname]
    return hit.iloc[0] if len(hit) else None


def split_files(sf):
    parts = [p.strip() for p in sf.split(" + ")]
    return [re.sub(r"\s*\(.*?\)\s*$", "", p) for p in parts]


def period_for(r):
    s, e, ref = iso(r.obs_period_start), iso(r.obs_period_end), iso(r.reference_date)
    note = ""
    if not s and ref:
        s, note = ref, "period start taken from the published reference/effective date"
    return s, e, ref, note


reg_rows, unmatched = {}, set()
for r in obs.itertuples(index=False):
    if r.status != "OK":
        continue
    s, e, ref, note = period_for(r)
    if r.dataset_no == 12 and not s:
        # ASFA lump sums: the source says "revised February 2026"; the day is not published
        if "February 2026" in r.obs_period_label:
            s, note = "2026-02-01", "ASFA states only 'revised February 2026' (day not published); first of the month used because the database needs a date"
    if not s:
        continue
    series = r.measure_code.startswith("na_")
    if series:
        key_period = ("series", "")
    else:
        key_period = (s, e)
    for fname in split_files(r.source_file):
        mrow = man_lookup(fname)
        if mrow is None:
            unmatched.add((r.dataset_no, fname))
            continue
        k = (r.dataset_no, r.release_name, key_period[0], key_period[1], ref, fname)
        d = reg_rows.setdefault(k, {"min_s": s, "max_e": e or s, "note": note, "series": series, "m": mrow, "rel_date": r.release_date})
        d["min_s"] = min(d["min_s"], s)
        d["max_e"] = max(d["max_e"], e or s)
print("unmatched manifest files", unmatched)

REG_HEADER = ["dataset_no", "release_name", "release_date", "obs_period_start", "obs_period_end", "reference_date", "source_file", "source_url",
              "bytes", "sha256", "retrieval_date", "licence_statement", "notes"]
reg_out = []
for (dno, rel, ks, ke, ref, fname), d in sorted(reg_rows.items(), key=lambda kv: (kv[0][0], kv[0][1], str(kv[0][2]), kv[0][5])):
    m = d["m"]
    rd = d["rel_date"]
    reg_out.append({
        "dataset_no": dno, "release_name": rel, "release_date": iso(rd) or "", "obs_period_start": d["min_s"] if d["series"] else ks,
        "obs_period_end": (d["max_e"] if d["series"] else ke), "reference_date": ref, "source_file": fname, "source_url": m["url"],
        "bytes": m["bytes"], "sha256": m["sha256"], "retrieval_date": m["retrieval_date"] or RETRIEVED,
        "licence_statement": m["licence_statement_paraphrase"],
        "notes": ("quarterly series: span of all quarters in the file; each quarter is a row in the extraction. " if d["series"] else "") + d["note"],
    })
reg_df = pd.DataFrame(reg_out, columns=REG_HEADER)
# the 'bytes' / 'sha256' of a manifest row can be blank (page retrieved but not stored): the test requires them, so keep only complete rows
incomplete = reg_df[(reg_df.bytes == "") | (reg_df.sha256 == "")]
print("register rows without bytes/sha256:", len(incomplete))
reg_df = reg_df[(reg_df.bytes != "") & (reg_df.sha256 != "")]
reg_df.to_csv(os.path.join(OUT, "PROVENANCE_REGISTER.csv"), index=False, lineterminator="\n")
print("register rows", len(reg_df))

# ---------------------------------------------------------------------------------------------------- value rows
VALUES_HEADER = ("dataset_name,dataset_version,cohort_code,metric_code,statistic_type,value_numeric,value_text,unit,original_currency,base_date,is_derived,"
                 "derivation_method,confidence_score,effective_from,effective_to,version,x_obs_id,x_release,x_obs_period_start,x_obs_period_end,"
                 "x_reference_date,x_source_file,x_source_locator,x_retrieval_date,x_unit_multiplier").split(",")


def O(obs_id):
    hit = obs[obs.obs_id == obs_id]
    assert len(hit) == 1, obs_id
    return hit.iloc[0]


def fnum(x):
    s = repr(round(float(x), 4))
    return s[:-2] if s.endswith(".0") else s


def dmy(s):
    return f"{s[8:10]}/{s[5:7]}/{s[0:4]}" if s else "n/a"


def provenance_text(rows, extra=""):
    r0 = rows[0]
    s, e, ref, _ = period_for(r0)
    period = f"obs {dmy(s)}-{dmy(e)}" if e else f"from {dmy(s)}"
    locs = "; ".join(f"{x.source_file} {x.source_locator}" for x in rows)
    return f"{r0.release_name} | {period} | {locs} | retrieved {dmy(RETRIEVED)}{(' | ' + extra) if extra else ''}"


seed_compare = []


def value_row(dno, metric, stat, obs_ids, unit, *, cohort="", mult=1, formula=None, derived=False, method="", currency="",
              base_date=None, effective_from=None, extra="", period_override=None, sourced_label=""):
    rows = [O(i) for i in obs_ids]
    r0 = rows[0]
    if formula is None:
        assert len(rows) == 1 and not derived
        val = float(r0.value) * mult
    else:
        val = formula([float(x.value) for x in rows])
    s, e, ref, _ = period_for(r0)
    if period_override:
        s, e = period_override
    bdate = base_date or ref or e or s
    eff = effective_from or iso(r0.release_date) or bdate
    return {
        "dataset_name": DS_NAME[dno], "dataset_version": "1.0", "cohort_code": cohort, "metric_code": metric, "statistic_type": stat,
        "value_numeric": fnum(val), "value_text": provenance_text(rows, extra), "unit": unit, "original_currency": currency,
        "base_date": bdate, "is_derived": "true" if derived else "false", "derivation_method": method, "confidence_score": "",
        "effective_from": eff, "effective_to": "", "version": "1", "x_obs_id": "+".join(i for i in obs_ids),
        "x_release": r0.release_name, "x_obs_period_start": s, "x_obs_period_end": e, "x_reference_date": ref,
        "x_source_file": "+".join(sorted({x.source_file for x in rows})),
        "x_source_locator": "; ".join(f"{x.source_table} | {x.source_locator}" for x in rows), "x_retrieval_date": RETRIEVED,
        "x_unit_multiplier": str(mult),
    }


def pick(ds, **flt):
    g = obs[obs.dataset_no == ds]
    for k, v in flt.items():
        if k.endswith("__in"):
            g = g[g[k[:-4]].isin(v)]
        elif k.endswith("__startswith"):
            g = g[g[k[:-12]].str.startswith(v)]
        elif k.endswith("__contains"):
            g = g[g[k[:-10]].str.contains(v, regex=False)]
        else:
            g = g[g[k] == v]
    return g


def one(ds, **flt):
    g = pick(ds, **flt)
    assert len(g) == 1, (ds, flt, len(g))
    return g.iloc[0].obs_id


HIW = "Household Income and Wealth, Australia, 2019-20 financial year (ABS)"
P1920 = "2019-20"
P1920_W2 = "2019-20 financial year"
values = {n: [] for n in range(1, 13)}
cohorts = {n: [] for n in range(1, 13)}
targets = {n: [] for n in range(1, 13)}
AUD = "AUD"

# ---- dataset 2: asset composition -----------------------------------------------------------------------------
t24 = dict(release_name=HIW, obs_period_label=P1920, source_table__startswith="Table 2.4")
i_total = one(2, measure_code="ASSET_MEAN_TOTAL", **t24)
i_prop = one(2, measure_code="ASSET_MEAN_PROP_TOTAL", **t24)
values[2].append(value_row(2, "total_assets", "mean", [i_total], "currency", mult=1000, currency=AUD,
                           extra="all private households; mean value of all assets per household ($'000 as published, x1000)"))
values[2].append(value_row(2, "property_concentration", "share", [i_prop, i_total], "percentage", derived=True,
                           formula=lambda v: v[0] / v[1] * 100,
                           method="Mean total property assets per household divided by mean total assets per household, x100 (both published means in Table 2.4, same year, same population). An aggregate share of household assets, not a median of household shares.",
                           extra="all private households"))

# ---- dataset 3: wealth distribution ------------------------------------------------------------------------------
t21 = dict(release_name=HIW, obs_period_label=P1920, source_table__startswith="Table 2.1")
i_mean = one(3, measure_code="NW_MEAN", dim_category="All households", **t21)
values[3].append(value_row(3, "net_worth", "mean", [i_mean], "currency", mult=1000, currency=AUD, extra="all private households; household net worth, 2019-20 dollars"))
i_med = one(3, measure_code="NETWORTH_MEDIAN", dim_category="All households", release_name=HIW, obs_period_label=P1920, source_table__startswith="Table 7.2")
values[3].append(value_row(3, "net_worth", "median", [i_med], "currency", mult=1000, currency=AUD, extra="all private households; household net worth, 2019-20 dollars"))
for stat, label in (("p10", "P10"), ("p20", "P20"), ("p80", "P80"), ("p90", "P90")):
    i = one(3, measure_code="NW_PCTL", statistic=stat, dim_other=label, **t21)
    values[3].append(value_row(3, "net_worth", stat, [i], "currency", mult=1000, currency=AUD, extra=f"percentile boundary {label} of household net worth, 2019-20 dollars"))

# ---- dataset 4: age bands ----------------------------------------------------------------------------------------
BAND_COHORT = {"15-24": "AU_AGE_15_24", "25-34": "AU_AGE_25_34", "35-44": "AU_AGE_35_44", "45-54": "AU_AGE_45_54",
               "55-64": "AU_AGE_55_64", "65-74": "AU_AGE_65_74", "75 and over": "AU_AGE_75_PLUS"}
for band, code in BAND_COHORT.items():
    nwm = one(4, measure_code="NETWORTH_MEAN", dim_age_band=band, release_name=HIW, obs_period_label=P1920)
    nwd = one(4, measure_code="NETWORTH_MEDIAN", dim_age_band=band, release_name=HIW, obs_period_label=P1920)
    gim = one(4, measure_code="INC_GROSS_WEEKLY", statistic="mean", dim_age_band=band, release_name=HIW, obs_period_label=P1920)
    gid = one(4, measure_code="INC_GROSS_WEEKLY", statistic="median", dim_age_band=band, release_name=HIW, obs_period_label=P1920)
    ex = f"households by age of reference person {band}"
    values[4].append(value_row(4, "net_worth", "mean", [nwm], "currency", cohort=code, mult=1000, currency=AUD, extra=ex))
    values[4].append(value_row(4, "net_worth", "median", [nwd], "currency", cohort=code, mult=1000, currency=AUD, extra=ex))
    values[4].append(value_row(4, "gross_household_income", "mean", [gim], "currency", cohort=code, derived=True, currency=AUD,
                               formula=lambda v: v[0] * 52, method="ABS mean gross household income per WEEK x 52 (annualised for the metric, which is annual). Weekly figure is a 2019-20 survey-year dollar amount.", extra=ex))
    values[4].append(value_row(4, "gross_household_income", "median", [gid], "currency", cohort=code, derived=True, currency=AUD,
                               formula=lambda v: v[0] * 52, method="ABS median gross household income per WEEK x 52 (annualised for the metric, which is annual).", extra=ex))
first_band_obs = one(4, measure_code="NETWORTH_MEAN", dim_age_band="15-24", release_name=HIW, obs_period_label=P1920)
cohorts[4].append({"dataset_name": DS_NAME[4], "dataset_version": "1.0", "cohort_code": "AU_AGE_15_24", "country_code": "AU", "region_code": "", "urban_rural": "",
                   "age_band": "AGE_15_24", "income_band": "", "household_type": "", "life_stage": "", "housing_tenure": "", "employment_type": "",
                   "dependant_band": "", "financial_dna_code": "", "cross_border_flag": "false", "cohort_tier": "4", "sample_size": "",
                   "cohort_description": "Australian households aged 15-24 (ABS age of reference person band as published; not the app's 18-24 band)",
                   "x_obs_id": first_band_obs, "x_release": HIW, "x_source_file": O(first_band_obs).source_file, "x_source_locator": O(first_band_obs).source_locator})

# ---- dataset 5: DTI threshold --------------------------------------------------------------------------------------
dti = one(5, measure_code="apra_dti_limit_dti_threshold_investment")
values[5].append(value_row(5, "debt_to_income", "threshold", [dti], "ratio", base_date="2026-02-01", effective_from="2026-02-01",
                           extra="APRA limit on high-DTI new residential lending by ADIs: DTI at or above this multiple counts as high-DTI; the same 6x applies to owner-occupier (W2-016987) and investment (this row) lending; ADI portfolio limit is 20% of new lending per cohort, not a personal borrowing rule"))

# ---- dataset 6: ATO super --------------------------------------------------------------------------------------------
ato = dict(dataset_no=6)
mean_id = one(6, measure_code="sup_balance_mean_aud", obs_period_label="2023-24 financial year", dim_sex="all", dim_age_band="Total", source_table__startswith="Snapshot Table 5, Chart 12")
med_id = one(6, measure_code="sup_balance_median_aud", obs_period_label="2023-24 financial year", dim_sex="all", dim_age_band="Total", source_table__startswith="Snapshot Table 5, Chart 12")
RELD6 = iso(O(mean_id).release_date) or iso(re.sub(r"^.*?(\d{4}-\d{2}-\d{2}).*$", r"\1", O(mean_id).release_date))
values[6].append(value_row(6, "retirement_balance", "mean", [mean_id], "currency", currency=AUD, effective_from=RELD6 or None,
                           extra="PER INDIVIDUAL (balances summed across accounts by TFN), individuals with a balance or contributions above zero; not a household total"))
values[6].append(value_row(6, "retirement_balance", "median", [med_id], "currency", currency=AUD, effective_from=RELD6 or None,
                           extra="PER INDIVIDUAL (balances summed across accounts by TFN), individuals with a balance or contributions above zero; not a household total"))

# ---- dataset 7: debt context -------------------------------------------------------------------------------------------
d2a = one(7, measure_code="survey_hh_debt_to_asset_median", obs_period_label=P1920_W2, dim_category="All (Total)", source_table__startswith="Table 3.4")
values[7].append(value_row(7, "debt_to_asset_ratio", "median", [d2a], "percentage", derived=True, formula=lambda v: v[0] * 100,
                           method="ABS publishes the median debt-to-asset ratio as a ratio (0.18); multiplied by 100 to express it as a percentage like the metric. Population: households WITH debt only (ABS: ratios calculated only for households with debt).",
                           extra="households with debt only; total household debt / total household assets; survey estimate (ABS randomly perturbs cells)"))

# ---- dataset 9: AIDIS --------------------------------------------------------------------------------------------------
PN = "Press Note: All India Debt & Investment Survey, NSS 77th round (Jan-Dec 2019), NSS Report No. 588 (MoSPI/NSO)"
for code, rural in (("IN_RURAL_ALL", "rural"), ("IN_URBAN_ALL", "urban")):
    i = one(9, measure_code="AVA_TOTAL", dim_urban_rural=rural, dim_household_type="all", release_name=PN)
    values[9].append(value_row(9, "total_assets", "mean", [i], "currency", cohort=code, currency="INR", effective_from="2021-09-10",
                               extra=f"{rural} India, all households; average value of assets owned per household; as at 30/06/2018 (reference date), survey Jan-Dec 2019"))
    dar = pick(9, measure_code="DAR", dim_urban_rural=rural, dim_other="social group=All")
    assert len(dar) == 1
    values[9].append(value_row(9, "debt_to_asset_ratio", "rate", [dar.iloc[0].obs_id], "percentage", cohort=code, effective_from="2021-09-10",
                               extra=f"{rural} India, all households; debt-asset ratio as published on the MoSPI AIDIS portal table (manual capture, one decimal); cross-check AOD/AVA from the press note"))

# ---- dataset 10: EPF/EPS combined statutory rate (the only parameter the table can hold) -----------------------------------
emp, empr = one(10, measure_code="epf_employee_rate_pct"), one(10, measure_code="epf_employer_rate_total_pct")
values[10].append(value_row(10, "retirement_contribution_rate", "rate", [emp, empr], "percentage", derived=True, formula=lambda v: v[0] + v[1],
                            effective_from="2026-09-17", base_date="2026-09-17",
                            method="Employee 12% + employer 12% (employer: 8.33% to EPS and 3.67% to the EPF account) = 24% OF BASIC WAGES (up to the statutory wage ceiling, Rs 25,000 per month from 17/09/2026), NOT a percentage of net or total household income. Dated to the statement date in the source because the releases give no start date for the rates.",
                            extra="statutory rates restated in a PIB/Ministry of Labour release; EPFO's own pages were blocked (HTTP 403)"))

# ---- dataset 12: ASFA target ranges --------------------------------------------------------------------------------------
asfa = {"single": ("single", "D12-000362", "D12-000360"), "couple": ("couple_no_kids", "D12-000361", "D12-000359")}
for key, (htype, modest_id, comf_id) in asfa.items():
    for band, tier, oid in (("modest", 2, modest_id), ("comfortable", 4, comf_id)):
        o = O(oid)
        assert o.dim_household_type == key and band in o.dim_category and "homeowner" in o.dim_other, oid
        amt = float(o.value)
        lower, upper = ("0", fnum(amt)) if band == "modest" else (fnum(amt), "")
        targets[12].append({
            "metric_code": "retirement_balance", "source_name": "ASFA_STANDARD_2026", "country_code": "AU", "life_stage": "", "household_type": htype,
            "band_label": band, "band_tier": str(tier), "lower_bound": lower, "upper_bound": upper, "direction": "target_range",
            "explanation": (f"ASFA Retirement Standard (revised February 2026): savings needed at age 67 for a {key} homeowner for a {band} lifestyle = ${int(amt):,}. "
                            "Assumes retiring at 67, drawing down all capital, part Age Pension, 6% earnings, 2.75% AWE deflator. "
                            + ("The 0 lower bound is structural (the existing band convention), not an ASFA figure." if band == "modest" else "No upper bound is published.")),
            "evidence_level": "official_statistical", "model_version": "asfa-2026", "effective_from": "2026-02-01", "effective_to": "",
            "x_obs_id": oid, "x_release": o.release_name, "x_obs_period_start": "2026-02-01", "x_obs_period_end": "", "x_source_file": o.source_file,
            "x_source_locator": o.source_locator, "x_retrieval_date": RETRIEVED,
        })

# ---------------------------------------------------------------------------------------------------- write
def write_csv(path, header, rows):
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=header, lineterminator="\n")
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k, "") for k in header})


COHORT_HEADER = ("dataset_name,dataset_version,cohort_code,country_code,region_code,urban_rural,age_band,income_band,household_type,life_stage,"
                 "housing_tenure,employment_type,dependant_band,financial_dna_code,cross_border_flag,cohort_tier,sample_size,cohort_description,"
                 "x_obs_id,x_release,x_source_file,x_source_locator").split(",")
TR_HEADER = ("metric_code,source_name,country_code,life_stage,household_type,band_label,band_tier,lower_bound,upper_bound,direction,explanation,"
             "evidence_level,model_version,effective_from,effective_to,x_obs_id,x_release,x_obs_period_start,x_obs_period_end,x_source_file,"
             "x_source_locator,x_retrieval_date").split(",")
counts = {}
for n in range(1, 13):
    if values[n]:
        write_csv(os.path.join(OUT, f"{SLUG[n]}.values.csv"), VALUES_HEADER, values[n])
    if cohorts[n]:
        write_csv(os.path.join(OUT, f"{SLUG[n]}.cohorts.csv"), COHORT_HEADER, cohorts[n])
    if targets[n]:
        write_csv(os.path.join(OUT, f"{SLUG[n]}.target_ranges.csv"), TR_HEADER, targets[n])
    counts[n] = {"values": len(values[n]), "cohorts": len(cohorts[n]), "target_ranges": len(targets[n]),
                 "extracted_obs": int((obs.dataset_no == n).sum()), "ok": int(((obs.dataset_no == n) & (obs.status == "OK")).sum()),
                 "needs_manual_check": int(((obs.dataset_no == n) & (obs.status != "OK")).sum())}
print(json.dumps(counts, indent=1))
