# Repository instructions for agents and contributors

## Admin Architecture Standard — mandatory

Before creating or modifying anything involving:

- `app/(app)/admin/**`
- `app/api/admin/**`
- Admin navigation
- Admin roles or capabilities
- Admin-consumed RLS or RPC access
- Admin analytics, reports, or exports
- any module's Admin integration

read `docs/admin/FHIP_ADMIN_ARCHITECTURE_STANDARD.md` **in full** first. The standard is **mandatory, not advisory**.

Your implementation or review report must identify:
- which Admin capabilities are affected;
- which security and privacy clauses of the standard apply;
- the tests proving compliance with each;
- any requested exception (per the standard's own §16), with its approval status.
