// Every FDH route responds via lib/api.ts's `ok()`/`bad()`: a success body is
// always `{ data: {...} }`, a failure body is always `{ error, ... }`
// unwrapped (never `{ data: { error } }`). A client that reads success
// fields straight off the raw JSON (`body.document_id` instead of
// `body.data.document_id`) will silently read `undefined` on every
// successful call — this is exactly the shape of a real defect found in
// RetirementStatementImportPanel.tsx, where every success-path field read
// was broken while `.error` reads happened to still work by coincidence
// (bad()'s asymmetric, unwrapped shape). Centralising the unwrap here means
// a caller reads success fields directly off the returned object and
// failure fields via `.error`, matching what every sibling FDH panel does
// at each call site with `json.data.xxx`.
export async function readApiJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const body = (await res.json()) as Record<string, unknown>;
    if (res.ok) return (body.data as Record<string, unknown> | undefined) ?? {};
    return body;
  } catch {
    return {};
  }
}
