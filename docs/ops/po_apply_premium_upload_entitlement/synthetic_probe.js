/*
 * Premium Upload Entitlement -- synthetic probe. Paste into the browser console on the target site (for example
 * https://app.financialhealthplatform.com) while signed in as ONE synthetic customer, once for the synthetic FREE user
 * and once for the synthetic PREMIUM user. Never use a real customer.
 *
 * It sends only requests that CANNOT create data: empty or invalid bodies and random document ids. A Free user must be
 * refused before anything is looked at; a Premium user passes the Premium check and is then stopped by the route's own
 * validation (422), "not found" (404) or a feature flag (403 without the Premium code). Nothing is stored, queued or sent
 * to a provider by this probe. It prints a table and a JSON block to paste into EVIDENCE_TEMPLATE.md.
 */
(async () => {
  const RANDOM_UUID = '00000000-0000-4000-8000-000000000000';
  const post = (path, init = {}) => fetch(path, { method: 'POST', credentials: 'same-origin', ...init });
  const json = (body) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const probes = [
    // ADMISSION
    ['fdh.upload_session.create', 'admission', () => post('/api/financial-data-hub/documents/upload-sessions', json({}))],
    ['fdh.upload_session.complete', 'admission', () => post(`/api/financial-data-hub/documents/upload-sessions/${RANDOM_UUID}/complete`)],
    ['fdh.bank_csv.upload', 'admission', () => post('/api/financial-data-hub/bank-csv/upload')],
    ['fdh.bank_pdf.upload', 'admission', () => post('/api/financial-data-hub/bank-pdf/upload')],
    ['fdh.liability_statement.upload', 'admission', () => post('/api/financial-data-hub/liability-statement/upload')],
    ['fdh.investment_statement.upload', 'admission', () => post('/api/financial-data-hub/investment-statement/upload')],
    ['fdh.retirement_statement.upload', 'admission', () => post('/api/financial-data-hub/retirement-statement/upload')],
    ['aie.intake.upload', 'admission', () => post('/api/aie/intake')],
    ['aie.insurance.intake', 'admission', () => post('/api/aie/insurance/intake')],
    ['aie.fdh_bank.intake', 'admission', () => post('/api/aie/fdh-bank/intake')],
    ['aie.investment_intelligence.intake', 'admission', () => post('/api/aie/investment-intelligence/intake')],
    ['ii.source_document.upload', 'admission', () => post('/api/investment-intelligence/source-documents')],
    ['ii.source_document.parse_fixture', 'admission', () => post(`/api/investment-intelligence/source-documents/${RANDOM_UUID}/parse`, json({}))],
    // RUN START (random document id: a Free user is refused; a Premium user gets "not found")
    ...[
      ['fdh.bank_csv.detect', 'bank-csv', 'detect'], ['fdh.bank_csv.map', 'bank-csv', 'map'], ['fdh.bank_csv.process', 'bank-csv', 'process'],
      ['fdh.bank_pdf.process', 'bank-pdf', 'process'], ['fdh.bank_pdf.ai_fallback_confirm', 'bank-pdf', 'ai-fallback/confirm'],
      ['fdh.payslip.process', 'payslip', 'process'], ['fdh.payslip.ai_fallback_confirm', 'payslip', 'ai-fallback/confirm'],
      ['fdh.liability_statement.process', 'liability-statement', 'process'], ['fdh.liability_statement.ai_fallback_confirm', 'liability-statement', 'ai-fallback/confirm'],
      ['fdh.investment_statement.process', 'investment-statement', 'process'], ['fdh.investment_statement.ai_fallback_confirm', 'investment-statement', 'ai-fallback/confirm'],
      ['fdh.retirement_statement.process', 'retirement-statement', 'process'], ['fdh.retirement_statement.ai_fallback_confirm', 'retirement-statement', 'ai-fallback/confirm'],
    ].map(([id, dir, step]) => [id, 'run_start', () => post(`/api/financial-data-hub/${dir}/${RANDOM_UUID}/${step}`, json({}))]),
    ['aie.investment_intelligence.process', 'run_start', () => post(`/api/aie/investment-intelligence/intake/${RANDOM_UUID}/process`, json({}))],
    ['ii.source_document.process', 'run_start', () => post(`/api/investment-intelligence/source-documents/${RANDOM_UUID}/process`, json({}))],
  ];

  const status = await fetch('/api/financial-data-hub/upload-status', { credentials: 'same-origin' }).then((r) => r.json()).catch(() => null);
  const rows = [];
  for (const [surface, kind, run] of probes) {
    let httpStatus = null, code = null, note = '';
    try {
      const res = await run();
      httpStatus = res.status;
      const body = await res.json().catch(() => null);
      code = body && body.code ? body.code : null;
      note = body && (body.error || body.message) ? String(body.error || body.message).slice(0, 90) : '';
    } catch (e) {
      note = 'network error: ' + (e && e.message);
    }
    const premiumRefusal = code === 'PREMIUM_REQUIRED';
    rows.push({ surface, kind, httpStatus, code, premiumRefusal, note });
  }
  console.table(rows.map(({ surface, kind, httpStatus, code, premiumRefusal }) => ({ surface, kind, httpStatus, code, premiumRefusal })));
  const refused = rows.filter((r) => r.premiumRefusal).length;
  const unavailable = rows.filter((r) => r.code === 'ENTITLEMENT_UNAVAILABLE').length;
  const serverErrors = rows.filter((r) => r.httpStatus >= 500 && r.code !== 'ENTITLEMENT_UNAVAILABLE').map((r) => r.surface);
  console.log('upload-status import_access =', status && status.data && status.data.import_access);
  console.log(`PREMIUM_REQUIRED on ${refused} of ${rows.length}; ENTITLEMENT_UNAVAILABLE on ${unavailable}; unexpected 5xx on: ${serverErrors.join(', ') || 'none'}`);
  console.log('EXPECTED  FREE   user: 28 of 28 PREMIUM_REQUIRED (HTTP 403), import_access = premium_required');
  console.log('EXPECTED  PREMIUM user: 0 of 28 PREMIUM_REQUIRED (statuses 400/403-without-code/404/422), import_access = allowed');
  console.log('EVIDENCE JSON:\n' + JSON.stringify({ at: new Date().toISOString(), origin: location.origin, import_access: status && status.data && status.data.import_access, rows }, null, 2));
})();
