// NAV2 Stage 2 -- where the refresh job gets its pages. `RbiSource` is the seam: the job and its tests depend on this interface;
// the live implementation below reads three pages through the polite fetcher and does nothing else.
//
//   1. the press-release listing for the expected auction's month (the page's own month archive form is used when the current
//      listing is for a different month),
//   2. the single "Treasury Bills: Full Auction Result" release for that auction (found in the listing; no URL is ever guessed),
//   3. the weekly NSDP page (BS_NSDPDisplay.aspx?param=4).
//
// STATUS (honest): the archive-form request (hdnYear / hdnMonth posted with the page's own hidden fields) is inferred from a saved
// copy of the page and has NOT been exercised against the live site by this code. The first DEV dry run is the check (Stage 3).

import { AUCTION_RESULT_TITLE, parseHiddenFields, parseMonthListing } from './rbiHtml';
import { PoliteRbiFetcher, RBI_ORIGIN } from './rbiFetcher';

export const RBI_LISTING_URL = `${RBI_ORIGIN}/Scripts/BS_PressReleaseDisplay.aspx`;
export const RBI_NSDP_URL = `${RBI_ORIGIN}/Scripts/BS_NSDPDisplay.aspx?param=4`;
export const releaseUrl = (prid: string): string => `${RBI_ORIGIN}/Scripts/BS_PressReleaseDisplay.aspx?prid=${encodeURIComponent(prid)}`;

export type ReleaseSearch =
  | { found: false; reason: string }
  | { found: true; prid: string; releaseDate: string; url: string; html: string };

export interface RbiSource {
  /** The auction release dated `expectedDate` or up to two days later (a holiday-shifted auction), or "not found yet". */
  findAuctionRelease(expectedDate: string): Promise<ReleaseSearch>;
  /** The weekly NSDP page HTML, or null when it could not be obtained. */
  readNsdp(): Promise<string | null>;
  requestsMade(): { pages: number; robots: number };
}

const addDays = (iso: string, n: number): string => {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export function createLiveRbiSource(fetcher: PoliteRbiFetcher = new PoliteRbiFetcher()): RbiSource {
  return {
    async findAuctionRelease(expectedDate) {
      let listingPage = await fetcher.get(RBI_LISTING_URL);
      let items = parseMonthListing(listingPage.html ?? '');
      const hidden = parseHiddenFields(listingPage.html ?? '');
      const wantYear = expectedDate.slice(0, 4);
      const wantMonth = String(Number(expectedDate.slice(5, 7)));
      const shown = items.length > 0 ? items[0].date : null;
      const shownMatches = (hidden.hdnYear === wantYear && hidden.hdnMonth === wantMonth) || (shown !== null && shown.slice(0, 7) === expectedDate.slice(0, 7));
      if (!shownMatches && hidden.__VIEWSTATE !== undefined) {
        listingPage = await fetcher.post(RBI_LISTING_URL, { ...hidden, hdnYear: wantYear, hdnMonth: wantMonth, 'UsrFontCntr$btn': '' });
        items = parseMonthListing(listingPage.html ?? '');
      }
      const window = [expectedDate, addDays(expectedDate, 1), addDays(expectedDate, 2)];
      const hit = items.filter((i) => i.title === AUCTION_RESULT_TITLE && window.includes(i.date)).sort((a, b) => (a.date < b.date ? -1 : 1))[0];
      if (!hit) return { found: false, reason: 'No "Treasury Bills: Full Auction Result" release for the expected auction is in the listing yet.' };
      const page = await fetcher.get(releaseUrl(hit.prid));
      return { found: true, prid: hit.prid, releaseDate: hit.date, url: releaseUrl(hit.prid), html: page.html ?? '' };
    },
    async readNsdp() {
      try {
        const page = await fetcher.get(RBI_NSDP_URL);
        return page.html;
      } catch {
        return null; // the cross-check is simply unavailable; the gate decides what that means
      }
    },
    requestsMade: () => ({ pages: fetcher.pageRequestsMade, robots: fetcher.robotsRequestsMade }),
  };
}
