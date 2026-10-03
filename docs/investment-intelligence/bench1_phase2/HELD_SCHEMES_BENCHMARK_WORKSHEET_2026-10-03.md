# Held schemes: which benchmark applies (worksheet for the Product Owner)

Prepared 3 October 2026. **Nothing in the factsheet column has been guessed.** Since the PO decision of 3 October 2026, a fund with no declared benchmark is compared, automatically and without any approval step, with **the usual benchmark for its fund category**, and every screen says so. This sheet shows, for each held scheme, which category benchmark will apply (or that none applies), and keeps an **optional** column for the benchmark copied from the fund's own factsheet. A declared benchmark, once entered and approved, always replaces the category one.

## Read this first

* The category table behind this sheet is **UNVERIFIED**: AMFI's own list of benchmarks per category could not be read from this environment. Each row names a series that exists in the seeded catalogue; the choice of series per category is a judgement (see the table at the end, with the rows I am least sure about marked).
* **A benchmark name appearing does not mean a return figure appears.** A figure needs the catalogue entry to be verified, the series to be total return, an approved right to display it, and index history covering the holding period. Until the licence exists, users see the benchmark **name** and "Benchmark data not available", no number.
* Wording shown to users for a category benchmark: "Compared with the usual benchmark for <category> funds (not this fund's own declared benchmark)". For a declared one: "Fund's declared benchmark".

## Where these 19 come from

The 19 held instruments in the **1 October 2026 read-only production inventory** (`inventory/inventory_prod.json`). It has the same count (19) as the 3 October production query and includes the five names quoted from it, but I could not see that query, so confirm the two lists agree. Names are as the statements print them; the registrar code prefix and "(Non-Demat)" are removed from the cleaned name for readability only. A scheme held since 1 October will appear in the admin list but not here.

## Worksheet

| # | Fund house | Scheme (cleaned) | As printed on the statement | AMFI code | Plan | AMFI category | Benchmark that will apply automatically (unverified category table) | Optional: benchmark copied from the factsheet ("Benchmark" / "Tier-1 benchmark") | TRI stated? | Document web address | Document date |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Aditya Birla Sun Life | Aditya Birla Sun Life Large Cap Fund -Growth-Regular Plan(formerly known as Aditya Birla Sun Life Frontline Equity Fund) | B92-Aditya Birla Sun Life Large Cap Fund -Growth-Regular Plan(formerly known as Aditya Birla Sun Life Frontline Equity Fund) (Non-Demat) | 103174 | Regular | Large Cap Fund | NIFTY 100 TRI (Large Cap funds) | | | | |
| 2 | Axis | Axis Large Cap Fund - Regular Growth | 128EFGPG-Axis Large Cap Fund - Regular Growth (Non Demat) | 112277 | Regular | Large Cap Fund | NIFTY 100 TRI (Large Cap funds) | | | | |
| 3 | Franklin Templeton | Franklin India Flexi Cap Fund - Growth (erstwhile Franklin India Equity Fund) | FTI037-Franklin India Flexi Cap Fund - Growth (erstwhile Franklin India Equity Fund) (Non-Demat) | 100520 | Not stated in the name (AMFI file: Regular) | Flexi Cap Fund | Nifty 500 TRI (Flexi Cap funds) | | | | |
| 4 | Franklin Templeton | Franklin India Mid Cap FUND - Growth (erstwhile Franklin India PRIMA FUND - Growth) | FTI036-Franklin India Mid Cap FUND - Growth (erstwhile Franklin India PRIMA FUND - Growth) (Non-Demat) | 100473 | Not stated in the name (AMFI file: Regular) | Mid Cap Fund | Nifty Midcap 150 TRI (Mid Cap funds) | | | | |
| 5 | HDFC | HDFC Balanced Advantage Fund - Regular Plan - Growth (formerly HDFC Growth Fund, erstwhile HDFC Prudence Fund merged) | HGFG-HDFC Balanced Advantage Fund - Regular Plan - Growth (formerly HDFC Growth Fund, erstwhile HDFC Prudence Fund merged) (Non -Demat) | 100119 | Regular | Dynamic Asset Allocation or Balanced Advantage | NIFTY 50 Hybrid Composite Debt 50:50 Index TRI (Balanced Advantage funds; less certain choice) | | | | |
| 6 | HDFC | HDFC Flexi Cap Fund - Regular Plan - Growth | H02-HDFC Flexi Cap Fund - Regular Plan - Growth (Non-Demat) | 101762 | Regular | Flexi Cap Fund | Nifty 500 TRI (Flexi Cap funds) | | | | |
| 7 | HDFC | HDFC Gold ETF Fund of Fund - Regular Plan - Growth | HGFOF-HDFC Gold ETF Fund of Fund - Regular Plan - Growth (Non-Demat) | 115934 | Regular | FoF Domestic | None: Benchmark not available for this fund category (FoF Domestic). | | | | |
| 8 | HDFC | HDFC Large Cap Fund - Direct Plan - Growth Option (formerly HDFC Top 100 Fund) | H44T-HDFC Large Cap Fund - Direct Plan - Growth Option (formerly HDFC Top 100 Fund) (Non-Demat) | 119018 | Direct | Large Cap Fund | NIFTY 100 TRI (Large Cap funds) | | | | |
| 9 | HDFC | HDFC Large Cap Fund - Regular Plan - Growth (formerly HDFC Top 100 Fund) | H44-HDFC Large Cap Fund - Regular Plan - Growth (formerly HDFC Top 100 Fund) (Non-Demat) | 102000 | Regular | Large Cap Fund | NIFTY 100 TRI (Large Cap funds) | | | | |
| 10 | HDFC | HDFC Mid Cap Fund - Regular Plan - Growth | HMCOG-HDFC Mid Cap Fund - Regular Plan - Growth (Non-Demat) | 105758 | Regular | Mid Cap Fund | Nifty Midcap 150 TRI (Mid Cap funds) | | | | |
| 11 | HDFC | HDFC Small Cap Fund - Regular Plan - Growth Plan | HACGPG-HDFC Small Cap Fund - Regular Plan - Growth Plan (Non-Demat) | 130502 | Regular | Small Cap Fund | BSE 250 SmallCap TRI (Small Cap funds; less certain choice) | | | | |
| 12 | ICICI Prudential | ICICI Prudential Dividend Yield Fund Growth | P2373-ICICI Prudential Dividend Yield Fund Growth (Non-Demat) | 129310 | Not stated in the name (AMFI file: Regular) | Dividend Yield Fund | None: Benchmark not available for this fund category (Dividend Yield Fund). | | | | |
| 13 | Kotak Mahindra | Kotak Mid Cap Fund Regular Growth | K123-Kotak Mid Cap Fund Regular Growth (Non-Demat) | 104908 | Regular | Mid Cap Fund | Nifty Midcap 150 TRI (Mid Cap funds) | | | | |
| 14 | Nippon India | NIPPON INDIA POWER & INFRA FUND - GROWTH PLAN - GROWTH OPTION | RMFPSGPG-NIPPON INDIA POWER & INFRA FUND - GROWTH PLAN - GROWTH OPTION (Non Demat) | 101262 | Not stated in the name (AMFI file: Regular) | Sectoral Fund | Nifty Infrastructure TRI (Infrastructure funds; less certain choice) | | | | |
| 15 | PPFAS | Parag Parikh Flexi Cap Fund | Parag Parikh Flexi Cap Fund | 122639 | Not stated in the name (AMFI file: Direct) | Flexi Cap Fund | Nifty 500 TRI (Flexi Cap funds) | | | | |
| 16 | SBI | SBI Contra Fund - Regular Plan - Growth | L036G-SBI Contra Fund - Regular Plan - Growth (Non-Demat) | 102414 | Regular | Contra Fund | Nifty 500 TRI (Contra funds; less certain choice) | | | | |
| 17 | SBI | SBI Large Cap Fund | SBI Large Cap Fund | 103504 | Not stated in the name (AMFI file: Regular) | Large Cap Fund | NIFTY 100 TRI (Large Cap funds) | | | | |
| 18 | SBI | SBI Multi Asset Allocation Fund Regular Growth (formerly SBI Magnum Monthly Income Plan Floater) | L101G-SBI Multi Asset Allocation Fund Regular Growth (formerly SBI Magnum Monthly Income Plan Floater) (Non-Demat) | 103408 | Regular | Multi Asset Allocation | None: Benchmark not available for this fund category (Multi Asset Allocation). | | | | |
| 19 | UTI | UTI MNC Fund - Regular Plan | 108MFGPG-UTI MNC Fund - Regular Plan (Non Demat) | 100740 | Regular | Sectoral/ Thematic | Nifty MNC TRI (MNC funds; less certain choice) | | | | |

**16 of 19** held schemes get a category benchmark automatically; the other 3 show "benchmark not available for this fund category" until a declared benchmark is entered (and even then only where the series exists).

## The full category table (so you can eyeball it)

| Category | Series (catalogue key) | Benchmark name | Why / how sure |
|---|---|---|---|
| Large Cap | IN_NIFTY_100_TRI | NIFTY 100 TRI | The SEBI Tier-1 norm for large cap is NIFTY 100 or BSE 100; NIFTY 100 TRI is the seeded series most held large-cap funds declare. |
| Mid Cap | IN_NIFTY_MIDCAP_150_TRI | Nifty Midcap 150 TRI | The usual mid-cap Tier-1 index; all three held mid-cap funds declare it. |
| Small Cap (less certain) | IN_BSE_250_SMALLCAP_TRI | BSE 250 SmallCap TRI | PO choice. The category norm may equally be Nifty Smallcap 250 TRI, which is not in the seeded catalogue. |
| Large and Mid Cap | IN_NIFTY_LARGEMIDCAP_250_TRI | Nifty LargeMidcap 250 TRI | The usual Tier-1 index for large and mid cap funds. |
| Flexi Cap | IN_NIFTY_500_TRI | Nifty 500 TRI | Broad all-cap index; the usual flexi-cap Tier-1 choice (BSE 500 is the alternative). |
| Multi Cap (less certain) | IN_NIFTY_500_TRI | Nifty 500 TRI | PO choice. The category norm is the Nifty500 Multicap 50:25:25 index, which is not in the seeded catalogue; Nifty 500 is the nearest broad series. |
| ELSS | IN_NIFTY_500_TRI | Nifty 500 TRI | Tax-saving funds are diversified equity; Nifty 500 (or BSE 500) is the usual Tier-1 choice. |
| Focused (less certain) | IN_NIFTY_500_TRI | Nifty 500 TRI | PO choice: broad all-cap index. Individual focused funds declare different indices. |
| Value (less certain) | IN_NIFTY_500_TRI | Nifty 500 TRI | PO choice: broad all-cap index. Value funds often declare a style index instead. |
| Contra (less certain) | IN_NIFTY_500_TRI | Nifty 500 TRI | PO choice: broad all-cap index. The held contra fund declares BSE 500 TRI, a different owner's equivalent. |
| Balanced Advantage (less certain) | IN_NIFTY50_HYBRID_COMP_DEBT_5050_TRI | NIFTY 50 Hybrid Composite Debt 50:50 Index TRI | PO choice. Balanced advantage funds usually declare this index, but some declare their own composite. |
| Aggressive Hybrid (less certain) | IN_NIFTY50_HYBRID_COMP_DEBT_5050_TRI | NIFTY 50 Hybrid Composite Debt 50:50 Index TRI | PO choice. UNSURE: the usual aggressive-hybrid norm is a 65:35 equity-debt composite, not 50:50. |
| Corporate Bond (less certain) | IN_NIFTY_CORPORATE_BOND_A2_TRI | NIFTY Corporate Bond Index A-II TRI | The seeded debt series; corporate bond funds commonly use the NIFTY Corporate Bond Index (A-II or A-III by risk class). |
| Infrastructure (less certain) | IN_NIFTY_INFRASTRUCTURE_TRI | Nifty Infrastructure TRI | Applied to a sectoral fund whose NAME says infrastructure or power. A category list gives no single index for sectoral funds, so this rests on the name. |
| MNC (less certain) | IN_NIFTY_MNC_TRI | Nifty MNC TRI | Applied to a thematic fund whose NAME says MNC. Rests on the name. |

Categories that deliberately get **no** category benchmark: Gold / silver fund of funds; Multi asset allocation; International / overseas funds; Index funds and ETFs; Liquid, overnight, money market and other debt categories (other than corporate bond); Gilt; Dividend yield; Other sectoral and thematic funds; Solution-oriented (retirement, children); Conservative and other hybrid categories.

## Known cautions

* A scheme's benchmark can change over time (a notice-cum-addendum announces it). If you enter a declared benchmark, note the **date it took effect**; a holding that spans the change is compared against each benchmark for its own period.
* Multi-asset and gold fund-of-funds schemes usually declare a blend or a gold price; those cannot be mapped to one index yet, so they stay "not available".
* Whether copying a benchmark name and date from a public factsheet is acceptable under each fund house's site terms has not been checked; a question for counsel.
* A third-party dataset the PO mentioned (`mutual_fund_data.csv`, with fields such as Scheme_Category, Launch_Date, Closure_Date, Scheme_Min_Amt, Average_AUM_Cr) has **no benchmark column**, so it cannot supply a benchmark. Nothing here depends on it; its Launch_Date could later help as a floor for how far back index history is needed.

