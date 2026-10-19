# Risk-free first load: provenance of the two CSV files

Prepared 03-10-2026, updated the same day with the 01-07-2026 to 30-09-2026 auctions. Read-only research and data preparation. No code changed, no database touched, no login, no CAPTCHA solved, no bulk crawl. Dates in this document are dd-mm-yyyy; the CSV files use YYYY-MM-DD because the upload format requires it.

Files delivered in this folder:

1. `RBI_91DAY_TBILL_CUTOFF_YIELD_HISTORY.csv` (series_id `RBI_91D_TBILL_CUTOFF_YIELD`, frequency `weekly_auction`)
2. `RBI_POLICY_REPO_RATE_HISTORY.csv` (series_id `RBI_POLICY_REPO_RATE`, frequency `policy_change`)
3. this file

## 1. The short version

- The efficient official route is the RBI "Handbook of Statistics on the Indian Economy" table pages on rbi.org.in. Each yearly edition has an HTML view of the table "Auctions of 91-Day Government of India Treasury Bills" (about 50 weekly rows per edition) and of the table "Major Monetary Policy Rates and Reserve Requirements" (every policy change since 2008 in the current edition, since 2001 and earlier in the 2010 edition).
- That gave 1,046 weekly 91-day cut-off yields (05-04-2006 to 24-06-2026) from 18 Handbook table pages. The newest Handbook page stops at 24-06-2026, so the 14 auctions from 01-07-2026 to 30-09-2026 were added in a second pass from the individual RBI "Treasury Bills: Full Auction Result" press releases (section 2.2). Total: 1,060 rows, 05-04-2006 to 30-09-2026.
- Every value is a weekly auction cut-off yield ("Implicit Yield at Cut-off Price", 4 decimals), not a monthly average. No monthly averages were produced. Nothing was interpolated or estimated.
- The repo series has 61 rows from 26-10-2005 (6.25) to 05-12-2025 (5.25). The NSDP page of 02-10-2026 still shows 5.25 for the week ended 25-09-2026, and the latest monetary policy statement (05-08-2026) kept the repo rate unchanged at 5.25 (section 2.3a).
- RBI's own downloadable files for these tables (the .XLSX and .PDF links on rbidocs.rbi.org.in) returned a human-verification (CAPTCHA) page to my fetches, so I did not obtain them and did not try to get round it. All values were read from RBI's HTML view of each table on www.rbi.org.in instead.

## 2. Sources used (per source)

All retrievals on 03-10-2026 with an ordinary GET request (about 50 single page loads in total, spaced 3 to 4 seconds apart, plus a few fetches through the research tool; the second pass for the 2026 auctions added 4 month-list pages, 13 press releases and 1 policy statement). Sizes are the size of the HTML page as downloaded. "Read how" is how the numbers were read: from the HTML table directly (I parsed the saved HTML table cells locally), or from text.

### 2.1 Weekly 91-day auction cut-off yields: Handbook table pages

What the table is: the RBI Handbook table "Auctions of 91-Day Government of India Treasury Bills" (rupees crore). Columns: date of auction, date of issue, notified amount, bids received, bids accepted, total issue, cut-off price, "Implicit Yield at Cut-off Price (percent)". The yield column is what the CSV carries. RBI's note on the table says the yield is presented on an actual/365 day-count basis (from the auction of 27-10-2004; so all rows delivered are on that basis). Source line on each page: Reserve Bank of India. Frequency: weekly (Wednesday auctions; a few printed on other days). Each edition page holds roughly the last 12 to 14 months; the 2009 to 2011 editions hold 2 to 3 years.

URL pattern: `https://www.rbi.org.in/scripts/PublicationsView.aspx?id=<id>`. The table number changes between editions. "Page date" is the edition date RBI prints on the page ("Date : ...").

| id | Table no. | Page date | Auction dates in the page | Rows used in CSV | HTML size (bytes) |
|---|---|---|---|---|---|
| 11807 | 222 | 15-09-2009 | 05-04-2006 to 29-07-2009 | 106 | 337,945 |
| 12907 | 215 | 15-09-2010 | 02-04-2008 to 28-07-2010 | 53 | 254,035 |
| 13807 | 215 | 15-09-2011 | 02-04-2009 to 13-07-2011 | 116 | 209,055 |
| 14575 | 215 | 14-09-2012 | 06-07-2011 to 18-07-2012 | 52 | 116,251 |
| 15340 | 215 | 16-09-2013 | 04-07-2012 to 07-08-2013 | 52 | 119,091 |
| 16009 | 215 | 15-09-2014 | 03-07-2013 to 20-08-2014 | 51 | 119,634 |
| 16662 | 221 | 16-09-2015 | 02-07-2014 to 22-07-2015 | 52 | 88,347 |
| 17354 | 221 | 16-09-2016 | 02-07-2015 to 27-07-2016 | 51 | 90,345 |
| 17996 | 221 | 15-09-2017 | 05-07-2016 to 26-07-2017 | 52 | 89,866 |
| 18680 | 215 | 15-09-2018 | 05-07-2017 to 25-07-2018 | 52 | 89,905 |
| 19204 | 213 | 15-09-2019 | 04-07-2018 to 24-07-2019 | 52 | 89,397 |
| 19946 | 213 | 18-09-2020 | 03-07-2019 to 29-07-2020 | 52 | 91,267 |
| 20615 | 210 | 15-09-2021 | 01-07-2020 to 28-07-2021 | 52 | 89,530 |
| 21307 | 210 | 15-09-2022 | 07-07-2021 to 27-07-2022 | 56 | 89,585 |
| 22019 | 213 | 15-09-2023 | 03-08-2022 to 30-08-2023 | 48 | 87,995 |
| 22687 | 213 | 13-09-2024 | 12-07-2023 to 28-08-2024 | 51 | 87,121 |
| 23391 | 217 | 29-08-2025 | 03-07-2024 to 30-07-2025 | 49 | 85,297 |
| 24043 | 218 | 31-07-2026 | 02-07-2025 to 24-06-2026 | 49 | 83,487 |

Where two editions both print an auction date, the CSV uses the most recent edition (that is why the "rows used" counts are lower than the rows on the page for the overlapping months).

Read how: directly from the HTML table cells (cell-by-cell parse of the saved page). Not from OCR, not from prose.

Period and frequency delivered: 05-04-2006 to 24-06-2026, weekly. Rows per calendar year are 50 to 54 in full years (39 in 2006, 24 in 2026).

Checks I ran on the data (all on the saved tables):

- Overlap check: 190 auction dates appear in more than one edition. 186 agree exactly. 4 differ in the fourth decimal (auction dates 07-07-2010, 14-07-2010, 21-07-2010, 28-07-2010: the 2010 edition prints 5.3653, 5.4065, 5.7364, 5.7364; the 2011 edition prints 5.3650, 5.4060, 5.7360, 5.7360). The CSV uses the later edition and states the earlier value in the notes column.
- Consistency check: for every row I recomputed the yield from the printed cut-off price (91-day, actual/365). All rows agree within 0.08 percentage points except four rows, all in the 2011 edition (page date 15-09-2011), where the printed cut-off price does not fit the printed yield: 21-07-2010, 27-10-2010, 03-11-2010 and 08-12-2010. For these rows I kept the yield as published and wrote a note in the CSV. For 21-07-2010 the 2010 edition also prints a yield (5.7364) that is consistent with the 2011 edition (5.7360) to three decimals. For 27-10-2010, 03-11-2010 and 08-12-2010 there is no second edition to compare with, so these three yields are the least certain values in the file. The PO can check them against the RBI auction press release of those dates.
- Independent cross-check against a different RBI page: the RBI auction press release of 17-12-2025 (https://www.rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx?prid=61835, HTML page 112,270 bytes) prints YTM 5.2780% for the 91-day bill, equal to the Handbook value for 17-12-2025.

### 2.2 Auctions after the Handbook: RBI "Treasury Bills: Full Auction Result" press releases (01-07-2026 to 30-09-2026)

How each release was found: I opened the RBI press-release page for each month (July, August and September 2026) once, through the page's own month archive form, read the list of titles, and then opened only the "Treasury Bills: Full Auction Result" release for each auction date shown there. No URL was guessed; no release outside the list was opened. One page per release, 4 seconds apart. The October 2026 list (only 01-10-2026 items so far) was also opened once to check for monetary policy items.

What each release is: title "Treasury Bills: Full Auction Result", HTML page of about 115,000 to 117,000 bytes. Row III gives the cut-off price and "YTM" for 91-day, 182-day and 364-day bills; the YTM in row III is the 91-day cut-off yield used. Row VI also gives a weighted average yield, which is not the cut-off yield and is not used. URL pattern: `https://www.rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx?prid=<id>`.

Read how: from the text of the HTML press release (a script reading of the saved page). For every release I recomputed the yield from the printed 91-day cut-off price (actual/365, 91 days). All 14 agree with the printed yield to within 0.0001 percentage points (30-09-2026 recomputes to 5.5198 against the printed 5.5199, a rounding difference).

| Auction date | Press release no. | prid | 91-day cut-off price | 91-day cut-off yield (YTM) |
|---|---|---|---|---|
| 01-07-2026 | 2026-2027/584 | 63062 | 98.7075 | 5.2521 |
| 08-07-2026 | 2026-2027/629 | 63107 | 98.6966 | 5.2970 |
| 15-07-2026 | 2026-2027/672 | 63150 | 98.6880 | 5.3324 |
| 22-07-2026 | 2026-2027/733 | 63211 | 98.6827 | 5.3542 |
| 29-07-2026 | 2026-2027/777 | 63255 | 98.6861 | 5.3402 |
| 05-08-2026 | 2026-2027/813 | 63291 | 98.7012 | 5.2780 |
| 12-08-2026 | 2026-2027/875 | 63353 | 98.7050 | 5.2624 |
| 19-08-2026 | 2026-2027/924 | 63402 | 98.7055 | 5.2603 |
| 27-08-2026 (Thursday) | 2026-2027/973 | 63451 | 98.7046 | 5.2640 |
| 02-09-2026 | 2026-2027/1023 | 63501 | 98.7056 | 5.2599 |
| 09-09-2026 | 2026-2027/1077 | 63555 | 98.7180 | 5.2089 |
| 16-09-2026 | 2026-2027/1125 | 63603 | 98.7007 | 5.2801 |
| 23-09-2026 | 2026-2027/1172 | 63650 | 98.6740 | 5.3900 |
| 30-09-2026 | 2026-2027/1218 | 63696 | 98.6425 | 5.5199 |

- Delivered: 14 rows (observation_date as in the table above), appended to the CSV in date order, no duplicates. The 30-09-2026 row delivered earlier was replaced by the same value in the new format.
- Date caveat: RBI publishes each result on the auction day, so the press-release date is used as the auction date. In the week of 24-08-2026 the release is dated Thursday 27-08-2026, so that auction is recorded on 27-08-2026. No Wednesday between 01-07-2026 and 30-09-2026 is missing: the list shows 13 Wednesdays plus the Thursday one, all read.
- Releases I could not read: none. All 14 opened and parsed.
- Cross-check against a different RBI page: the NSDP weekly "91-Day Treasury Bill (Primary) Yield" for the weeks ended 28-08, 04-09, 11-09, 18-09 and 25-09-2026 (5.26, 5.26, 5.21, 5.28, 5.39) equals the cut-off yields of the auctions of 27-08, 02-09, 09-09, 16-09 and 23-09-2026 rounded to two decimals.
- Not used: the sibling release "91-Day, 182-Day and 364-Day T-Bill Auction Result: Cut-off" (same-day, shorter), and the pre-auction notices.

### 2.3a Check for a repo rate change after 25-09-2026

- The latest monetary policy statement in the RBI press-release lists for July to October 2026 is "Monetary Policy Statement, 2026-27 Resolution of the Monetary Policy Committee August 3 to 5, 2026", dated 05-08-2026 (https://www.rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx?prid=63287, HTML page 120,754 bytes). It states that the MPC voted unanimously to keep the policy repo rate unchanged at 5.25 per cent (SDF 5.00, MSF and Bank Rate 5.50).
- I scanned the titles in the September 2026 and 01-10-2026 lists and found no later monetary policy statement or policy-rate announcement (only daily liquidity auction notices). The 62nd MPC meeting of 03-08 to 05-08-2026 is the latest one I could find; I did not find the date of the next meeting.
- Result: no change after 05-12-2025. Nothing appended to the repo CSV. Status as of 03-10-2026. A decision announced after this date is not covered.

### 2.3 Policy repo rate: Handbook policy-rate tables

Two table pages carry the effective dates of every policy change:

| id | Table | Page date | Content | HTML size (bytes) |
|---|---|---|---|---|
| 23865 | 40, "Major Monetary Policy Rates and Reserve Requirements - Bank Rate, LAF (Repo, Reverse Repo, SDF and MSF) Rates, CRR & SLR" | 31-07-2026 | Effective-date rows from 26-04-2008 to 05-12-2025 (only rows where something changed) | 93,486 |
| 12737 | 46, "Major Monetary Policy Rates and Reserve Requirements - Bank Rate, LAF (Repo - Reverse Repo) Rates, CRR & SLR" | 15-09-2010 | Effective-date rows from 05-07-1935 to 27-07-2010 | 162,412 |

URLs: https://www.rbi.org.in/scripts/PublicationsView.aspx?id=23865 and https://www.rbi.org.in/scripts/PublicationsView.aspx?id=12737

- Rows from 12-06-2008 onward come from Table 40; rows from 26-10-2005 to 31-03-2007 come from the 2010 edition (Table 46). Where both tables cover a date (12-06-2008 to 27-07-2010) they agree on every repo value.
- Column reading in Table 40: each data row has the effective date followed by seven values in the order Bank Rate, Repo, Reverse Repo, Standing Deposit Facility, Marginal Standing Facility, CRR, SLR; "-" means no change. I confirmed the order by testing the 05-12-2025 row (5.50, 5.25, -, 5.00, 5.50) against the RBI NSDP page of 02-10-2026, which shows policy repo 5.25, SDF 5.00, MSF 5.50 and Bank Rate 5.50.
- Read how: directly from the HTML table cells.
- Delivered: 61 rows, 26-10-2005 to 05-12-2025.
- Rows before 26-10-2005 exist in Table 46 but were not included. The level in force at the start of the T-bill series (06.25 from 26-10-2005) is included so the repo series covers 05-04-2006. Earlier years used a different LAF mechanism (RBI's own note says it was variable-rate auction based until 28-03-2004, and the names "repo" and "reverse repo" were swapped on 29-10-2004).
- One table row was left out on purpose: 17-04-2020 prints repo 4.40 again, but repo was already 4.40 from 27-03-2020 (only the reverse repo changed that day). Every other row in the CSV is a genuine change in the repo level.
- A discrepancy between the two tables: the 2010 edition has no row for 05-01-2009 (repo 5.50, reverse repo 4.00), while the 2026 table has it. The CSV includes it from the 2026 table.

### 2.4 Cross-check page: RBI National Summary Data Page (not used as a value source)

- URL: https://www.rbi.org.in/Scripts/BS_NSDPDisplay.aspx?param=4 (HTML, 113,037 bytes), page date 02-10-2026.
- Shows weekly "91-Day Treasury Bill (Primary) Yield" to two decimals for the weeks ended 28-08-2026, 04-09, 11-09, 18-09 and 25-09-2026 (5.26, 5.26, 5.21, 5.28, 5.39) and "Policy Repo Rate" 5.25 for the same weeks. These are week-end reference values, not auction dates, so they are not in the CSV. They are used only to confirm that the repo level was still 5.25 on 25-09-2026 and as a cross-check on the auction yields (section 2.2).
- The page also lists an Excel (11 KB) and PDF (103 KB) "Ratios and Rates" file; I did not download them.

### 2.5 Pages opened and not useful, and attempts that failed

- Handbook listing pages (used only to find the table page ids): https://www.rbi.org.in/scripts/AnnualPublications.aspx?head=Handbook+of+Statistics+on+Indian+Economy with date filters (four views; two of them large pages, about 4.1 MB and 2.5 MB).
- https://www.rbi.org.in/commonman/english/history/Scripts/BankrateCRRandSLRChanges.aspx (Bank rate, CRR, SLR history only; no repo): not used.
- https://www.rbi.org.in/scripts/WSSView.aspx (Weekly Statistical Supplement list): returned "Error occured. Please try again."; not used.
- The .XLSX/.PDF files of Handbook Table 218 and Table 40 on rbidocs.rbi.org.in: three fetches (two by command line, one through the research tool) each returned a "what code is in the image?" human-verification page, not the data. I did not solve it and did not retry. Separately, one attempt to open the Table 218 PDF in the in-app browser caused the browser to offer a file-save dialog to the user instead of showing the page; I did not retry, and no file from that attempt was used. Note: RBI labels those links ".xlsx" but a script download of such a link gives that verification page, so a PO downloading them in a normal browser may get a real file; I could not confirm that.
- RBI DBIE (https://data.rbi.org.in/DBIE/): page shows only the name "DBIE" to my fetch tool (it is a script-driven application). I did not use any undocumented data interface, and I did not use the third-party mirror dbie.rbihub.in at all.
- Monthly averages: not produced because weekly cut-offs were available officially. Nothing in the CSV is a monthly average.

## 3. Publisher reuse statement as published

- Every RBI page I opened carries the footer "All Rights Reserved" together with a "Disclaimer" link. The Handbook table pages and the press releases carry no separate reuse or licence text; the tables end with the source line "Source : Reserve Bank of India."
- From the earlier research file (`docs/nav2/BETA_ALPHA_RISK_FREE_SOURCES_RESEARCH_2026-10-03.md`, not re-read for this task): the RBI Disclaimer page says nothing about reproduction or commercial use, but restricts caching, linking and framing without written permission. The dedicated copyright page returned "file not found".
- I searched the text of the Handbook listing, a Handbook table page, the policy-rate table page, the NSDP page and the press release page for copyright, reproduce, republish, permission, courtesy and licence wording and found only the footer notice.

## 4. Verification steps the PO can do

Open each URL in a normal browser and compare. None needs a login.

91-day cut-off yields (Handbook table, "Implicit Yield at Cut-off Price (percent)" column):

1. https://www.rbi.org.in/scripts/PublicationsView.aspx?id=24043 : auction 17-Dec-2025 should read 5.2780; auction 08-Apr-2026 should read 5.3064; auction 24-Jun-2026 should read 5.2476.
2. https://www.rbi.org.in/scripts/PublicationsView.aspx?id=21307 : auction 04-May-2022 should read 4.0290.
3. https://www.rbi.org.in/scripts/PublicationsView.aspx?id=16009 : auction 03-Jul-2013 should read 7.5186.
4. https://www.rbi.org.in/scripts/PublicationsView.aspx?id=11807 : auction 05-Apr-06 should read 5.7776 (the 2009 edition prints two-digit years).
5. Independent page for the same number as sample 1: https://www.rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx?prid=61835 should show YTM 5.2780% for the 91-day bill on 17-12-2025.
6. Latest values: https://www.rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx?prid=63696 should show 91-day YTM 5.5199% (cut-off price 98.6425); prid=63062 (01-07-2026) should show 5.2521% (98.7075); prid=63555 (09-09-2026) should show 5.2089% (98.7180).

Repo rate (Table 40, column "Fix Range LAF Rates", first sub-column "Repo"):

7. https://www.rbi.org.in/scripts/PublicationsView.aspx?id=23865 : effective 05-12-2025 repo 5.25; effective 07-02-2025 repo 6.25; effective 12-06-2008 repo 8.00.
8. https://www.rbi.org.in/Scripts/BS_NSDPDisplay.aspx?param=4 : "Policy Repo Rate" 5.25 for the latest weeks.

Please also glance at the rows listed in section 5 under "least certain values".

## 5. Known gaps

91-day series:

- Auctions with no cut-off yield in the table (bids were received but none accepted, so the cut-off price and yield cells are "-"). These five dates are NOT in the CSV: 27-01-2016, 24-02-2016, 29-03-2023, 20-02-2025, 25-03-2026.
- Wednesdays with no row at all in the tables (RBI does not say whether an auction was held; nothing was filled in): 05-01-2011, 17-07-2013, 01-04-2015, 30-09-2020, 18-09-2024, 25-09-2024, 31-12-2025, 01-04-2026.
- 01-07-2026 to 30-09-2026: no gap. The 14 auctions were added from the individual press releases (section 2.2). The last auction in the file is 30-09-2026. An auction held after 30-09-2026 (for example 07-10-2026) is not in the file.
- Before 05-04-2006: not collected (the oldest edition I opened starts there; older editions exist but were not opened).
- Least certain values (single source, price and yield in the same row disagree): 27-10-2010 (6.8540), 03-11-2010 (6.7710), 08-12-2010 (7.2270). Also flagged: 21-07-2010 (5.7360), where the two editions agree on the yield to three decimals but the 2011 edition's price does not fit. The four 07-2010 dates (07, 14, 21, 28) also carry a note about the 4th-decimal difference between editions.
- Some auction dates fall on non-Wednesdays in the tables (for example Mondays, Tuesdays and Thursdays in some periods); dates are as printed.

Repo series:

- No row before 26-10-2005 (deliberate, see 2.3).
- Checked on 03-10-2026 (section 2.3a): the latest monetary policy statement, 05-08-2026, kept the repo rate at 5.25; no later change found. A decision announced after 03-10-2026 is not covered.
- The 2010 edition omits the 05-01-2009 change, handled as described in 2.3.

## 6. Terms status: PO-accepted reuse risk (written RBI confirmation not required)

- Written RBI confirmation is not required by Product Owner decision. Historical manual loading and automated refresh are permitted subject to technical validation, attribution, monitoring and the documented accepted reuse risk. The PO proceeds with attribution. RBI states "All Rights Reserved" on these pages and its disclaimer restricts caching, linking and framing without written permission; no explicit licence for reuse of these tables was found on any page I read.
- This data was gathered by ordinary page views for a one-off first load. Automated weekly retrieval is permitted by the PO decision above and is implemented as a polite, HTML-only reader (rbi.org.in only, no documents, robots.txt honoured, nothing retried or worked around when RBI refuses a content page). FHIP does not frame RBI pages. The rbidocs host showed a human-verification page to scripted downloads, which is why documents are never requested.
- Suggested attribution wording to show next to the rate in reports: "Source: Reserve Bank of India" (the wording RBI prints on its own tables), plus the date of the rate.
- Written RBI confirmation: not required by Product Owner decision (03-10-2026, restated 14-10-2026); none was received.

## 7. Delivered versus not obtained

| Item | Delivered | Not obtained |
|---|---|---|
| 91-day T-bill auction cut-off yield, weekly | 1,060 rows (1,046 from the Handbook, 05-04-2006 to 24-06-2026; 14 from RBI auction press releases, 01-07-2026 to 30-09-2026); 4 decimals | 5 auctions with no accepted bids and 8 Wednesdays with no row (section 5); anything before 05-04-2006; auctions after 30-09-2026 |
| Policy repo rate, effective dates | 61 rows, 26-10-2005 to 05-12-2025 (latest 5.25) | Changes before 26-10-2005 (deliberately left out); checked to 03-10-2026 against the 05-08-2026 monetary policy statement (no change); decisions after 03-10-2026 not covered |
| Monthly averages | Not produced (weekly data available) | Not needed |
| RBI's own downloadable XLSX/PDF of the tables | No | Blocked by a human-verification page for scripted download; values read from RBI's HTML view of the same tables |
| RBI DBIE time-series download | No | Page not readable by my tools; no undocumented interface used |
| Written RBI permission | No | Not required by Product Owner decision, see section 6 |
| Third-party mirrors | Not used at all | n/a |
