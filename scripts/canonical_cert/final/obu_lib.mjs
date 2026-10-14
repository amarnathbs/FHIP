/**
 * Owner-before-upload DEV certification: shared helpers (DEV only, localhost app, existing fixture users only).
 * - every DB read goes through the harness service client (read only unless a function says otherwise)
 * - every app call goes through the harness session (cookies of an existing fixture user)
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadDevEnv, serviceClient } from '../lib/env.mjs';
import { api } from '../lib/session.mjs';

export const PORT = Number(process.env.CERT_PORT ?? 3991);
export const USERS = {
  AU1: 'forecast.tc004@example.test',
  AU2: 'forecast.tc009@example.test',
  IN1: 'forecast.tc083@example.test',
  IN2: 'fhip.e2e.tc031@test.fhip.invalid',
};
export const CAS_DIR = path.resolve('lib', 'fixtures', 'investment-intelligence', 'pc3-cams');

export function hostGuard() {
  const { url } = loadDevEnv();
  const host = new URL(url).host;
  if (host !== 'vqycarelcoijzwlpkpcz.supabase.co') throw new Error(`REFUSING: ${host}`);
  return host;
}

export const results = [];
export function record(step, label, ok, detail = '') {
  results.push({ step, label, ok: ok === null ? 'INFO' : !!ok, detail });
  console.log(`${ok === null ? 'INFO' : ok ? 'PASS' : 'FAIL'}  [${step}] ${label}${detail ? '  :: ' + String(detail).slice(0, 400) : ''}`);
}
/** Writes this run's results; results already in the file for OTHER labels are kept (a partial re-run never erases earlier evidence). */
export function saveResults(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let old = [];
  try { old = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first write */ }
  const mine = new Set(results.map((r) => `${r.step}|${r.label}`));
  const merged = [...old.filter((r) => !mine.has(`${r.step}|${r.label}`)), ...results];
  fs.writeFileSync(file, JSON.stringify(merged, null, 2));
}

export const sha = (buf) => createHash('sha256').update(buf).digest('hex');
export const call = (email, method, route, opts = {}) => api(email, method, route, { port: PORT, ...opts });

/** multipart POST to the II source-documents route (the exact route the Upload button calls). */
export async function uploadCas(email, bytes, filename, owner, extra = {}) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'application/pdf' }), filename);
  form.append('meta', JSON.stringify({ sourceKey: 'manual', documentType: 'cas_statement', countryCode: 'IN', ...(owner === undefined ? {} : { owner }), ...extra }));
  const res = new Response(form);
  const contentType = res.headers.get('content-type');
  const body = Buffer.from(await res.arrayBuffer());
  return call(email, 'POST', '/api/investment-intelligence/source-documents', { body, contentType, owner: null });
}

export async function processDoc(email, id) {
  const r = await call(email, 'POST', `/api/investment-intelligence/source-documents/${id}/process`, { json: {}, owner: null });
  return r;
}

export async function waitSettled(email, id, tries = 60) {
  let last;
  for (let i = 0; i < tries; i++) {
    const s = await call(email, 'GET', `/api/investment-intelligence/source-documents/${id}/status`);
    last = s.json?.data;
    const st = last?.document?.status;
    if (st && !['uploaded', 'processing', 'queued'].includes(st)) return last;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return last;
}

export async function db() {
  hostGuard();
  return serviceClient();
}

export async function ownerOptions(email, flow) {
  const r = await call(email, 'GET', `/api/ownership/options?flow=${flow}`);
  return r.json?.data;
}

export async function selfMember(email) {
  const r = await call(email, 'POST', '/api/ownership/self', { json: {}, owner: null });
  return r.json?.data?.memberId;
}

/** A real spouse member through the explicit Add-household-member route (never a role-only Spouse). */
export async function ensureSpouse(email, name = 'FHIP Synthetic Spouse') {
  const opts = await ownerOptions(email, 'ii_cas');
  const found = (opts?.members ?? []).find((m) => m.ownerRole === 'spouse');
  if (found) return found.id;
  const r = await call(email, 'POST', '/api/household-members', { json: { full_name: name, relationship: 'spouse' }, owner: null });
  return r.json?.data?.id;
}

export async function ensureEntity(email, entityType, name) {
  const list = await call(email, 'GET', '/api/business-entities');
  const hit = (list.json?.data ?? []).find((e) => e.entity_type === entityType && e.name === name);
  if (hit) return hit.id;
  const r = await call(email, 'POST', '/api/business-entities', { json: { name, entity_type: entityType }, owner: null });
  return { status: r.status, id: r.json?.data?.id, json: r.json };
}
