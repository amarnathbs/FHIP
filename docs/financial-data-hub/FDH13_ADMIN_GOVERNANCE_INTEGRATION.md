# FDH-13 — Admin Governance Integration (cross-reference only)

This document exists solely to record the boundary between FDH-14 and FDH-13, per spec §119/§131. It is not a
specification of FDH-13 itself — that belongs to the Admin Redesign workstream.

- **FDH-13** was intentionally redefined as: *FDH Governance Requirements & Certification within the Canonical
  Admin Architecture*, and is being implemented separately inside the Admin Redesign workstream (see
  `docs/admin/` and the `docs/g0-ja-wave2-final-scope-decision`/`admin-architecture-standard-wave0` branches
  for that workstream's own artifacts, which this pass read only enough of to confirm they exist and are
  distinct from FDH-14's scope — their content was not re-derived or re-certified here).
- FDH-13 owns: merchant-candidate Admin review, parser-management Admin UI, support-access Admin UX, Admin
  analytics dashboards, Admin role redesign, and any standing Admin access to user financial documents.
- **FDH-14 certifies the standalone Financial Data Hub data plane. Administrative governance remains owned by
  the Admin Redesign under FDH-13 and is separately certified.**
- FDH-13 is **not** a blocking dependency for FDH-14's own execution (FDH-14 proceeded to completion without
  it) but **is** required before any later claim of "whole-FDH governance complete."
