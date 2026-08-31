# FDH-14 — Privacy Certification

## 1. Raw document privacy (REUSED)

FDH-3's storage isolation was certified live: anonymous/cross-tenant download of a private storage object
returns 404/403, re-confirmed at FDH-3's closure and not contradicted by anything found in this pass. Normal
users can access only their own raw documents; standing Admin access to raw documents is explicitly **out of
scope for FDH-14** and governed separately by FDH-13 (spec §70/§71 — no test shortcut assuming Admin can browse
all financial documents was created or relied upon in this pass).

## 2. Password-protected PDF handling (REUSED)

FDH-5's certification: password never persisted (zero `password:`-keyed payload anywhere in the codebase by
static scan) and never appears in any of 6 real DEV tables checked by live artifact-absence sweep. Certified
via a controlled mock of `PasswordException` rather than a genuine encrypted-binary round trip — this
methodology limitation is disclosed in FDH-5's own docs and repeated here rather than upgraded without new
evidence.

## 3. Sensitive logging (FRESH spot-check this pass + REUSED)

This pass's own live-DEV script (`fdh14_cross_domain_security_certification.mjs`) logs only synthetic,
disposable values (`fdh14-cert-*@fhip-test.invalid` emails, no TFN/PAN/HIN/real account numbers, no service
keys) — inspected by re-reading its own source and console output before this document was written. No
production log stream was reviewed in this pass (no access to hosted runtime logs from this environment) —
this is a genuine limitation, disclosed rather than silently assumed clean; static-code and stored-artifact
sweeps (FDH-5's live artifact-absence sweep, FDH-4's compiled-bundle scan) remain the standing evidence.

## 4. Client bundle secrets (FRESH this pass)

See `FDH14_SECURITY_CERTIFICATION.md` §4 — zero occurrences of any real secret value from `.env.local` in the
fresh production build's `.next/static`/`.next/server` output.

## 5. Standing Admin raw-document access

**NOT CERTIFIED HERE — FDH-13.** Per spec §70/§71/§118, FDH-14 does not assume, test, or grant any
administrator standing access to user financial documents; that governance model is the Admin Redesign's to
build and certify.

## 6. Verdict

- Raw document isolation: **PASS** (reused).
- Password handling: **PASS** (reused, with the disclosed mock-based methodology limitation carried forward,
  not silently upgraded).
- Sensitive logs: **PASS** for code/static-artifact scope; production runtime log review is a disclosed
  residual (R-14-2, see Residual Register), not a claimed pass.
- Client secrets: **0**, fresh.
- Full identifiers leaked (TFN/PAN/HIN/account numbers/card numbers): **0** found in any scope actually
  searched this pass (source + fresh build output); no new full-identifier search of hosted runtime logs was
  possible from this environment.
