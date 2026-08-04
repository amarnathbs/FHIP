# FHIP — Financial Health Intelligence Platform

FHIP is a Next.js application that helps households (Australia and India, with cross-border support) track their finances, understand a computed Financial Health Score, see their household's "Financial DNA" archetype, plan goals, stress-test resilience, benchmark against peer cohorts ("Financial Twin"), forecast 12+ months ahead, and generate Free/Premium PDF financial reports.

## Architecture

- **Framework**: Next.js 16 (App Router), React 18, TypeScript, Tailwind CSS.
- **Backend**: Supabase (Postgres + Auth + Row Level Security + Storage). No separate backend server — all server logic runs in Next.js Route Handlers (`app/api/**`) and Server Components.
- **Charts**: Recharts.
- **PDF export**: Playwright (headless Chromium) rendering the report preview page to PDF server-side.
- **Testing**: Vitest (unit), Playwright Test (e2e).

### Directory layout

```
app/
  (app)/        authenticated app pages (dashboard, score, DNA, resilience, goals, twin, forecasting, reports, admin)
  (auth)/       login / signup
  (marketing)/  public marketing pages
  api/          Route Handlers — one folder per resource
lib/
  engines/      pure calculation engines (dashboard, healthScore, resilience, financialDna, goalForecast, twin, reportSections, ...)
  services/     data-loading + orchestration layers that call engines and talk to Supabase
  validation/   Zod schemas
  supabase/     Supabase client factories (browser, server, admin/service-role)
  advice-boundary/  guardrails preventing the app from crossing into licensed financial advice
components/    React components, organized by feature area
supabase/
  migrations/  numbered SQL migrations (source of truth for schema)
  seed.sql     baseline seed data (master item catalogue, benchmark cohorts, DNA archetypes)
tests/         Vitest unit tests + Playwright e2e specs
scripts/       one-off / maintenance scripts (test-data seeding, harnesses)
```

Engines are pure functions (input data in, computed result out) so they're independently unit-testable; services own the Supabase queries and pass real data into engines. This split keeps every financial calculation traceable and testable in isolation from the database.

## Local setup

Requirements: Node.js `>=24.18.0` (see `.nvmrc`), a Supabase project (cloud or local), npm.

```bash
npm install
cp .env.example .env.local   # fill in real values — see ENVIRONMENT_VARIABLES.md
npm run dev
```

App runs at `http://localhost:3000`.

### Database

Schema lives entirely in `supabase/migrations/*.sql`, applied in filename order. Apply them to your Supabase project via the Supabase CLI or SQL editor, then run `supabase/seed.sql` for baseline reference data (master financial item catalogue, benchmark cohorts, DNA archetypes). `supabase/seed_master_items.sql` and the `combined_*.sql` files are consolidated snapshots for convenience, not additional migrations to run independently — the numbered files under `supabase/migrations/` are the source of truth.

## Commands

```bash
npm run dev        # start dev server
npm run build       # production build
npm run start        # run production build locally
npm run lint         # eslint
npm test              # vitest unit tests
npm run test:watch    # vitest watch mode
npm run test:e2e      # playwright e2e suite
```

## Deployment

See [DEPLOYMENT.md](DEPLOYMENT.md) for the full AWS Amplify + Supabase + Cloudflare + Resend deployment procedure, [ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md) for the required configuration, [OPERATIONS_RUNBOOK.md](OPERATIONS_RUNBOOK.md) for day-2 operations, and [SECURITY.md](SECURITY.md) for the security model.
