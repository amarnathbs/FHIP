// SYNTHETIC RBI-shaped pages for the refresh tests. They reproduce the STRUCTURE of the three pages the weekly refresh reads
// (month listing, "Treasury Bills: Full Auction Result", the weekly NSDP page), with invented numbers where a number is needed
// (yields are fixture values, not RBI data). No RBI page is committed to the repository.

export interface ReleaseOpts {
  title?: string;
  dateText?: string; // "Sep 30, 2026"
  releaseNo?: string | null;
  columns?: string[]; // header labels, default 91/182/364
  price?: string[]; // row III cut-off prices per column
  ytm?: string[]; // "(YTM: x%)" per column
  noPressReleaseLine?: boolean;
}

export function releaseHtml(o: ReleaseOpts = {}): string {
  const columns = o.columns ?? ['91-Day', '182-Day', '364-Day'];
  const price = o.price ?? ['98.7000', '97.2000', '94.3000'];
  const ytm = o.ytm ?? ['(YTM: 5.2000%)', '(YTM: 5.9000%)', '(YTM: 6.2000%)'];
  const cell = (v: string) => `<td align="right">${v}</td>`;
  return `<html><head><title>RBI - Press Releases</title><script>var x = "Treasury Bills: Full Auction Result";</script></head><body>
<table><tr><td align="right" class="tableheader"><b> Date : ${o.dateText ?? 'Sep 30, 2026'}</b></td></tr>
<tr><td align="center" class="tableheader"><b>${o.title ?? 'Treasury Bills: Full Auction Result'}</b></td></tr>
<tr class="tablecontent1"><td><table><tr><td colspan="5" align="right">(Amount in &#8377; crore)</td></tr>
<tr class="head"><td colspan="2" align="center">Auction Results</td>${columns.map((c) => `<td align="center">${c}</td>`).join('')}</tr>
<tr><td align="center">I.</td><td>Notified Amount</td>${cell('9,000')}${cell('8,000')}${cell('7,000')}</tr>
<tr><td rowspan="3" valign="top">II.</td><td>Competitive Bids Received</td>${cell('&nbsp;')}${cell('&nbsp;')}${cell('&nbsp;')}</tr>
<tr><td>(i) Number</td>${cell('63')}${cell('58')}${cell('78')}</tr>
<tr><td>(ii) Amount</td>${cell('14,440.500')}${cell('11,531.500')}${cell('18,010.000')}</tr>
<tr><td rowspan="2" align="center" valign="top">III.</td><td rowspan="2" valign="top">Cut-off price (&#8377;) / Yield</td>${price.map(cell).join('')}</tr>
<tr>${ytm.map(cell).join('')}</tr>
<tr><td rowspan="3" valign="top">IV.</td><td>Competitive Bids Accepted</td>${cell('&nbsp;')}${cell('&nbsp;')}${cell('&nbsp;')}</tr>
</table></td></tr></table>
${o.noPressReleaseLine ? '' : `<p class="head">Press Release: ${o.releaseNo === null ? '' : (o.releaseNo ?? '2026-2027/1218')}</p>`}
</body></html>`;
}

export function listingHtml(groups: Array<{ date: string; items: Array<{ prid: string; title: string }> }>, hidden: Record<string, string> = { __VIEWSTATE: 'VS', __EVENTVALIDATION: 'EV', hdnYear: '2026', hdnMonth: '9' }): string {
  return `<html><body><form method="post" action="./BS_PressReleaseDisplay.aspx" id="form1">
${Object.entries(hidden).map(([k, v]) => `<input type="hidden" name="${k}" id="${k}" value="${v}" />`).join('\n')}
<table class="tablebg" width="100%">${groups
    .map((g) => `<tr><td class="tableheader" colspan="4" align="left"><b>${g.date}<b></td></tr>${g.items.map((i) => `<tr><td><a class='link2' href=BS_PressReleaseDisplay.aspx?prid=${i.prid}>${i.title}</a></td><td nowrap colspan=3><a href='https://rbidocs.example.invalid/x.PDF'><img alt='PDF - ${i.title}'></a></td></tr>`).join('')}`)
    .join('')}</table></form></body></html>`;
}

export function nsdpHtml(o: { years?: string[]; dates?: string[]; yields?: string[]; repo?: string[]; omitYield?: boolean; omitRepo?: boolean } = {}): string {
  const dates = o.dates ?? ['Sep. 26', 'Aug. 28', 'Sep. 4', 'Sep. 11', 'Sep. 18', 'Sep. 25'];
  const years = o.years ?? ['2025', '2026'];
  const yields = o.yields ?? ['5.47', '5.26', '5.26', '5.21', '5.28', '5.39'];
  const repo = o.repo ?? ['5.50', '5.25', '5.25', '5.25', '5.25', '5.25'];
  const row = (label: string, v: string[]) => `<tr><td>${label}</td>${v.map((x) => `<td align="right">${x}</td>`).join('')}</tr>`;
  return `<html><body><table>
<tr><td rowspan="3" align="center"><span class="head">Item/Week Ended</span></td><td align="center"><span class="head">${years[0]}</span></td><td colspan="5" align="center"><span class="head">${years[1]}</span></td></tr>
<tr>${dates.map((d) => `<td align="center"><span class="head">${d}</span></td>`).join('')}</tr>
<tr><td align="center">Rates</td></tr>
${o.omitRepo ? '' : row('Policy Repo Rate', repo)}
${row('Fixed Reverse Repo Rate', ['3.35', '3.35', '3.35', '3.35', '3.35', '3.35'])}
${row('Call Money Rate (Weighted Average)', ['5.57', '5.20', '5.07', '4.97', '5.05', '5.19'])}
${o.omitYield ? '' : row('91-Day Treasury Bill (Primary) Yield', yields)}
${row('182-Day Treasury Bill (Primary) Yield', ['5.58', '5.62', '5.66', '5.62', '5.75', '5.82'])}
</table></body></html>`;
}
