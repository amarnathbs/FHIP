// NAV2 Stage 2 -- the deterministic RBI HTML readers (synthetic pages of the live structure).
//
// Matrix: Stage 2 rows S2-23 (the auction release is read by column LABEL, date and release number included), S2-24 (gap / no
// accepted bids), S2-25 (a layout change is a null, never a wrong number), S2-26 (NSDP latest week), S2-27 (the month listing).
//
// NAMED NEGATIVE CONTROLS
//   NC-H1  a different title, a missing "91-Day" header, a missing price row, a non-numeric price or a missing yield is null;
//   NC-H2  columns in a different order still yield the 91-day figure (read by label); with no 91-day label, null;
//   NC-H3  a dash price WITH a yield is a surprise (null), a dash price with a dash yield is "no accepted bids";
//   NC-H4  a price outside (0,100) is null (a unit mistake never becomes a yield);
//   NC-H5  NSDP: no rows, no date header, no year, or a non-numeric latest cell is unavailable; a missing row is null for that field only;
//   NC-H6  scripts and styles never contribute text (a title inside a script block does not count).
import { describe, expect, it } from 'vitest';
import { auctionTextForAi, decodeEntities, htmlToRows, parseAuctionResultHtml, parseHiddenFields, parseMonthListing, parseNsdpHtml, parseRbiDate } from '@/lib/services/investment-intelligence/nav2/rbiHtml';
import { listingHtml, nsdpHtml, releaseHtml } from './support/rbiPages';

describe('text helpers', () => {
  it('decodes entities and numeric references; unknown entities are left alone', () => {
    expect(decodeEntities('a &amp; b &#8377; &#x20B9; &nbsp;c &unknown;')).toBe('a & b ₹ ₹  c &unknown;');
  });
  it('parses RBI dates (month name, optional full name) and rejects impossible ones', () => {
    expect(parseRbiDate('Date : Sep 30, 2026')).toBe('2026-09-30');
    expect(parseRbiDate('September 15, 2026')).toBe('2026-09-15');
    expect(parseRbiDate('Sept 1, 2026')).toBe('2026-09-01');
    expect(parseRbiDate('Feb 30, 2026')).toBeNull();
    expect(parseRbiDate('30-09-2026')).toBeNull();
  });
  it('NC-H6: a title inside a script block does not count as text', () => {
    expect(htmlToRows('<script>var t="Treasury Bills: Full Auction Result";</script><table><tr><td>x</td></tr></table>').join('\n')).not.toContain('Treasury');
  });
});

describe('the auction release (matrix 64, 65, 66)', () => {
  it('reads date, release number, the 91-day cut-off price and yield', () => {
    expect(parseAuctionResultHtml(releaseHtml())).toEqual({ releaseNumber: '2026-2027/1218', title: 'Treasury Bills: Full Auction Result', auctionDate: '2026-09-30', cutoffPrice: 98.7, cutoffYieldPercent: 5.2, noAcceptedBids: false });
  });
  it('NC-H2: reads the 91-day figures BY LABEL when the columns are in a different order', () => {
    const r = parseAuctionResultHtml(releaseHtml({ columns: ['182-Day', '91-Day', '364-Day'], price: ['97.2000', '98.7000', '94.3000'], ytm: ['(YTM: 5.9000%)', '(YTM: 5.2000%)', '(YTM: 6.2000%)'] }));
    expect(r).toMatchObject({ cutoffPrice: 98.7, cutoffYieldPercent: 5.2 });
  });
  it('NC-H2: without a 91-day label it is null (no positional guess)', () => {
    expect(parseAuctionResultHtml(releaseHtml({ columns: ['182-Day', '364-Day', '28-Day'] }))).toBeNull();
  });
  it('NC-H1: a different title is null (the sibling short-form release is not used)', () => {
    expect(parseAuctionResultHtml(releaseHtml({ title: '91-Day, 182-Day and 364-Day T-Bill Auction Result: Cut-off' }))).toBeNull();
  });
  it('NC-H1: a missing price row, a non-numeric price and a missing yield are null', () => {
    expect(parseAuctionResultHtml(releaseHtml().replace('Cut-off price', 'Something else'))).toBeNull();
    expect(parseAuctionResultHtml(releaseHtml({ price: ['n/q', '97.2000', '94.3000'] }))).toBeNull();
    expect(parseAuctionResultHtml(releaseHtml({ ytm: ['', '(YTM: 5.9000%)', '(YTM: 6.2000%)'] }))).toBeNull();
  });
  it('NC-H4: a price outside (0, 100) is null', () => {
    expect(parseAuctionResultHtml(releaseHtml({ price: ['987.000', '97.2000', '94.3000'] }))).toBeNull();
    expect(parseAuctionResultHtml(releaseHtml({ price: ['0.0000', '97.2000', '94.3000'] }))).toBeNull();
  });
  it('NC-H3 / matrix 65: dashes in both cells mean no accepted bids; a dash price with a yield is a surprise (null)', () => {
    const gap = parseAuctionResultHtml(releaseHtml({ price: ['-', '97.2000', '94.3000'], ytm: ['-', '(YTM: 5.9000%)', '(YTM: 6.2000%)'] }));
    expect(gap).toMatchObject({ noAcceptedBids: true, cutoffPrice: null, cutoffYieldPercent: null, auctionDate: '2026-09-30' });
    expect(parseAuctionResultHtml(releaseHtml({ price: ['-', '97.2000', '94.3000'] }))).toBeNull();
  });
  it('a missing date line yields a reading with a null date (the gate then sends it to review); a missing release number is null', () => {
    expect(parseAuctionResultHtml(releaseHtml().replace('Date : Sep 30, 2026', 'Published'))?.auctionDate).toBeNull();
    expect(parseAuctionResultHtml(releaseHtml({ releaseNo: null }))?.releaseNumber).toBeNull();
    expect(parseAuctionResultHtml(releaseHtml({ noPressReleaseLine: true }))?.releaseNumber).toBeNull();
  });
  it('a page that is not a release at all is null', () => {
    expect(parseAuctionResultHtml('<html><body>Access denied</body></html>')).toBeNull();
    expect(parseAuctionResultHtml('')).toBeNull();
  });
  it('the AI is shown only the result table text (bounded), never the whole page', () => {
    const t = auctionTextForAi(releaseHtml());
    expect(t).toContain('Cut-off price');
    expect(t).toContain('2026-2027/1218');
    expect(t.length).toBeLessThanOrEqual(6000);
    expect(t).not.toContain('<td');
  });
});

describe('the month listing (matrix 68)', () => {
  const html = listingHtml([
    { date: 'Sep 30, 2026', items: [{ prid: '63703', title: 'RBI to conduct 4-day VRRR auction' }, { prid: '63696', title: 'Treasury Bills: Full Auction Result' }] },
    { date: 'Sep 23, 2026', items: [{ prid: '63650', title: 'Treasury Bills: Full Auction Result' }] },
  ]);
  it('returns each link with the date of the group it sits in, in page order', () => {
    expect(parseMonthListing(html)).toEqual([
      { date: '2026-09-30', prid: '63703', title: 'RBI to conduct 4-day VRRR auction' },
      { date: '2026-09-30', prid: '63696', title: 'Treasury Bills: Full Auction Result' },
      { date: '2026-09-23', prid: '63650', title: 'Treasury Bills: Full Auction Result' },
    ]);
  });
  it('a link before any date header is ignored (it cannot be dated); an empty page is an empty list', () => {
    expect(parseMonthListing("<a href=BS_PressReleaseDisplay.aspx?prid=1>Orphan</a>")).toEqual([]);
    expect(parseMonthListing('')).toEqual([]);
  });
  it('reads the hidden form fields the archive form needs', () => {
    expect(parseHiddenFields(html)).toMatchObject({ __VIEWSTATE: 'VS', __EVENTVALIDATION: 'EV', hdnYear: '2026', hdnMonth: '9' });
  });
});

describe('the NSDP weekly page (matrix 67)', () => {
  it('reads the LAST week column: its date (with the year) and the 91-day yield and repo rate of that column', () => {
    expect(parseNsdpHtml(nsdpHtml())).toEqual({ state: 'value', weekEnded: '2026-09-25', yield91dPercent: 5.39, policyRepoPercent: 5.25 });
  });
  it('a missing row is null for that field only', () => {
    expect(parseNsdpHtml(nsdpHtml({ omitRepo: true }))).toMatchObject({ state: 'value', yield91dPercent: 5.39, policyRepoPercent: null });
    expect(parseNsdpHtml(nsdpHtml({ omitYield: true }))).toMatchObject({ state: 'value', yield91dPercent: null, policyRepoPercent: 5.25 });
  });
  it('NC-H5: no rows, no date header, no year, or a non-numeric latest cell is unavailable', () => {
    expect(parseNsdpHtml('<html><body>nothing</body></html>')).toEqual({ state: 'unavailable' });
    expect(parseNsdpHtml(nsdpHtml().replace(/Sep\. \d+|Aug\. 28/g, 'wk'))).toEqual({ state: 'unavailable' });
    expect(parseNsdpHtml(nsdpHtml({ years: ['abcd', 'efgh'] }))).toEqual({ state: 'unavailable' });
    expect(parseNsdpHtml(nsdpHtml({ yields: ['5.47', '5.26', '5.26', '5.21', '5.28', '..'], omitRepo: true }))).toEqual({ state: 'unavailable' });
  });
  it('a week at the start of a year takes that year from the header', () => {
    expect(parseNsdpHtml(nsdpHtml({ years: ['2026', '2027'], dates: ['Jan. 2', 'Dec. 11', 'Dec. 18', 'Dec. 25', 'Jan. 1', 'Jan. 8'] }))).toMatchObject({ weekEnded: '2027-01-08' });
  });
});
