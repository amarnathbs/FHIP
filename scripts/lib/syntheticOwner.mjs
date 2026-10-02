/**
 * Owner-before-upload -- synthetic owner context for certification / live-DEV scripts.
 *
 * Every financial-document upload route now REQUIRES the owner chosen BEFORE the file is sent
 * (query `owner=<json>` for the bank / liability / retirement / AU-investment CSV and PDF routes, `owner`
 * in the upload-session body, `meta.owner` for Investment Intelligence). A script that uploads without one
 * is refused with 422 owner_required -- which is the intended behaviour, and which each script can still
 * prove with an explicit negative control (pass `owner: null` / `noOwner`).
 *
 * This module gives scripts a VALID synthetic owner for the fixture user they are already signed in as:
 *   - 'self'    -> the user's own household member (POST /api/ownership/self; idempotent, user-scoped)
 *   - 'spouse'  -> the user's spouse / partner member (an existing one; else a clearly-labelled synthetic one
 *                  is added to THAT fixture user's own household through POST /api/household-members)
 *   - 'joint'   -> {kind:'joint'} (bank / liability / retirement) or a 50/50 self+spouse split (AU investment)
 *   - 'smsf'    -> {kind:'smsf'} (AU)
 * It never reads or writes anything except through the app's own authenticated routes, and never touches a
 * credential. `request(method, route, json?)` is the caller's own signed-in HTTP function and must return
 * `{ status, json }`.
 */

const ROUTE_FLOWS = [
  [/\/financial-data-hub\/bank-(csv|pdf)\/upload(\?|$)/, 'bank'],
  [/\/financial-data-hub\/liability-statement\/upload(\?|$)/, 'liability'],
  [/\/financial-data-hub\/retirement-statement\/upload(\?|$)/, 'retirement'],
  [/\/financial-data-hub\/investment-statement\/upload(\?|$)/, 'au_investment'],
];

/** document_type (upload-sessions body) -> owner flow. Mirrors OWNER_FLOW_FOR_DOCUMENT_TYPE. */
export const DOCUMENT_TYPE_FLOWS = {
  bank_statement: 'bank',
  payslip: 'payslip',
  credit_card_statement: 'liability',
  loan_statement: 'liability',
  super_statement: 'retirement',
  epf_statement: 'retirement',
  nps_statement: 'retirement',
  investment_statement: 'au_investment',
};

export function flowForUploadRoute(route) {
  for (const [re, flow] of ROUTE_FLOWS) if (re.test(route)) return flow;
  return null;
}

export function flowForDocumentType(documentType) {
  return DOCUMENT_TYPE_FLOWS[documentType] ?? null;
}

/**
 * Resolves a wire owner selection for `role` ('self' | 'spouse' | 'joint' | 'smsf') on `flow`.
 * Throws a clear error if the fixture user cannot take that owner (never silently falls back to Self).
 */
export async function resolveSyntheticOwner(request, role, flow) {
  const r = role === 'partner' ? 'spouse' : role;
  if (r === 'smsf') return { kind: 'smsf' };
  const selfId = await ensureSelf(request);
  if (r === 'self') return { kind: 'member', memberId: selfId };
  const spouseId = await ensureSpouse(request, flow);
  if (r === 'spouse') return { kind: 'member', memberId: spouseId };
  if (r === 'joint') {
    if (flow === 'au_investment') {
      return { kind: 'joint', allocations: [{ memberId: selfId, basisPoints: 5000 }, { memberId: spouseId, basisPoints: 5000 }] };
    }
    return { kind: 'joint' };
  }
  throw new Error(`syntheticOwner: unsupported owner role '${role}'`);
}

async function ensureSelf(request) {
  const res = await request('POST', '/api/ownership/self');
  const id = res.json?.data?.memberId;
  if (res.status >= 300 || !id) throw new Error(`syntheticOwner: could not resolve the user's Self member (HTTP ${res.status})`);
  return id;
}

async function ensureSpouse(request, flow) {
  const opts = await request('GET', `/api/ownership/options?flow=${flow ?? 'bank'}`);
  const found = (opts.json?.data?.members ?? []).find((m) => m.ownerRole === 'spouse');
  if (found) return found.id;
  const created = await request('POST', '/api/household-members', { full_name: 'FHIP Synthetic Spouse', relationship: 'spouse' });
  const id = created.json?.data?.id;
  if (created.status >= 300 || !id) throw new Error(`syntheticOwner: could not add a spouse member for this fixture user (HTTP ${created.status})`);
  return id;
}

/** `route` with `owner=<json>` set and the retired loose `owner_role` removed. */
export function routeWithOwner(route, selection) {
  const [pathPart, query = ''] = route.split('?');
  const params = new URLSearchParams(query);
  params.delete('owner_role');
  params.set('owner', JSON.stringify(selection));
  return `${pathPart}?${params.toString()}`;
}

/** The legacy loose role a script passed (`owner_role=spouse`), or null. */
export function legacyOwnerRoleOf(route) {
  const query = route.split('?')[1];
  return query ? new URLSearchParams(query).get('owner_role') : null;
}

export function routeHasOwner(route) {
  const query = route.split('?')[1];
  return query ? new URLSearchParams(query).has('owner') : false;
}

/**
 * Builds the `request` function for a script that signs in with a raw cookie header and uses fetch:
 *   const owner = await resolveSyntheticOwner(fetchOwnerRequest(APP, user.cookie), 'self', 'bank');
 */
export function fetchOwnerRequest(app, cookie) {
  return async (method, route, json) => {
    const res = await fetch(`${app}${route}`, {
      method,
      headers: { Cookie: cookie, ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: json !== undefined ? JSON.stringify(json) : undefined,
    });
    let parsed = null;
    try {
      parsed = await res.json();
    } catch {
      /* not json */
    }
    return { status: res.status, json: parsed };
  };
}
