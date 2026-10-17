/**
 * Print tabs (PO feedback 17-10-2026: the Print / Save as PDF tab stayed open after printing and "Back to Dashboard" left two tabs
 * showing the same information). The shared behaviour lives in lib/reports/printTab.ts and components/reports/PrintTabToolbar.tsx.
 * There is no DOM environment in this repository (no jsdom), so the controller is driven with a fake window and a fake scheduler,
 * and the components are rendered with react-dom/server.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  PRINT_WINDOW_NAME_PREFIX,
  createPrintTabController,
  isScriptOpenedPrintTab,
  openPrintTab,
  type PrintWindowLike,
} from '@/lib/reports/printTab';
import { PrintTabStatus, PrintTabToolbar } from '@/components/reports/PrintTabToolbar';
import { OpenPrintTabLink } from '@/components/reports/OpenPrintTabLink';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

/** A fake window: records calls, lets the test fire `afterprint`, and decides whether close() is honoured. */
function fakeWindow(init: { name?: string; opener?: unknown; honourClose?: boolean; closeThrows?: boolean } = {}) {
  const listeners = new Set<() => void>();
  const calls = { print: 0, close: 0 };
  const w: PrintWindowLike & { fire(): void; listenerCount(): number } = {
    name: init.name ?? '',
    opener: init.opener ?? null,
    closed: false,
    print() {
      calls.print += 1;
    },
    close() {
      calls.close += 1;
      if (init.closeThrows) throw new Error('refused');
      if (init.honourClose) w.closed = true;
    },
    addEventListener(_t, l) {
      listeners.add(l);
    },
    removeEventListener(_t, l) {
      listeners.delete(l);
    },
    fire() {
      [...listeners].forEach((l) => l());
    },
    listenerCount: () => listeners.size,
  };
  return { w, calls };
}

/** A scheduler the test advances by hand, so "after 150 ms" is deterministic. */
function fakeScheduler() {
  let now = 0;
  const jobs: { at: number; fn: () => void; live: boolean }[] = [];
  return {
    schedule(fn: () => void, ms: number) {
      const job = { at: now + ms, fn, live: true };
      jobs.push(job);
      return () => {
        job.live = false;
      };
    },
    advance(ms: number) {
      now += ms;
      for (const j of jobs.filter((x) => x.live && x.at <= now).sort((a, b) => a.at - b.at)) {
        j.live = false;
        j.fn();
      }
    },
  };
}

describe('which tabs may be closed by script', () => {
  it('a tab the app opened (window name prefix, or an opener) is script-opened', () => {
    expect(isScriptOpenedPrintTab({ name: `${PRINT_WINDOW_NAME_PREFIX}net-worth-statement`, opener: null })).toBe(true);
    expect(isScriptOpenedPrintTab({ name: '', opener: {} })).toBe(true);
  });
  it('NEGATIVE CONTROL: a directly typed, bookmarked or plain target=_blank tab (no name, no opener) is not', () => {
    expect(isScriptOpenedPrintTab({ name: '', opener: null })).toBe(false);
    expect(isScriptOpenedPrintTab({ name: 'something-else', opener: null })).toBe(false);
  });
});

describe('afterprint closes the tab the app opened', () => {
  it('print dialog dismissed -> close() is called (after a short delay for a saved PDF to finish)', () => {
    const { w, calls } = fakeWindow({ name: `${PRINT_WINDOW_NAME_PREFIX}x`, honourClose: true });
    const clock = fakeScheduler();
    const c = createPrintTabController(w, { autoPrint: false, schedule: clock.schedule });
    c.start();
    w.fire(); // afterprint
    expect(calls.close).toBe(0); // not instantly
    clock.advance(150);
    expect(calls.close).toBe(1);
    clock.advance(1000);
    expect(c.getState()).toBe('closing'); // honoured: the window reports closed, no refusal message
  });

  it('also works when only window.opener is set (no name)', () => {
    const { w, calls } = fakeWindow({ opener: {}, honourClose: true });
    const clock = fakeScheduler();
    createPrintTabController(w, { autoPrint: false, schedule: clock.schedule }).start();
    w.fire();
    clock.advance(150);
    expect(calls.close).toBe(1);
  });

  it('NEGATIVE CONTROL: the very same afterprint in a tab the app did NOT open never calls close()', () => {
    const { w, calls } = fakeWindow({ name: '', opener: null });
    const clock = fakeScheduler();
    const c = createPrintTabController(w, { autoPrint: false, schedule: clock.schedule });
    c.start();
    w.fire();
    clock.advance(5000);
    expect(calls.close).toBe(0);
    expect(c.getState()).toBe('idle'); // the person uses the Close button instead
  });

  it('stopping the controller removes the listener (leaving the page never closes anything later)', () => {
    const { w, calls } = fakeWindow({ name: `${PRINT_WINDOW_NAME_PREFIX}x` });
    const clock = fakeScheduler();
    const stop = createPrintTabController(w, { autoPrint: false, schedule: clock.schedule }).start();
    expect(w.listenerCount()).toBe(1);
    stop();
    expect(w.listenerCount()).toBe(0);
    w.fire();
    clock.advance(1000);
    expect(calls.close).toBe(0);
  });
});

describe('auto print (the ?print=1 marker)', () => {
  it('opens the print dialog once, after the page has painted', () => {
    const { w, calls } = fakeWindow({ name: `${PRINT_WINDOW_NAME_PREFIX}x` });
    const clock = fakeScheduler();
    createPrintTabController(w, { autoPrint: true, schedule: clock.schedule }).start();
    expect(calls.print).toBe(0);
    clock.advance(300);
    expect(calls.print).toBe(1);
    clock.advance(5000);
    expect(calls.print).toBe(1);
  });
  it('without the marker it never prints on its own', () => {
    const { w, calls } = fakeWindow();
    const clock = fakeScheduler();
    createPrintTabController(w, { autoPrint: false, schedule: clock.schedule }).start();
    clock.advance(5000);
    expect(calls.print).toBe(0);
  });
  it('the Print button prints on demand', () => {
    const { w, calls } = fakeWindow();
    createPrintTabController(w, { autoPrint: false }).print();
    expect(calls.print).toBe(1);
  });
});

describe('"Close this tab": tries window.close(), and says so when the browser refuses', () => {
  it('refused (the tab was not script-opened): state becomes close_refused so the status shows "You can close this tab now."', () => {
    const { w, calls } = fakeWindow({ honourClose: false });
    const clock = fakeScheduler();
    const c = createPrintTabController(w, { autoPrint: false, schedule: clock.schedule });
    const seen: string[] = [];
    c.subscribe(() => seen.push(c.getState()));
    c.requestClose();
    expect(calls.close).toBe(1);
    expect(c.getState()).toBe('closing');
    clock.advance(400);
    expect(c.getState()).toBe('close_refused');
    expect(seen).toEqual(['closing', 'close_refused']);
  });

  it('honoured: no refusal message is ever shown', () => {
    const { w } = fakeWindow({ honourClose: true });
    const clock = fakeScheduler();
    const c = createPrintTabController(w, { autoPrint: false, schedule: clock.schedule });
    c.requestClose();
    clock.advance(1000);
    expect(c.getState()).toBe('closing');
  });

  it('a close() that throws is a refusal too', () => {
    const { w } = fakeWindow({ closeThrows: true });
    const c = createPrintTabController(w, { autoPrint: false });
    c.requestClose();
    expect(c.getState()).toBe('close_refused');
  });
});

describe('opening the print view from the app', () => {
  it('window.open from the click handler, in a named window with the print prefix (so the tab can close itself and is reused)', () => {
    const opened: { url: string; name: string }[] = [];
    const assigned: string[] = [];
    const result = openPrintTab({ open: (url, name) => (opened.push({ url, name }), {}), location: { assign: (u) => assigned.push(u) } }, '/reports/net-worth-statement/print?view=all&print=1', 'net-worth-statement');
    expect(result).toBe('opened');
    expect(opened).toEqual([{ url: '/reports/net-worth-statement/print?view=all&print=1', name: 'fhip-print-net-worth-statement' }]);
    expect(assigned).toEqual([]);
  });

  it('popup blocked (window.open returns null): falls back to this tab, where the Close / back controls take over', () => {
    const assigned: string[] = [];
    const result = openPrintTab({ open: () => null, location: { assign: (u) => assigned.push(u) } }, '/p', 'x');
    expect(result).toBe('same_tab');
    expect(assigned).toEqual(['/p']);
  });

  it('the link keeps a real href (no-JavaScript fallback) with noopener for that path only', () => {
    const html = renderToStaticMarkup(createElement(OpenPrintTabLink, { href: '/reports/net-worth-statement/print?view=all&print=1', windowName: 'net-worth-statement', className: 'c' }, 'Print / Save as PDF'));
    expect(html).toContain('href="/reports/net-worth-statement/print?view=all&amp;print=1"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(read('lib/reports/printTab.ts').replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/noopener/); // the script path never uses noopener
  });
});

describe('the toolbar markup', () => {
  const markup = renderToStaticMarkup(createElement(PrintTabToolbar, { autoPrint: true, parentHref: '/reports/net-worth-statement?view=personal', parentLabel: 'Net Worth Statement' }));

  it('has Print / Save as PDF and a Close this tab button, and NO "Back to Dashboard" or other navigation', () => {
    expect(markup).toContain('Print / Save as PDF');
    expect(markup).toContain('Close this tab');
    expect(markup).not.toMatch(/Back to Dashboard|Back to Reports|<a /);
  });

  it('is hidden when printing (no-print), buttons are real buttons with a visible keyboard focus style, and the status is a live region', () => {
    expect(markup).toContain('class="no-print');
    expect((markup.match(/<button type="button"/g) ?? []).length).toBe(2);
    expect(markup).toContain('focus-visible:outline');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
  });

  it('the fallback status: "You can close this tab now." plus a link back to the parent page (focusable <a>)', () => {
    const idle = renderToStaticMarkup(createElement(PrintTabStatus, { refused: false, parentHref: '/reports', parentLabel: 'Reports' }));
    expect(idle).toContain('role="status"');
    expect(idle).not.toContain('You can close this tab now.');
    const refused = renderToStaticMarkup(createElement(PrintTabStatus, { refused: true, parentHref: '/reports', parentLabel: 'Reports' }));
    expect(refused).toContain('You can close this tab now.');
    expect(refused).toContain('href="/reports"');
    expect(refused).toContain('Back to Reports');
  });

  it('shows no ISO date anywhere (it shows no date at all)', () => {
    expect(markup).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

describe('every report print route uses the ONE shared helper', () => {
  const routes = {
    statement: 'app/(print)/reports/net-worth-statement/print/page.tsx',
    monthly: 'app/(print)/reports/[id]/print/page.tsx',
    forecast: 'app/(print)/forecast/report/print/page.tsx',
  };

  it('all three render <PrintTabToolbar> and none of them has a "Back to Dashboard" button or a PageBackLink', () => {
    for (const [name, file] of Object.entries(routes)) {
      const src = read(file);
      expect(src, name).toContain('<PrintTabToolbar');
      expect(src, name).not.toMatch(/Back to Dashboard|<PageBackLink/);
    }
  });

  it('the old statement-only toolbar is gone (one helper, not two)', () => {
    expect(() => read('components/reports/netWorthStatement/PrintToolbar.tsx')).toThrow();
  });

  it('the Monthly Report print route shows the toolbar to a signed-in person only, never to the headless PDF renderer (token)', () => {
    expect(read(routes.monthly)).toContain('{user && !token ? <PrintTabToolbar');
    expect(read(routes.forecast)).toMatch(/if \(token\) \{[\s\S]*?return \([\s\S]*?\);\s*\}[\s\S]*PrintTabToolbar/); // the token branch returns before the toolbar
  });

  it('the statement SCREEN route is unchanged except that its Print button now opens the tab from a click handler; it keeps its back link to Reports', () => {
    const page = read('app/(app)/reports/net-worth-statement/page.tsx');
    expect(page).toContain('<OpenPrintTabLink');
    expect(page).toContain('windowName="net-worth-statement"');
    expect(page).toContain('<PageBackLink href="/reports" label="Reports" />');
    expect(page).not.toContain('target="_blank"'); // the anchor lives in the shared component
  });

  it('the print CSS hides the toolbar: no-print is display:none under @media print', () => {
    expect(read('app/globals.css')).toMatch(/@media print \{\s*\.no-print \{\s*display: none !important;/);
  });
});
