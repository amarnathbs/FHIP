# Planning Benchmarks - refresh cadence, upload process and feed options

Prepared 06/10/2026. Documentation only: no code, feed, database or migration was touched.

Question from the Product Owner: "How do I upload this at regular intervals, or is there a direct API integration that runs regularly?"

## Evidence labels and honesty rules

- **Verified** = read on the publisher's own page or in a publisher-quoted search result on 06/10/2026.
- **Inferred** = a pattern worked out from past releases; the publisher has not announced it.
- **Not verified** = could not be confirmed from here. Several sites (ASFA, data.gov.au, EPFO, the MoSPI portal pages) returned HTTP 403 to automated fetching, so their pages were read only through search-result text. Those items are marked.
- The "review due" interval is a recommendation. The app currently has only a review-due date column on datasets; there is no reminder job, no notification and no dashboard list today (see section 4).
- Dataset numbers 1 to 12 follow the registry in `IMPORT_SCHEMA_AND_PARAMETER_MAP_2026-10-03.md` section 3 and `first_load/PROVENANCE_REGISTER.md`.

## 1. Summary table

| No | Dataset | Publisher | Cadence | Machine-readable API | Recommended process | Automation worth it |
|---|---|---|---|---|---|---|
| 2 | AU household asset composition | ABS (Survey of Income and Housing, "Household Income and Wealth") | Irregular, about every 2 years until 2019-20; 2023-24 cancelled; 2025-26 results expected from mid-2027 | N (Excel cubes only; not seen in the Data API) | Manual upload on the new screen when ABS releases | No |
| 3 | AU household wealth distribution | ABS (same survey) | As above | N | Manual upload | No |
| 4 | AU net worth and income by age band | ABS (same survey) | As above | N | Manual upload | No |
| 7 | AU household debt context | ABS (same survey for the loaded figure; National Accounts Finance and Wealth for context) | Survey as above; National Accounts quarterly (last 24/09/2026, next 17/12/2026) | Partial (survey N; national accounts API availability not verified) | Manual upload; no feed unless a new metric is approved | No for now; maybe later |
| 6 | AU average superannuation balance | ATO (Taxation Statistics) via data.gov.au | Annual; 2023-24 edition published 17/06/2026 | Partial (CKAN catalogue on data.gov.au, files are Excel; not verified from here) | Manual upload each year | No (light "release watcher" only) |
| 5 | AU high-DTI mortgage threshold | APRA | Event-driven policy notice; related statistics quarterly (last 17/09/2026) | N (Excel and web pages) | Manual upload on a policy change | No |
| 12 | AU ASFA retirement standard | ASFA | Quarterly budgets; lump sums change rarely (revised February 2026) | N | Manual upload when lump sums change | No |
| 1 and 11 (inputs) | Cost of children, AIFS / UNSW SPRC | AIFS, UNSW Social Policy Research Centre; also DSS budget standards work | Irregular, years apart | N | Manual review; no scheduled upload | No |
| 1 (input) | Canstar Blue cost of kids | Canstar Blue (commercial) | Annual survey, July fieldwork, published August | N | Do not load without written permission; prefer a licensed or official substitute | No |
| 8 | India household consumption (HCES) | MoSPI / NSO | Irregular rounds (2022-23, 2023-24); next not announced | Partial (MoSPI eSankhyiki API/MCP; HCES coverage not verified in detail) | Manual upload; blocked anyway until a per-capita metric exists | Maybe, later |
| (input) | India labour force (PLFS) | MoSPI / NSO | Monthly and quarterly bulletins | Y/Partial (eSankhyiki) | Not a registered dataset; no upload today | No |
| 9 | India household assets and debt (AIDIS) | MoSPI / NSO (not NABARD) | Rounds many years apart (1971-72, 1981-82, 1992, 2003, 2013, 2019); next not verified | N (PDF reports and microdata catalogue) | Manual upload | No |
| (input) | India rural financial inclusion (NAFIS) | NABARD | Two rounds (2016-17, 2021-22), released 2018 and 10/2024 | N | Review only | No |
| 10 | India EPF/EPS contribution structure | EPFO / Ministry of Labour | Event-driven (government decisions) | N verified | Manual upload when a rule changes | No |
| 1 and 11 | FHIP internal planning model and FHIP Planning Benchmarks v1.0 | FHIP (internal) | Owner-set, recommended yearly | Not applicable | Internal change control through the same screen | No |

Plain reading: almost everything is published as a spreadsheet or PDF once a year or less often. Only the ABS (and perhaps MoSPI) run real data APIs, and the figures FHIP actually uses from them are not in those APIs today.

## 2. Per-source sections

Common process for every manual upload (assumes the new stage-then-activate screen on /admin/benchmarks): download the template (CSV or XLSX), fill it from the publisher's file, upload to stage, read the validation result and preview, then an authorised admin presses Activate; the new values supersede the previous ones; the dataset's review-due date moves forward. Keep the source file name, table and cell in the provenance fields exactly as in `first_load/PROVENANCE_REGISTER.md`. One dependency to confirm: the schema document (section 2.5) says the Twin's peer-value query ignores dataset status and effective dates, so "supersedes" only protects the Twin if superseded rows are really excluded from that query.

### 2.1 ABS Survey of Income and Housing: datasets 2, 3, 4 and 7 (survey part)

- Publisher and page: Australian Bureau of Statistics, Household Income and Wealth, Australia: https://www.abs.gov.au/statistics/economy/finance/household-income-and-wealth-australia/latest-release
- Latest release (verified): reference period 2019-20, released 28/04/2022 (the ABS page also shows 25/05/2022 as the page publication time). The page states that no outputs will be released from the 2023-24 survey.
- Why none for 2023-24 (verified): ABS media statement says serious questionnaire and collection problems could not be overcome: https://www.abs.gov.au/media-centre/media-statements/media-statement-6875eee35460c
- Next release (verified): results from the 2025-26 survey are expected from mid-2027 (same media statement). No exact date was given.
- Format: Excel data cubes on the release page. API: the ABS Data API (SDMX) exists (section 2.2), but in the dataflow list I could read I found no Survey of Income and Housing dataflow, and the list was truncated, so "not in the API" is **not fully verified**. The release page itself lists only downloadable cubes.
- Licence (verified through the register): ABS states Creative Commons Attribution 4.0 International for website content, with attribution; excluding logos and third-party material.
- Recommended process: manual upload via the new screen when the 2025-26 results appear. This is a once-in-years event, not a schedule.
- Review-due interval: set review due to 01/07/2027 for all four datasets, then 12 months after each release. Between now and then the only action is a short check of the ABS page each quarter, which can be done by the owner or a release watcher (section 3).
- Automated feed worth building: no. The data are frozen at 2019-20 until at least mid-2027, the figures are cells inside multi-sheet workbooks, and the table layout changes between releases (the register records renamed tables and restated earlier years). Effort high, benefit near zero, risk of silent mis-reads high.
- Data caveat that matters for planning: the Twin is benchmarking against 2019-20 data that is already six years old and was collected during COVID-19. A disclosed "data as at" label in the app is more valuable than any feed.

### 2.2 ABS Data API (SDMX) and ABS National Accounts: dataset 7 context

- What exists (verified): the ABS Data API (marked Beta) is SDMX 2.1, returns SDMX-ML (XML), SDMX-JSON or SDMX-CSV, and supports data retrieval and metadata discovery. The base path changed on 29/11/2024 to https://data.api.abs.gov.au/rest/data/[query] (old: https://api.data.abs.gov.au/data/[query]). User guide: https://www.abs.gov.au/statistics/application-programming-interfaces-apis/data-api-user-guide
- From the guide: no API key is mentioned; no rate limits are stated; requesting "all" data can time out. Beta status means the contract may change.
- What I did check: the dataflow list on 06/10/2026 responded, and the visible part contained Census 2016 and population dataflows, not wealth or household finance. The list was cut off, so a National Accounts Finance and Wealth dataflow may exist further down: **not verified**.
- The registered national-accounts tables are published as Excel (June 2026 edition released 24/09/2026; the next, for September 2026, is due 17/12/2026, then 25/03/2027). Page: https://www.abs.gov.au/statistics/economy/national-accounts/australian-national-accounts-finance-and-wealth/latest-release
- Important: the first-load register loaded none of the national-accounts series, because there is no metric for aggregate household debt (schema document section 5, item 6). So today there is nothing in the app that a quarterly feed would update.
- Licence: CC BY 4.0, attribution to the ABS.
- Recommended process: nothing to refresh now. If the PO approves a new household-debt metric (proposal P4), treat it as a quarterly manual or semi-automated pull.
- Review-due interval: 12 months for the survey-derived figure (see 2.1); if a national-accounts metric is ever added, 3 months.
- Automated feed worth building: **this is the one place the PO's example is right, conditionally.** An ABS SDMX pull is the most defensible feed in this whole list (stable, documented, licence-clear, machine-readable, no key). It is worth building only after (a) a metric exists that can hold the series, and (b) someone confirms the National Accounts dataflow is actually in the API. Effort: small to medium (a read-only job, a mapping table, a staged upload instead of a direct write). Risk: low for data, medium for contract (Beta). Until both conditions hold: no.

### 2.3 ATO Taxation Statistics: dataset 6 (average superannuation balance)

- Publisher: Australian Taxation Office. 2023-24 edition page: https://www.ato.gov.au/about-ato/research-and-statistics/in-detail/taxation-statistics/taxation-statistics-2023-24
- Cadence (verified): annual. The 2023-24 edition was published on 17/06/2026; the media release is at https://www.ato.gov.au/media-centre/2023-24-taxation-statistics-released . Next edition (2024-25): **inferred** around June 2027, not announced.
- Format: Excel files hosted on data.gov.au (resource files such as the Snapshot Table 5 workbook used by the first load). data.gov.au is a CKAN catalogue, which normally offers a JSON API (package_show) and a "last modified" field per resource. I tried to call it from this environment and got HTTP 403, so the exact API behaviour is **not verified**.
- Licence (from the register): CC BY 2.5 Australia on data.gov.au, attribution required.
- Fragility: the loaded figure sits in a chart-data sheet cell (sheet '12', cells J211 and K211). Cell positions and table numbers change from edition to edition, and the register notes mislabelled year blocks in one table. A fetch job would need a human to recheck the cell each year anyway.
- Recommended process: manual upload via the new screen each year after the ATO release; read the cell from the workbook, copy the provenance string.
- Review-due interval: 01/07/2027, then every 12 months.
- Automated feed worth building: no for the value itself. A tiny "release watcher" that checks the CKAN last-modified date (or the ATO release page) and raises Review Due is cheap and low risk (effort small, benefit moderate). Auto-writing the number is not recommended (layout risk, and the per-individual versus per-household issue D6 needs a human judgement each time).

### 2.4 APRA: dataset 5 (high DTI threshold) and related statistics

- Publisher: Australian Prudential Regulation Authority. Notice: https://www.apra.gov.au/news-and-publications/activation-debt-income-limits-macroprudential-policy-tool
- Nature of the figure: a policy threshold (six times income) effective from 01/02/2026, announced 27/11/2025. It changes only when APRA decides; APRA's 28/05/2026 release is reported in the register as saying the limits remain unchanged (full APRA news index not browsed).
- Related statistics (verified): APRA publishes Quarterly ADI Performance and Quarterly ADI Property Exposures statistics. The March 2026 quarter edition was published on 29/06/2026 and the June 2026 quarter edition on 17/09/2026. The next (September 2026 quarter) is expected around December 2026 (**inferred**, date not announced). These now include the share of new lending at high debt-to-income. Page: https://www.apra.gov.au/news-and-publications/quarterly-authorised-deposit-taking-institution-statistics
- API: none seen. Publications are Excel files plus web pages and PDFs. **No stable API verified.**
- Licence (from the register): APRA website content is CC BY 4.0 except logos and third-party material.
- Recommended process: manual upload only if APRA changes the threshold or announces an additional limit. The loaded row is a threshold, not a statistic, so the quarterly statistics are not an input to it.
- Review-due interval: 6 months (next 01/04/2027), because macroprudential settings are reviewed in that time frame and a change would be news.
- Automated feed worth building: no. One row, changes rarely, and a wrong number here would show a household a false regulatory limit. A reminder is the right tool.

### 2.5 ASFA Retirement Standard: dataset 12

- Publisher: Association of Superannuation Funds of Australia. Page: https://www.superannuation.asn.au/consumers/retirement-standard/
- Cadence (verified through ASFA-quoted results): budgets are updated quarterly for CPI. The June 2026 quarter update was published in September 2026 (the first-load file is dated 09/2026). Lump-sum figures move rarely: the February 2026 revision was the first rise in three years (single comfortable 630,000 and couple 730,000 dollars; modest 110,000 and 120,000). Next quarterly budgets (September 2026 quarter): **inferred** about December 2026.
- API: none. PDF tables and summary PDFs only. The ASFA site blocked automated fetching (HTTP 403) so I could not read the page directly; the register records that an ordinary browser works.
- Licence: ASFA states copyright and that reproduction beyond fair dealing needs written permission (PO decision D7 in the schema document). Even a manual upload carries that risk; an automated copy of ASFA figures into the product makes the permission question more pressing, not less.
- Recommended process: manual upload via the new screen only when the lump sums change (they are the only values the app uses). Check each quarter; most quarters need no upload.
- Review-due interval: 3 months (first on 15/01/2027) as a check, with an upload only on change.
- Automated feed worth building: no. PDF only, copyright-restricted, and four numbers.

### 2.6 Cost of children: AIFS / UNSW SPRC (input to dataset 1 and the FHIP planning model)

- Publisher: Australian Institute of Family Studies, research by the UNSW Social Policy Research Centre using a budget standards method. Page: https://aifs.gov.au/media-releases/new-estimates-costs-raising-children-australia
- Cadence: irregular, years apart. The estimates AIFS publishes date from the 2020s budget-standards work; I could not confirm an exact date on the AIFS page. A newer Budget Standards for Child Support research report (ANU/UNSW consortium for the Department of Social Services, October 2024) exists (https://www.dss.gov.au/our-responsibilities/families-and-children/publications-articles/updated-costs-of-children-using-australian-budget-standards) and a 2026 paper using a financial-stress method on HILDA data is reported (not read by me). Whether any of these should replace the seeded inputs is a methodology decision, not a refresh task.
- API: none.
- Registry position: dataset 1 is a FHIP-derived model whose methodology is not yet defined (draft worksheet only). So there is no loaded number to refresh.
- Recommended process: manual research review once a year by the owner; any change goes through the internal change process in 2.12.
- Review-due interval: 12 months (first on 01/10/2027).
- Automated feed worth building: no.

### 2.7 Canstar Blue cost of kids

- Publisher: Canstar Blue, a commercial comparison business. Article: https://www.canstarblue.com.au/news/the-average-cost-of-raising-kids-in-australia/
- Cadence (verified): annual survey, fieldwork July, article published 14/08/2025 (920 parents, 1,361 dollars per month average; 2024 comparison for two children 1,073 dollars). I found no 2026 edition by search on 06/10/2026: **not verified whether one exists**.
- Quality: a self-reported commercial survey of subjective spending. Weaker evidence than ABS, ATO or APRA data.
- Terms: Canstar's terms of use say information on the site must not be reproduced, sold or published without prior written permission (https://www.canstarblue.com.au/terms-and-conditions/). That is a risk for putting its numbers in FHIP as a benchmark.
- API: none.
- Recommended process: do not load into live benchmark rows unless Canstar gives written permission. Prefer an official source (ABS, AIFS/UNSW) as the evidence for dataset 1.
- Review-due interval: 12 months, as a review of whether to keep using it at all (first on 01/09/2027).
- Automated feed worth building: no (copyright, weak evidence, no feed).

### 2.8 MoSPI HCES: dataset 8 (India household consumption)

- Publisher: Ministry of Statistics and Programme Implementation (National Statistics Office). Latest round on the MoSPI page used for the first load: HCES 2023-24 (fieldwork August 2023 to July 2024; factsheet dated 27/12/2024 and press note 30/01/2025 per the register); 2022-23 is the same methodology. Rural monthly per-person spend 4,122 and urban 6,996 rupees (without imputation).
- Cadence: irregular. MoSPI ran two consecutive annual rounds after the pandemic; I found nothing announcing a 2025-26 round or its release date: **not verified**.
- API: MoSPI's eSankhyiki portal (launched 29/06/2024) lists HCES among its data products and offers a Macro Indicators module with API sharing; a beta MCP server is reported at mcp.mospi.gov.in without a key. I could not read the portal's own API documentation from here (the fetch returned only a page shell), so the exact HCES endpoints and terms are **not verified**. The microdata portal (https://microdata.gov.in) needs registration for downloads.
- Licence (from the register): MoSPI copyright page allows accurate reproduction with credit; category status per dataset not verified.
- Blocker unrelated to refresh: no metric holds a per-person monthly amount, so nothing is imported today.
- Recommended process: nothing to refresh until a per-capita metric exists; then manual upload per round.
- Review-due interval: 12 months (first on 01/10/2027); bring forward if MoSPI announces a new round.
- Automated feed worth building: not now. If a per-capita metric is created and the eSankhyiki HCES endpoint is confirmed stable, a read-only pull into the staging area could be considered (effort medium, risk medium: new portal, young API).

### 2.9 MoSPI PLFS (labour force)

- PLFS is not a registered dataset. It appears only as an input to the FHIP internal model's seed derivation (dataset 1).
- Cadence (verified): monthly and quarterly bulletins; the MoSPI Advance Release Calendar for 2026-27 lists them (https://www.mospi.gov.in/uploads/documents/releaseCalender/1779709510470-ADVANCE%20RELEASE%20CALENDAR%202026-27%20Updated%2025.05.2026.pdf). The July 2026 and June 2026 bulletins exist.
- API: eSankhyiki lists PLFS; terms and endpoints not verified (see 2.8).
- Recommended process: none. Do not schedule an upload for a dataset the app does not use.
- Review-due: not applicable unless dataset 1 starts to cite PLFS evidence.
- Automated feed worth building: no.

### 2.10 MoSPI AIDIS (and NABARD NAFIS): dataset 9 (India household assets and debt)

- Correction to the PO's phrasing: AIDIS, the source of dataset 9, is run by MoSPI / NSO (the NSS 77th round, survey January to December 2019, assets and debt as at 30/06/2018), not by NABARD. NABARD runs a different survey, NAFIS, which is not registered as a dataset.
- Cadence (verified through search results): AIDIS rounds were 1971-72, 1981-82, 1992, 2003, 2013 and 2019. The gap between rounds is 6 to 11 years. No next round is announced in anything I found: **not verified**. (The MoSPI release calendar PDF mentions AIDIS; I could not extract the context.)
- NAFIS (NABARD): rural households only; the second round for 2021-22 was released in 10/2024 (average monthly household income 12,698 rupees, up from 8,059 in 2016-17, per search results). Rounds are about five years apart. Not used by the app.
- API: none for the reports (PDF); the microdata library (https://microdata.gov.in) has the 77th round catalogue entry and requires registration to download.
- Licence: MoSPI copyright page, accurate reproduction with credit.
- Recommended process: manual upload when MoSPI publishes a new round. The register notes the main NSS Report No. 588 was not found, so the first step is to obtain it.
- Review-due interval: 12 months, as a "has a new round been announced" check (first on 01/10/2027). Data themselves will not change for years.
- Automated feed worth building: no.

### 2.11 EPFO contribution structure: dataset 10

- Publisher of record: Employees' Provident Fund Organisation under the Ministry of Labour and Employment. The register records that the EPFO site returned HTTP 403 to automated access and the evidence is Government of India press releases (PIB).
- Cadence: event-driven. The wage ceiling rose from 15,000 to 25,000 rupees per month from 17/09/2026 following a Cabinet decision on 16/09/2026 (PIB / Ministry of Labour pages in the register; news reports also cite notification S.O. 5109(E) dated 17/09/2026 - the notification number is from secondary reports, not verified against the Gazette). The statutory rates (employee 12 per cent, employer 12 per cent) did not change in what I found.
- API: none verified. EPFO publishes circulars and notifications as web pages and PDFs; I could not read them from here.
- Recommended process: manual upload on a rule change only. The loaded row (24 per cent combined rate) rarely changes; the part that changed, the wage ceiling, is not even stored (schema limitation, P5).
- Review-due interval: 6 months (next 01/04/2027) because India changes these rules by notification at short notice. Treat any press item on EPF, EPS or wage ceilings as a trigger.
- Automated feed worth building: no. A news or Gazette watcher would be noisy and unreliable.

### 2.12 FHIP internal planning model: datasets 1 and 11

- Publisher: FHIP. These are not external downloads: dataset 1 (198 dependant-band keys) is a draft worksheet pending methodology, and dataset 11 (196 target-range bands) is a transcription of the repo seed awaiting PO approval (provenance register sections 1 and 3).
- Cadence: set by the PO. Recommended: a formal annual review, and an ad hoc review whenever an input source in this document changes.
- API: not applicable.
- Recommended process: the same staged upload screen, with the PO named as the authoriser; keep a written method note and approval record for each version (Admin Architecture Standard clauses on audit and no silent change apply).
- Review-due interval: 12 months, with a 6-month method check for dataset 1 until the methodology is approved.
- Automated feed worth building: no. It is a policy decision, not a data feed.

## 3. Release watcher: the one automation worth considering

A "release watcher" is a small scheduled job that never writes benchmark values. Once a week it checks a short list of public pages (ABS release page, ATO data.gov.au resource last-modified, APRA statistics page, ASFA retirement-standard page, MoSPI release calendar) and, if the published date changed, flags the matching dataset as Review Due.

- Effort: small. Benefit: moderate (it removes the risk that nobody notices an ATO, ASFA or ABS release). Risk: low (read-only; the page-scrape part can break when sites change, and ASFA, EPFO and data.gov.au have shown they block automated clients, so those three would remain manual checks).
- Recommendation: build only after the review-due reminder (section 4) exists. It is an add-on, not a requirement.
- Not recommended: any job that fetches numbers and writes them to live benchmark rows.

## 4. Who is reminded when review is due (recommendation)

Current app state: the datasets have a review-due date field only. Nothing sends a reminder and no list shows what is overdue.

Recommended behaviour (not built):

1. Recipient: the Resources/Benchmarks Admin owner role (a named person, with the Super Admin as backup), as an email or in-app notice 30 days before the date, on the date, and weekly while overdue.
2. A "Review Due" list on the Admin dashboard and at the top of /admin/benchmarks, sorted by date, showing dataset, source, last release loaded, next expected release and the intervals in section 1.
3. "Reviewed, no change" must be a recorded action (who, when, source page checked) that moves the date forward without changing any value.
4. An overdue dataset stays active but is shown with an "out of date" label; it is not auto-deactivated.

## 5. Suggested review-due schedule (from 06/10/2026)

| Dataset | First review due | Then every |
|---|---|---|
| 2, 3, 4, survey part of 7 (ABS SIH) | 01/07/2027 | 12 months |
| 6 (ATO super) | 01/07/2027 | 12 months |
| 5 (APRA DTI) | 01/04/2027 | 6 months |
| 12 (ASFA) | 15/01/2027 | 3 months |
| 8 (HCES) | 01/10/2027 | 12 months |
| 9 (AIDIS) | 01/10/2027 | 12 months |
| 10 (EPFO) | 01/04/2027 | 6 months |
| 1 (FHIP model; AIFS, Canstar inputs) | 01/04/2027 | 6 months until approved, then 12 |
| 11 (FHIP bands) | 01/10/2027 | 12 months |

## 6. Overall recommendation

1. Use manual, staged, authorised uploads for all twelve datasets. They are mostly small (one to 28 values), published once a year or less often, and each needs a human judgement (per-individual versus per-household, band edges, licence).
2. Build the review-due reminder and Review Due list first. That is where the real operational risk sits: a stale number nobody notices.
3. Add the release watcher second, as read-only flagging.
4. Do not build a value-writing feed for any dataset now. The one future candidate is an ABS SDMX pull for national-accounts household debt, after a metric exists and the dataflow is confirmed.
5. Resolve the licence questions before relying on refreshes: ASFA (D7), Canstar Blue (written permission), and confirm MoSPI category status.
6. Replace Canstar Blue with an official source as evidence for dataset 1 when the methodology is approved.

## 7. Answer to the Product Owner's question

You do not need a regular API feed, and for most of these sources there is no usable one. The sources fall into two groups: surveys that come out once every few years (the ABS survey, the Indian household surveys, the cost-of-children research), and annual or event-driven publications (ATO tax statistics each June, APRA policy notices, ASFA's retirement tables, India's EPF rules). They are published as spreadsheets and PDFs, not as data services. The ABS does run a proper machine-readable service (the SDMX Data API), and India's statistics ministry has a newer portal with an API, but the particular numbers FHIP uses are not, as far as I could confirm, available through either of them today. For some sites I could not check the details because they block automated access, and I have said so above.

So the practical routine is: the Benchmarks Admin owner gets a Review Due reminder, opens the publisher's page, downloads the new file, fills the template, uploads it to the staging area on /admin/benchmarks, reads the validation and preview, and an authorised admin presses Activate. Expect only a handful of uploads a year (ATO around June, ASFA a few times if lump sums move, the ABS survey around mid-2027). Automated fetching can be added later where it is safe, starting with a read-only watcher that tells you when something new has been published; writing numbers into live benchmarks automatically is not recommended.
