/** Tiny client for scripts/canonical_cert/ui_driver.ts (headless Chromium signed in as one fixture user, localhost only). */
export const CONTROL = Number(process.env.CERT_UI_CONTROL ?? 3995);
export async function act(body) {
  const res = await fetch(`http://127.0.0.1:${CONTROL}/act`, { method: 'POST', body: JSON.stringify(body) });
  const j = await res.json();
  if (!j.ok) throw new Error(`ui act ${JSON.stringify(body)} failed: ${String(j.error).slice(0, 300)}`);
  return j.out?.[0];
}
export const goto = (url) => act({ a: 'goto', url });
export const wait = (ms) => act({ a: 'wait', ms });
export const waitText = (text, ms = 30000) => act({ a: 'wait', text, ms });
export const shot = (name, full = false) => act({ a: 'shot', name, full });
export const text = async (sel, max = 6000) => (await act({ a: 'text', sel, max })) ?? '';
export const evalJs = (js) => act({ a: 'eval', js });
export const controls = () => act({ a: 'controls' });

/** poll a predicate over the page text until true (or give up) */
export async function waitFor(fn, tries = 20, ms = 1500) {
  for (let i = 0; i < tries; i++) { if (await fn()) return true; await act({ a: 'wait', ms }); }
  return false;
}
export const selectReady = () => evalJs(`(() => { const s = document.querySelector('select'); return !!s && !s.disabled; })()`);
