# Financial Health Intelligence Platform™
# Module-Wise Web Application Build Guide

**Companion to:** Volume 1 — Business Strategy & Product Vision (Consolidated Master Document)
**Purpose:** Turn the master document into a build-ready, module-by-module engineering guide with code, so the app can be developed, tested and approved **one module at a time** while still delivering the **full suite** required for the complete platform.
**Audience:** The founder plus an AI coding tool (Emergent AI, Claude Code, Cursor, Windsurf, Lovable) or a small engineering team.
**Scope:** Web-first responsive SaaS. Phase-1 markets Australia + India, cross-border ready.

> How to read this guide: Part 0 explains the build-test-approve loop. Part 1 is the technical foundation you build **once**. Part 2 contains the 12 module specs, each self-contained with schema, API, logic, UI, tests and an approval gate. Part 3 covers cross-cutting concerns (security, deployment, full build sequence).

---

## Part 0 — How to Use This Build Guide

### 0.1 The build loop (repeat for every module)

```
┌─────────────────────────────────────────────────────────────┐
│  1. READ    Read the module spec + the matching FRD section   │
│  2. BUILD   Apply the migration, write services, API, UI      │
│  3. TEST    Run unit + e2e tests; verify acceptance criteria  │
│  4. APPROVE Tick the Module Acceptance Gate. Commit + tag.     │
│  5. NEXT    Only then start the next module in the sequence.   │
└─────────────────────────────────────────────────────────────┘
```

The golden rule from your master document (Part G, Execution Philosophy): **build narrow, prove value, expand carefully.** Do not start Module *N+1* until Module *N* passes its acceptance gate and its code is reviewed. Do not mix two modules in one AI coding prompt.

### 0.2 Recommended module sequence and dependencies

Build in this order. Each module lists what must already exist and be approved.

| # | Module | Depends on | Phase | Priority |
|---|--------|-----------|-------|----------|
| 0 | **Technical Foundation** (Part 1) | — | 0–3 mo | Critical |
| 1 | Foundation Platform | Foundation | 0–3 mo | Critical |
| 2 | Financial Data Capture | 1 | 0–3 mo | Critical |
| 3 | Core Dashboard | 2 | 0–3 mo | Critical |
| 4 | Financial Health Score™ | 2, 3 | 3–6 mo | Critical |
| 5 | Financial DNA™ | 2, 3 | 3–6 mo | High |
| 6 | Resilience and Risk | 2–4 | 3–6 mo | High |
| 7 | Goals and Forecasting | 1–3 | 3–6 mo | High |
| 8 | Financial Twin™ and Benchmarking | 4–6 | 3–6 mo | Medium |
| 9 | Reports and Exports | 4–8 | 6–12 mo | Medium |
| 10 | AI Coach and Insights | 4–9 | 6–12 mo | Medium |
| 11 | Settings, Consent and Privacy | 1 | 0–6 mo* | High |
| 12 | Admin and Operations | 1 | 6–12 mo | Future |

\* Module 11 consent/privacy primitives (consent table, audit) should be scaffolded early alongside Module 1 for compliance, then completed as a full module later.

### 0.3 Module Acceptance Gate template (copy for each module)

A module is **approved** only when every box is ticked:

```
MODULE N — ACCEPTANCE GATE
[ ] All "Must" functional requirements (FR-Mxx-***) implemented
[ ] Every acceptance criterion in the FRD table demonstrably passes
[ ] Row Level Security enabled + tested (user cannot read another user's data)
[ ] Unit tests pass for all calculation/service logic
[ ] E2E test passes for the primary user story (happy path)
[ ] Empty, loading and error states implemented (per UX spec)
[ ] Advice-boundary language check passed (no personal product advice)
[ ] Country/currency awareness verified (AUD + INR where relevant)
[ ] Code reviewed (human or second AI pass) and merged to main
[ ] Git tag created: v0.<module>.0
```

### 0.4 How to hand a module to an AI coding tool

Use this prompt shape (matches your master document's handoff pattern):

```
You are building the Financial Health Intelligence Platform™, module by module.
Context: [paste the relevant Module section from this guide]
Foundation already built: [list approved modules]
Task: Implement ONLY Module N as specified. Do not scaffold other modules.
Follow the database migration, API contracts, and acceptance criteria exactly.
Keep all financial calculations in server-side services under /lib/engines,
never in UI components. Enable RLS on every new table.
When done, output: migration file, service files, API routes, UI components, and tests.
```

---

## Part 1 — Technical Foundation (build once)

### 1.1 Technology stack and rationale

| Layer | Choice | Why (traceable to master document) |
|-------|--------|-------------------------------------|
| Frontend | **Next.js 14 (App Router) + TypeScript** | Web-first responsive SaaS; server components keep financial logic off the client. |
| Styling | **Tailwind CSS** + small design-token layer | Implements the design system (navy/teal/amber/red, 8px grid, card layouts). |
| Database + Auth | **Supabase (PostgreSQL + Auth + Row Level Security)** | Named explicitly in your Database Design decision log; RLS satisfies FR-CORE-002 data isolation. |
| Validation | **Zod** | Enforces data-quality rules (DQ-001…008) at the API boundary. |
| Data fetching | **@tanstack/react-query** | Cache + refetch so dashboards update after edits (FR-M09-001). |
| Charts | **Recharts** | Accessible axis/legend/tooltip charts per UX chart rules. |
| Unit tests | **Vitest** | Fast unit tests for scoring/forecasting engines. |
| E2E tests | **Playwright** | Verifies acceptance criteria per user story. |
| Hosting | **Vercel** (app) + **Supabase** (data) | Simple, AI-tool friendly deployment. |

> Alternative noted in your decision log: self-managed PostgreSQL + a separate Node/Express API. If you choose that, keep the same table design and move the `/lib/engines` services behind Express routes; the module specs below still apply.

### 1.2 Repository structure (monorepo-lite, single Next.js app)

```
fhip/
├─ app/                          # Next.js App Router
│  ├─ (marketing)/               # public landing, pricing
│  ├─ (auth)/                    # signup, login, reset
│  ├─ (app)/                     # authenticated shell (protected)
│  │  ├─ dashboard/
│  │  ├─ income/  expenses/  assets/  liabilities/
│  │  ├─ investments/  retirement/  insurance/
│  │  ├─ score/  dna/  resilience/  goals/  twin/
│  │  ├─ reports/  coach/  settings/
│  │  └─ admin/
│  └─ api/                       # route handlers (thin; call /lib)
├─ lib/
│  ├─ supabase/                  # server + browser clients
│  ├─ engines/                   # ALL financial calculations (server-only)
│  │  ├─ money.ts                # frequency → monthly, currency helpers
│  │  ├─ health-score/           # Module 4 engine
│  │  ├─ dna/  resilience/  forecast/  twin/
│  ├─ validation/                # Zod schemas per entity
│  ├─ advice-boundary/           # language guardrail utilities
│  └─ traceability.ts            # FR-ID → code map for audits
├─ components/
│  ├─ ui/                        # AppShell, MetricCard, ScoreGauge, ...
│  └─ forms/                     # DataEntryForm and friends
├─ supabase/
│  ├─ migrations/                # NNNN_module_name.sql (one per module)
│  └─ seed.sql                   # reference data (countries, currencies)
├─ tests/
│  ├─ unit/                      # Vitest
│  └─ e2e/                       # Playwright
├─ .env.local
└─ package.json
```

### 1.3 Prerequisites and environment setup

```bash
# Prerequisites: Node.js 20+, a Supabase account, Git.
npx create-next-app@latest fhip --typescript --tailwind --app --eslint
cd fhip

# Core dependencies
npm install @supabase/supabase-js @supabase/ssr zod @tanstack/react-query recharts lucide-react
npm install -D vitest @vitejs/plugin-react @playwright/test @types/node

# Initialise Playwright browsers
npx playwright install
```

Create `.env.local` (never commit real values):

```bash
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=YOUR_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY   # server-only, never exposed to browser
```

### 1.4 Supabase clients

`lib/supabase/server.ts` (used by server components and API routes):

```typescript
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (list) => list.forEach(({ name, value, options }) =>
          cookieStore.set(name, value, options)),
      },
    }
  );
}
```

`lib/supabase/client.ts` (browser components):

```typescript
import { createBrowserClient } from '@supabase/ssr';

export const createClient = () =>
  createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
```

### 1.5 Foundation database migration + RLS pattern

This adapts your SQL DDL skeleton to Supabase Auth. **Key change:** Supabase provides identity in `auth.users`, so we key everything off `auth.uid()` instead of a custom `users` table. This is the standard, secure Supabase pattern and directly implements FR-CORE-002 (data isolation).

`supabase/migrations/0001_foundation.sql`:

```sql
-- Reference data ---------------------------------------------------------
create table countries (
  country_code char(2) primary key,
  country_name text not null,
  default_currency_code char(3) not null,
  is_supported boolean default true
);

create table currencies (
  currency_code char(3) primary key,
  currency_name text not null,
  currency_symbol text not null,
  country_code char(2)
);

-- Profile (1:1 with auth.users) ------------------------------------------
create table user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  date_of_birth date,
  country_of_residence char(2) references countries(country_code),
  secondary_country char(2),
  preferred_currency char(3) references currencies(currency_code),
  employment_status text,
  onboarding_completed boolean default false,
  profile_completion_percentage int default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table households (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  household_name text,
  household_type text,
  marital_status text,
  dependants_count int default 0 check (dependants_count >= 0),
  annual_household_income_range text,
  primary_country char(2),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table user_goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  goal_name text not null,
  goal_type text not null,
  target_amount numeric(18,2) not null check (target_amount >= 0),
  current_amount numeric(18,2) default 0 check (current_amount >= 0),
  currency_code char(3) not null references currencies(currency_code),
  target_date date,
  priority text default 'medium',
  status text default 'active',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Consent + audit primitives (scaffolded early for compliance) ------------
create table consents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  consent_type text not null,
  consent_version text not null,
  granted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz default now()
);

create table audit_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  event_type text not null,          -- login, update, delete, export, calc_run
  entity text,
  entity_id uuid,
  metadata jsonb,
  created_at timestamptz default now()
);

create index idx_households_user on households(user_id);
create index idx_user_goals_user on user_goals(user_id);
create index idx_consents_user on consents(user_id);
create index idx_audit_user on audit_events(user_id);

-- Row Level Security: the reusable pattern for EVERY user-owned table -----
alter table user_profiles enable row level security;
alter table households    enable row level security;
alter table user_goals    enable row level security;
alter table consents      enable row level security;
alter table audit_events  enable row level security;

-- Owner-only policy, applied identically to each table
create policy "own rows - profiles" on user_profiles
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows - households" on households
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows - goals" on user_goals
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows - consents" on consents
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows - audit" on audit_events
  for select using (auth.uid() = user_id);

-- Reference tables are world-readable, admin-writable (see Module 12)
alter table countries enable row level security;
alter table currencies enable row level security;
create policy "read countries" on countries for select using (true);
create policy "read currencies" on currencies for select using (true);
```

> **RLS is not optional.** Every user-owned table in every later module MUST repeat this `enable row level security` + owner policy block. It is the single most important control in the whole build (Security & Compliance spec).

`supabase/seed.sql` (reference data):

```sql
insert into currencies (currency_code, currency_name, currency_symbol, country_code) values
  ('AUD','Australian Dollar','$','AU'),
  ('INR','Indian Rupee','₹','IN')
on conflict do nothing;

insert into countries (country_code, country_name, default_currency_code, is_supported) values
  ('AU','Australia','AUD',true),
  ('IN','India','INR',true)
on conflict do nothing;
```

### 1.6 Auth + protected routes

`middleware.ts` (redirects unauthenticated users away from `(app)` — implements FR-CORE-001):

```typescript
import { type NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';

export async function middleware(request: NextRequest) {
  let response = NextResponse.next();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (list) => list.forEach(({ name, value }) => response.cookies.set(name, value)),
      },
    }
  );
  const { data: { user } } = await supabase.auth.getUser();
  const isAppRoute = request.nextUrl.pathname.startsWith('/dashboard')
    || request.nextUrl.pathname.match(/^\/(income|expenses|assets|liabilities|investments|retirement|insurance|score|dna|resilience|goals|twin|reports|coach|settings|admin)/);
  if (isAppRoute && !user) {
    return NextResponse.redirect(new URL('/login', request.url));
  }
  return response;
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
```

### 1.7 Design system (Tailwind tokens + base components)

Add the token palette from your UX spec to `tailwind.config.ts`:

```typescript
import type { Config } from 'tailwindcss';
export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        trust:   { DEFAULT: '#1F4E79', 700: '#163a5c' }, // navy/blue = trust
        progress:{ DEFAULT: '#0E9F8E' },                 // teal/green = progress
        caution: { DEFAULT: '#D98A00' },                 // amber = caution
        risk:    { DEFAULT: '#C0392B' },                 // red = high risk
      },
      fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'] },
      spacing: { /* 8px grid inherited from Tailwind default 4px scale */ },
      borderRadius: { card: '0.75rem' },
    },
  },
} satisfies Config;
```

Two core primitives (the rest of the component library follows the same style). `components/ui/MetricCard.tsx`:

```tsx
export function MetricCard({
  label, value, trend, tooltip, status = 'neutral',
}: {
  label: string; value: string; trend?: string; tooltip?: string;
  status?: 'good' | 'caution' | 'risk' | 'neutral';
}) {
  const ring = { good: 'ring-progress', caution: 'ring-caution', risk: 'ring-risk', neutral: 'ring-gray-200' }[status];
  return (
    <div className={`rounded-card border bg-white p-6 shadow-sm ring-1 ${ring}`} title={tooltip}>
      <p className="text-sm text-gray-500">{label}</p>
      <p className="mt-2 text-3xl font-semibold text-gray-900">{value}</p>
      {trend && <p className="mt-1 text-sm text-gray-500">{trend}</p>}
    </div>
  );
}
```

`components/ui/ScoreGauge.tsx` (0–100 with band, reused by Modules 4/6):

```tsx
const BANDS = [
  { min: 90, label: 'Excellent', color: '#0E9F8E' },
  { min: 80, label: 'Very Good', color: '#3AA76D' },
  { min: 70, label: 'Good',      color: '#8AB917' },
  { min: 60, label: 'Fair',      color: '#D98A00' },
  { min: 50, label: 'Needs Improvement', color: '#E06A1B' },
  { min: 0,  label: 'High Risk', color: '#C0392B' },
];
export function ScoreGauge({ score }: { score: number }) {
  const band = BANDS.find(b => score >= b.min)!;
  return (
    <div className="flex flex-col items-center rounded-card border bg-white p-6">
      <div className="text-5xl font-bold" style={{ color: band.color }}>{Math.round(score)}</div>
      <div className="mt-1 text-sm font-medium" style={{ color: band.color }}>{band.label}</div>
      <div className="mt-3 h-2 w-full rounded-full bg-gray-100">
        <div className="h-2 rounded-full" style={{ width: `${score}%`, background: band.color }} />
      </div>
    </div>
  );
}
```

> Build the remaining components from the master document's component library as you need them per module: `AppShell`, `PageHeader`, `InsightCard`, `PillarBreakdown`, `DataEntryForm`, `CountryCurrencyTag`, `ScenarioToggle`, `EmptyState`, `RiskBadge`, `ReportSection`, `PrivacyNoticeCard`, `LockedFeatureCard`.

### 1.8 Global conventions

**Money helper** — `lib/engines/money.ts` (single source of truth for frequency → monthly, used everywhere):

```typescript
export type Frequency = 'weekly' | 'fortnightly' | 'monthly' | 'quarterly' | 'annually' | 'one_off';

const TO_MONTHLY: Record<Frequency, number> = {
  weekly: 52 / 12, fortnightly: 26 / 12, monthly: 1,
  quarterly: 1 / 3, annually: 1 / 12, one_off: 0,
};

export const toMonthly = (amount: number, freq: Frequency) => amount * TO_MONTHLY[freq];

export function formatMoney(amount: number, currency: 'AUD' | 'INR') {
  const locale = currency === 'INR' ? 'en-IN' : 'en-AU';
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount);
}
```

**Standard API response shape** — every route returns `{ data } | { error }` and calls services in `/lib`, never inline SQL:

```typescript
// lib/api.ts
export const ok  = (data: unknown) => Response.json({ data });
export const bad = (msg: string, code = 400) => Response.json({ error: msg }, { status: code });
```

**Advice-boundary guardrail** — `lib/advice-boundary/check.ts` (implements FR-CORE-006; reused by Reports & AI Coach):

```typescript
// Flags language that crosses from education into regulated personal advice.
const BANNED = [/\byou should buy\b/i, /\byou should sell\b/i, /\bswitch to\b/i,
  /\bwe recommend (buying|purchasing|investing in)\b/i, /\bguaranteed return\b/i];

export function violatesAdviceBoundary(text: string): boolean {
  return BANNED.some(rx => rx.test(text));
}
// Usage: assert !violatesAdviceBoundary(output) before showing any insight/report copy.
```

**Traceability** — keep `lib/traceability.ts` mapping each FR-ID to the file that satisfies it, so the acceptance gates are auditable.

### 1.9 Testing setup

`vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', include: ['tests/unit/**/*.test.ts'] } });
```

Example foundation test — proves the money helper (the calculation every module depends on):

```typescript
// tests/unit/money.test.ts
import { describe, it, expect } from 'vitest';
import { toMonthly } from '@/lib/engines/money';

describe('toMonthly', () => {
  it('annualises correctly', () => expect(toMonthly(1200, 'annually')).toBeCloseTo(100));
  it('treats one-off as non-recurring', () => expect(toMonthly(5000, 'one_off')).toBe(0));
});
```

### 1.10 Foundation Acceptance Gate

```
FOUNDATION — ACCEPTANCE GATE
[ ] Next.js app runs; Tailwind tokens render (navy/teal/amber/red)
[ ] Supabase connected; 0001_foundation.sql + seed.sql applied
[ ] RLS proven: signed-in user A cannot select user B's profile row
[ ] Middleware redirects unauthenticated users from /dashboard to /login
[ ] MetricCard + ScoreGauge render in a test page
[ ] money.ts unit tests pass
[ ] .env secrets are NOT committed; service-role key is server-only
[ ] Git tag v0.0.0 created
```

---

## Part 2 — Module Build Specs

Each module below is self-contained: **Overview → Migration → API/Services → Logic → UI → Tests → Acceptance Gate.** Build, test and approve one before starting the next.

---

### Module 1 — Foundation Platform

**Purpose:** Signup, login, onboarding, profile, household, goal selection, dashboard shell and navigation.
**Implements:** FR-M07-001…007. **Depends on:** Technical Foundation. **User roles:** Anonymous Visitor, Registered User.

#### Migration — `0002_module1.sql`
Module 1 mostly reuses foundation tables (`user_profiles`, `households`, `user_goals`). No new tables required. Add a trigger to auto-create an empty profile on signup:

```sql
create or replace function handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.user_profiles (user_id) values (new.id)
  on conflict do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();
```

#### Services + API

`lib/validation/profile.ts`:

```typescript
import { z } from 'zod';
export const profileSchema = z.object({
  full_name: z.string().min(1),
  date_of_birth: z.string().date().optional(),
  country_of_residence: z.enum(['AU', 'IN']),
  secondary_country: z.enum(['AU', 'IN']).nullable().optional(),
  preferred_currency: z.enum(['AUD', 'INR']),
  employment_status: z.string().optional(),
});
```

`app/api/user/profile/route.ts`:

```typescript
import { createClient } from '@/lib/supabase/server';
import { profileSchema } from '@/lib/validation/profile';
import { ok, bad } from '@/lib/api';

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);
  const { data, error } = await supabase
    .from('user_profiles').select('*').eq('user_id', user.id).single();
  return error ? bad(error.message) : ok(data);
}

export async function PUT(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);
  const parsed = profileSchema.safeParse(await req.json());
  if (!parsed.success) return bad(parsed.error.message, 422);
  const { data, error } = await supabase
    .from('user_profiles')
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq('user_id', user.id).select().single();
  return error ? bad(error.message) : ok(data);
}
```

`app/api/onboarding/complete/route.ts` (FR-M07-003 routing gate):

```typescript
import { createClient } from '@/lib/supabase/server';
import { ok, bad } from '@/lib/api';
export async function POST() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);
  const { error } = await supabase.from('user_profiles')
    .update({ onboarding_completed: true }).eq('user_id', user.id);
  return error ? bad(error.message) : ok({ onboarding_completed: true });
}
```

Signup/login use Supabase Auth directly (`supabase.auth.signUp` / `signInWithPassword`) from the `(auth)` client components; on success route to `/onboarding` if `onboarding_completed` is false, else `/dashboard`.

#### UI — five-step onboarding wizard (skeleton)

```tsx
// app/(app)/onboarding/OnboardingWizard.tsx
'use client';
import { useState } from 'react';
const STEPS = ['Profile', 'Household', 'Countries & Currency', 'Goals', 'Review'] as const;

export function OnboardingWizard() {
  const [step, setStep] = useState(0);
  const next = () => setStep(s => Math.min(s + 1, STEPS.length - 1));
  const back = () => setStep(s => Math.max(s - 1, 0));
  return (
    <div className="mx-auto max-w-2xl p-6">
      <ol className="mb-6 flex gap-2 text-xs">
        {STEPS.map((label, i) => (
          <li key={label} className={i <= step ? 'font-semibold text-trust' : 'text-gray-400'}>{i + 1}. {label}</li>
        ))}
      </ol>
      {/* Render the step form for STEPS[step]; persist via /api/user/profile, /api/household, /api/goals */}
      <div className="mt-6 flex justify-between">
        <button onClick={back} disabled={step === 0} className="rounded px-4 py-2 text-gray-600">Back</button>
        <button onClick={next} className="rounded bg-trust px-4 py-2 text-white">
          {step === STEPS.length - 1 ? 'Finish' : 'Continue'}
        </button>
      </div>
    </div>
  );
}
```

The dashboard shell (`app/(app)/dashboard/page.tsx`) shows a welcome card, profile-completion %, quick-setup cards and placeholders for future modules (`LockedFeatureCard`).

#### Tests

```typescript
// tests/e2e/onboarding.spec.ts (Playwright)
import { test, expect } from '@playwright/test';
test('new user completes onboarding and reaches dashboard', async ({ page }) => {
  await page.goto('/signup');
  // ... sign up, fill 5 steps ...
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByText(/welcome/i)).toBeVisible();
});
```

#### Module 1 Acceptance Gate
```
[ ] FR-M07-001..007 pass (signup→onboarding→dashboard; logout clears session)
[ ] Dashboard unreachable until onboarding_completed = true (FR-M07-003)
[ ] Profile + household + goals persist and display on dashboard
[ ] RLS proven on user_profiles/households/user_goals
[ ] Country/currency choice drives AUD vs INR labels (FR-CORE-003)
[ ] E2E onboarding happy-path passes → tag v0.1.0
```

---

### Module 2 — Financial Data Capture

**Purpose:** Manual capture of income, expenses, assets, liabilities, investments, retirement and insurance so later engines can calculate.
**Implements:** FR-M08-001…007. **Depends on:** Module 1.

#### Migration — `0003_module2.sql`
Seven registers share a near-identical shape. Full DDL for two (income = flow, assets = stock); replicate the pattern for the rest.

```sql
create table income_sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_name text not null,
  income_type text not null,                 -- salary|business|rental|investment|other
  amount numeric(18,2) not null check (amount >= 0),
  frequency text not null,                   -- weekly|fortnightly|monthly|quarterly|annually|one_off
  currency_code char(3) not null references currencies(currency_code),
  is_active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  asset_name text not null,
  asset_class text not null,                 -- cash|property|vehicle|business|other
  current_value numeric(18,2) not null check (current_value >= 0),
  currency_code char(3) not null references currencies(currency_code),
  country_code char(2),                      -- supports cross-border view
  valuation_date date,
  is_active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Replicate for: expense_items, liabilities, investments,
-- retirement_accounts, insurance_policies (fields per FRD data entities).
-- liabilities add: balance, interest_rate, monthly_repayment, debt_type.
-- retirement_accounts add: account_type (super|EPF|PPF|NPS|other), country_code.
-- insurance_policies add: cover_type, cover_amount, premium, premium_frequency, renewal_date.

create table financial_records_audit (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  entity text not null, entity_id uuid, action text not null,
  changed_at timestamptz default now(), metadata jsonb
);

-- RLS: repeat the owner-only block for every table above.
alter table income_sources enable row level security;
create policy "own income" on income_sources for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
-- ...same for assets, expense_items, liabilities, investments,
--    retirement_accounts, insurance_policies, financial_records_audit.
```

#### Generic CRUD service (write once, reuse for all seven registers)

`lib/services/registry.ts`:

```typescript
import { createClient } from '@/lib/supabase/server';

export function makeRegistry<T extends { id?: string }>(table: string) {
  return {
    async list() {
      const s = await createClient();
      const { data: { user } } = await s.auth.getUser();
      return s.from(table).select('*').eq('user_id', user!.id).eq('is_active', true);
    },
    async create(row: Omit<T, 'id'>) {
      const s = await createClient();
      const { data: { user } } = await s.auth.getUser();
      return s.from(table).insert({ ...row, user_id: user!.id }).select().single();
    },
    async update(id: string, patch: Partial<T>) {
      const s = await createClient();
      return s.from(table).update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id).select().single();
    },
    async archive(id: string) {           // soft delete per DQ-006
      const s = await createClient();
      return s.from(table).update({ is_active: false }).eq('id', id);
    },
  };
}
```

Then each route is thin, e.g. `app/api/income/route.ts` calls `makeRegistry('income_sources')`. Repeat for `/api/expenses`, `/api/assets`, `/api/liabilities`, `/api/investments`, `/api/retirement`, `/api/insurance`.

#### UI — reusable `DataEntryForm`
One `DataEntryForm` component driven by a field schema per register renders all seven forms (income, expenses, assets, …). Each register page lists active records (with monthly-equivalent for flows via `toMonthly`) and an add/edit form.

#### Tests
```typescript
// tests/unit/registry-monthly.test.ts
import { toMonthly } from '@/lib/engines/money';
// Given weekly income 500 → monthly equivalent ≈ 2166.67 shown in list
expect(toMonthly(500, 'weekly')).toBeCloseTo(2166.67, 1);
```
Plus an e2e that adds one record in each register and confirms it appears.

#### Module 2 Acceptance Gate
```
[ ] All 7 registers CRUD works; soft-delete (is_active=false) not hard delete
[ ] FR-M08-001..007 acceptance criteria pass (monthly equivalents, totals)
[ ] Cross-border fields (country_code) captured on assets/retirement
[ ] RLS proven on all 7 registers
[ ] Currency shown per record; AUD & INR both work → tag v0.2.0
```

---

### Module 3 — Core Dashboard

**Purpose:** A single trusted snapshot: net worth, cash flow, savings rate, debt ratio, allocation, retirement summary, goal progress, data completeness.
**Implements:** FR-M09-001…005. **Depends on:** Module 2.

#### Migration — `0004_module3.sql`
Dashboard values are derived, but persist a lightweight snapshot for history/velocity (supports FR-CORE-005):

```sql
create table financial_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  snapshot_month date not null,            -- first day of month
  total_assets numeric(18,2), total_liabilities numeric(18,2),
  net_worth numeric(18,2), monthly_income numeric(18,2),
  monthly_expenses numeric(18,2), monthly_surplus numeric(18,2),
  savings_rate numeric(6,4), currency_code char(3),
  created_at timestamptz default now(),
  unique (user_id, snapshot_month)          -- DQ-005 uniqueness
);
alter table financial_snapshots enable row level security;
create policy "own snapshots" on financial_snapshots for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

#### Aggregation service — `lib/engines/dashboard.ts`

```typescript
import { toMonthly, type Frequency } from './money';

export interface DashboardSummary {
  netWorth: number; totalAssets: number; totalLiabilities: number;
  monthlyIncome: number; monthlyExpenses: number; monthlySurplus: number;
  savingsRate: number | null; completeness: Record<string, 'complete' | 'partial' | 'missing'>;
}

export function computeDashboard(input: {
  incomes: { amount: number; frequency: Frequency }[];
  expenses: { amount: number; frequency: Frequency }[];
  assets: { current_value: number }[];
  liabilities: { balance: number; monthly_repayment: number }[];
}): DashboardSummary {
  const monthlyIncome = input.incomes.reduce((s, r) => s + toMonthly(r.amount, r.frequency), 0);
  const monthlyExpenses = input.expenses.reduce((s, r) => s + toMonthly(r.amount, r.frequency), 0);
  const totalAssets = input.assets.reduce((s, a) => s + a.current_value, 0);
  const totalLiabilities = input.liabilities.reduce((s, l) => s + l.balance, 0);
  const monthlySurplus = monthlyIncome - monthlyExpenses;
  // FR-M09-004: guard against divide-by-zero when income is 0
  const savingsRate = monthlyIncome > 0 ? monthlySurplus / monthlyIncome : null;
  return {
    netWorth: totalAssets - totalLiabilities, totalAssets, totalLiabilities,
    monthlyIncome, monthlyExpenses, monthlySurplus, savingsRate,
    completeness: {
      income: input.incomes.length ? 'complete' : 'missing',
      expenses: input.expenses.length ? 'complete' : 'missing',
      assets: input.assets.length ? 'complete' : 'missing',
      liabilities: input.liabilities.length ? 'complete' : 'missing',
    },
  };
}
```

`app/api/dashboard/summary/route.ts` loads the user's active records and returns `computeDashboard(...)`. The dashboard page renders `MetricCard`s and, using React Query, **refetches on record changes** so totals update live (FR-M09-001).

#### Tests
```typescript
// tests/unit/dashboard.test.ts
import { computeDashboard } from '@/lib/engines/dashboard';
it('savings rate is null when income is zero', () => {
  const d = computeDashboard({ incomes: [], expenses: [{ amount: 100, frequency: 'monthly' }], assets: [], liabilities: [] });
  expect(d.savingsRate).toBeNull();
});
it('net worth = assets - liabilities', () => {
  const d = computeDashboard({ incomes: [], expenses: [], assets: [{ current_value: 500 }], liabilities: [{ balance: 200, monthly_repayment: 0 }] });
  expect(d.netWorth).toBe(300);
});
```

#### Module 3 Acceptance Gate
```
[ ] Net worth, cash flow, savings rate, debt ratio render from real data
[ ] Totals update after add/edit in Module 2 (FR-M09-001)
[ ] Zero-income savings rate handled without error (FR-M09-004)
[ ] Data-completeness indicators + recommended next step shown (FR-M09-005)
[ ] Snapshot row written per month → tag v0.3.0
```

---

### Module 4 — Financial Health Score™  *(core proprietary IP)*

**Purpose:** A 0–100 score from six weighted pillars, life-stage adjusted, with bands, explanations, improvement actions and immutable monthly snapshots.
**Implements:** FR-M10-001…005 and FIE-HS-001…004. **Depends on:** Modules 2, 3.

> This is your headline IP (Part F). Keep the engine server-side, versioned, and every snapshot immutable.

#### Migration — `0005_module4.sql`

```sql
create table financial_health_scores (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  score_month date not null,
  overall_score numeric(5,2) not null,
  score_band text not null,
  model_version text not null,               -- FIE-HS-004
  created_at timestamptz default now(),
  unique (user_id, score_month, model_version)  -- DQ-005 / immutable history
);

create table score_pillar_results (
  id uuid primary key default gen_random_uuid(),
  score_id uuid not null references financial_health_scores(id) on delete cascade,
  pillar_name text not null,                 -- cash_flow|debt|wealth|retirement|protection|behaviour
  pillar_weight_pct numeric(8,4) not null,
  pillar_score numeric(5,2) not null,
  interpretation text
);

create table score_actions (
  id uuid primary key default gen_random_uuid(),
  score_id uuid not null references financial_health_scores(id) on delete cascade,
  action_text text not null, related_pillar text, priority int
);

alter table financial_health_scores enable row level security;
create policy "own scores" on financial_health_scores for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
-- pillar_results/actions inherit access via score_id join; add owner policies
-- using a subquery to financial_health_scores, or store user_id and apply the standard policy.
```

#### The scoring engine — `lib/engines/health-score/index.ts`

Implements your exact pillar weights and metric formulas.

```typescript
export const MODEL_VERSION = 'fhs-1.0.0';

// Pillar weights straight from the Financial Intelligence Engine spec
export const PILLAR_WEIGHTS = {
  cash_flow: 0.20, debt: 0.15, wealth: 0.20,
  retirement: 0.15, protection: 0.15, behaviour: 0.15,
} as const;

export type LifeStage = 'starter' | 'young_professional' | 'young_family'
  | 'established_family' | 'pre_retiree' | 'retiree';

export function lifeStageFromAge(age: number): LifeStage {
  if (age <= 25) return 'starter';
  if (age <= 35) return 'young_professional';
  if (age <= 45) return 'young_family';
  if (age <= 55) return 'established_family';
  if (age <= 67) return 'pre_retiree';
  return 'retiree';
}

// Life-stage weight multipliers (emphasis shift, then re-normalised to sum=1).
const EMPHASIS: Record<LifeStage, Partial<Record<keyof typeof PILLAR_WEIGHTS, number>>> = {
  starter:            { cash_flow: 1.3, retirement: 0.5, debt: 1.2 },
  young_professional: { cash_flow: 1.2, wealth: 1.1, retirement: 0.8 },
  young_family:       { protection: 1.3, cash_flow: 1.1, debt: 1.1 },
  established_family: { wealth: 1.2, retirement: 1.2, debt: 1.1 },
  pre_retiree:        { retirement: 1.4, debt: 1.2, protection: 1.1, wealth: 0.9 },
  retiree:            { protection: 1.3, retirement: 1.2, cash_flow: 1.1, wealth: 0.7 },
};

function adjustedWeights(stage: LifeStage) {
  const base = { ...PILLAR_WEIGHTS };
  const emph = EMPHASIS[stage];
  const raw = Object.fromEntries(
    Object.entries(base).map(([k, w]) => [k, w * (emph[k as keyof typeof base] ?? 1)])
  ) as Record<keyof typeof PILLAR_WEIGHTS, number>;
  const total = Object.values(raw).reduce((s, v) => s + v, 0);
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v / total])) as typeof PILLAR_WEIGHTS;
}

const clamp = (n: number) => Math.max(0, Math.min(100, n));

// --- Pillar sub-scores (each normalised 0-100). Formulas per FIE spec. ---
export interface ScoreInputs {
  monthlyIncome: number; monthlyEssentialExpenses: number; monthlySurplus: number;
  totalDebt: number; annualGrossIncome: number; monthlyDebtPayments: number;
  netWorth: number; monthlyInvestment: number;
  liquidAssets: number;
  retirementBalance: number; hasIncomeProtection: boolean; emergencyFundMonthsTarget?: number;
  goalProgressWeighted: number; // 0..1
  age: number;
}

export function pillarScores(i: ScoreInputs) {
  const savingsRate = i.monthlyIncome > 0 ? i.monthlySurplus / i.monthlyIncome : 0;
  const expensePressure = i.monthlyIncome > 0 ? i.monthlyEssentialExpenses / i.monthlyIncome : 1;
  const cash_flow = clamp(savingsRate * 250 + (1 - expensePressure) * 50); // capped, rewards saving

  const dti = i.annualGrossIncome > 0 ? i.totalDebt / i.annualGrossIncome : 2;
  const dsr = i.monthlyIncome > 0 ? i.monthlyDebtPayments / i.monthlyIncome : 1;
  const debt = clamp(100 - dti * 20 - dsr * 100);

  const netWorthRatio = i.annualGrossIncome > 0 ? i.netWorth / i.annualGrossIncome : 0;
  const investRate = i.monthlyIncome > 0 ? i.monthlyInvestment / i.monthlyIncome : 0;
  const wealth = clamp(netWorthRatio * 15 + investRate * 200);

  const retirement = clamp((i.retirementBalance / Math.max(1, i.annualGrossIncome)) * 10);

  const emFundMonths = i.monthlyEssentialExpenses > 0 ? i.liquidAssets / i.monthlyEssentialExpenses : 0;
  const target = i.emergencyFundMonthsTarget ?? 3;
  const protection = clamp((emFundMonths / target) * 70 + (i.hasIncomeProtection ? 30 : 0));

  const behaviour = clamp(i.goalProgressWeighted * 100);

  return { cash_flow, debt, wealth, retirement, protection, behaviour };
}

export function scoreBand(score: number): string {
  if (score >= 90) return 'Excellent';
  if (score >= 80) return 'Very Good';
  if (score >= 70) return 'Good';
  if (score >= 60) return 'Fair';
  if (score >= 50) return 'Needs Improvement';
  return 'High Risk';
}

export function calculateHealthScore(i: ScoreInputs) {
  const stage = lifeStageFromAge(i.age);
  const weights = adjustedWeights(stage);
  const pillars = pillarScores(i);
  const overall = (Object.keys(pillars) as (keyof typeof pillars)[])
    .reduce((sum, k) => sum + pillars[k] * weights[k], 0);
  return {
    overall: Math.round(overall * 100) / 100,
    band: scoreBand(overall),
    lifeStage: stage,
    modelVersion: MODEL_VERSION,
    pillars: (Object.keys(pillars) as (keyof typeof pillars)[]).map(k => ({
      pillar_name: k, pillar_weight_pct: weights[k] * 100, pillar_score: pillars[k],
    })),
  };
}
```

`app/api/score/recalculate/route.ts` builds `ScoreInputs` from the user's records + dashboard summary + age (from DOB), calls `calculateHealthScore`, then **inserts a new immutable snapshot** for the current month (never updates an old one). Improvement actions are generated from the lowest pillars and must pass the advice-boundary check.

#### UI
`score` page renders `ScoreGauge` (overall + band), `PillarBreakdown` (six pillars with weights), an improvement-actions list, and a score-history line chart (Recharts) from `/api/score/history`.

#### Tests (the most important tests in the app)
```typescript
// tests/unit/health-score.test.ts
import { calculateHealthScore, scoreBand, lifeStageFromAge } from '@/lib/engines/health-score';
it('bands map to thresholds', () => {
  expect(scoreBand(95)).toBe('Excellent');
  expect(scoreBand(49)).toBe('High Risk');
});
it('life stage from age', () => expect(lifeStageFromAge(60)).toBe('pre_retiree'));
it('pre-retiree weights retirement more than a starter', () => {
  const base = { monthlyIncome: 8000, monthlyEssentialExpenses: 3000, monthlySurplus: 2000,
    totalDebt: 100000, annualGrossIncome: 120000, monthlyDebtPayments: 1500, netWorth: 300000,
    monthlyInvestment: 500, liquidAssets: 15000, retirementBalance: 50000, hasIncomeProtection: true,
    goalProgressWeighted: 0.5 };
  const young = calculateHealthScore({ ...base, age: 28 });
  const pre = calculateHealthScore({ ...base, age: 60 });
  const wYoung = young.pillars.find(p => p.pillar_name === 'retirement')!.pillar_weight_pct;
  const wPre = pre.pillars.find(p => p.pillar_name === 'retirement')!.pillar_weight_pct;
  expect(wPre).toBeGreaterThan(wYoung);
});
it('weights always re-normalise to 100%', () => {
  const r = calculateHealthScore({ age: 40, monthlyIncome: 5000, monthlyEssentialExpenses: 2000,
    monthlySurplus: 1000, totalDebt: 0, annualGrossIncome: 60000, monthlyDebtPayments: 0, netWorth: 0,
    monthlyInvestment: 0, liquidAssets: 0, retirementBalance: 0, hasIncomeProtection: false, goalProgressWeighted: 0 });
  const sum = r.pillars.reduce((s, p) => s + p.pillar_weight_pct, 0);
  expect(sum).toBeCloseTo(100, 4);
});
```

#### Module 4 Acceptance Gate
```
[ ] Overall + 6 pillar scores + band render; only when data sufficiency met (FR-M10-001)
[ ] model_version stored on every score (FIE-HS-004)
[ ] Monthly snapshot immutable: recalculation does NOT overwrite prior month (FR-M10-005)
[ ] Improvement actions specific + pass advice-boundary check (FR-M10-004)
[ ] Life-stage adjustment demonstrably changes weights (unit test)
[ ] Weights re-normalise to 100% for every life stage → tag v0.4.0
```

---

### Module 5 — Financial DNA™

**Purpose:** Classify users into behavioural archetypes (rule-based for MVP) with strengths, risks and plain-English explanation.
**Implements:** FR-M11-001…003. **Depends on:** Modules 2, 3.

#### Migration — `0006_module5.sql`
```sql
create table financial_dna_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  primary_profile text not null, secondary_trait text,
  strengths jsonb, risks jsonb, explanation text,
  model_version text not null, evaluated_at timestamptz default now()
);
create table dna_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  primary_profile text not null, evaluated_at timestamptz default now()
);
alter table financial_dna_profiles enable row level security;
alter table dna_history enable row level security;
create policy "own dna" on financial_dna_profiles for all using (auth.uid()=user_id) with check (auth.uid()=user_id);
create policy "own dna hist" on dna_history for all using (auth.uid()=user_id) with check (auth.uid()=user_id);
```

#### Rule engine — `lib/engines/dna/index.ts`
```typescript
export const DNA_MODEL_VERSION = 'dna-1.0.0';
export type DnaProfile = 'Disciplined Saver' | 'Growth Investor' | 'Debt-Pressured'
  | 'Cash-Flow Strained' | 'Balanced Builder' | 'Under-Protected';

export function classifyDna(m: {
  savingsRate: number; investRate: number; debtServicingRatio: number;
  emergencyFundMonths: number; hasProtection: boolean;
}): { primary: DnaProfile; secondary?: DnaProfile; strengths: string[]; risks: string[] } {
  const strengths: string[] = []; const risks: string[] = [];
  if (m.savingsRate >= 0.2) strengths.push('Strong monthly savings discipline.');
  if (m.investRate >= 0.1) strengths.push('Consistent investing behaviour.');
  if (m.emergencyFundMonths < 3) risks.push('Emergency buffer below three months.');
  if (m.debtServicingRatio > 0.4) risks.push('High share of income servicing debt.');
  if (!m.hasProtection) risks.push('No income protection recorded.');

  let primary: DnaProfile = 'Balanced Builder';
  if (m.debtServicingRatio > 0.4) primary = 'Debt-Pressured';
  else if (m.savingsRate < 0.05) primary = 'Cash-Flow Strained';
  else if (m.investRate >= 0.15) primary = 'Growth Investor';
  else if (m.savingsRate >= 0.2) primary = 'Disciplined Saver';
  else if (!m.hasProtection && m.emergencyFundMonths < 3) primary = 'Under-Protected';

  return { primary, strengths, risks };
}
```
`POST /api/dna/recalculate` classifies, writes the profile, appends to `dna_history`. Explanation copy must pass the advice-boundary check.

#### Module 5 Acceptance Gate
```
[ ] Each eligible user gets one primary profile (+optional secondary) (FR-M11-001)
[ ] Strengths/risks/explanation shown in plain language (FR-M11-002)
[ ] dna_history records changes over time (FR-M11-003)
[ ] RLS proven → tag v0.5.0
```

---

### Module 6 — Resilience and Risk

**Purpose:** 0–100 resilience score plus exposure flags (emergency fund, liquidity, income risk, leverage, concentration).
**Implements:** FR-M12-001…005. **Depends on:** Modules 2–4.

#### Migration — `0007_module6.sql`
```sql
create table resilience_scores (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  score_month date not null, resilience_score numeric(5,2) not null,
  drivers jsonb, model_version text not null, created_at timestamptz default now(),
  unique (user_id, score_month, model_version)
);
create table risk_exposure_results (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  risk_type text not null,                 -- income|leverage|concentration|liquidity
  severity text not null,                  -- low|medium|high
  explanation text, created_at timestamptz default now()
);
create table risk_thresholds (
  risk_type text primary key, medium_at numeric, high_at numeric  -- admin-configurable
);
alter table resilience_scores enable row level security;
alter table risk_exposure_results enable row level security;
create policy "own resilience" on resilience_scores for all using (auth.uid()=user_id) with check (auth.uid()=user_id);
create policy "own risks" on risk_exposure_results for all using (auth.uid()=user_id) with check (auth.uid()=user_id);
```

#### Engine — `lib/engines/resilience/index.ts`
```typescript
export const RESILIENCE_MODEL_VERSION = 'res-1.0.0';
const clamp = (n: number) => Math.max(0, Math.min(100, n));

export function calculateResilience(i: {
  liquidAssets: number; monthlyEssentialExpenses: number;
  incomeSources: number; largestIncomeShare: number;        // 0..1
  debtServicingRatio: number; hasProtection: boolean;
  largestAssetConcentration: number;                        // 0..1
}) {
  const emMonths = i.monthlyEssentialExpenses > 0 ? i.liquidAssets / i.monthlyEssentialExpenses : 0;
  const emergencyScore = clamp((emMonths / 6) * 100);
  const incomeScore = clamp(100 - i.largestIncomeShare * 60 - (i.incomeSources <= 1 ? 20 : 0));
  const leverageScore = clamp(100 - i.debtServicingRatio * 150);
  const protectionScore = i.hasProtection ? 100 : 40;
  const resilience = emergencyScore * 0.4 + incomeScore * 0.2 + leverageScore * 0.25 + protectionScore * 0.15;

  const risks: { risk_type: string; severity: 'low'|'medium'|'high'; explanation: string }[] = [];
  if (emMonths < 3) risks.push({ risk_type: 'liquidity', severity: emMonths < 1 ? 'high' : 'medium', explanation: `Emergency fund covers ~${emMonths.toFixed(1)} months of essentials.` });
  if (i.incomeSources <= 1) risks.push({ risk_type: 'income', severity: 'medium', explanation: 'Household relies on a single income source.' });
  if (i.debtServicingRatio > 0.4) risks.push({ risk_type: 'leverage', severity: 'high', explanation: 'A high share of income services debt.' });
  if (i.largestAssetConcentration > 0.6) risks.push({ risk_type: 'concentration', severity: 'medium', explanation: 'Wealth is concentrated in one asset.' });

  return { resilience: Math.round(resilience * 100) / 100, emergencyFundMonths: emMonths, risks };
}
```
UI: `ScoreGauge` for resilience + `RiskBadge` cards per exposure.

#### Module 6 Acceptance Gate
```
[ ] Resilience score + drivers + actions (FR-M12-001)
[ ] Emergency-fund months + benchmark interpretation (FR-M12-002)
[ ] Income/leverage/concentration flags with severity (FR-M12-003..005)
[ ] Thresholds read from risk_thresholds (admin-configurable) → tag v0.6.0
```

---

### Module 7 — Goals and Forecasting

**Purpose:** Goal setup, progress, required-contribution calculator, and conservative/base/optimistic deterministic projections + retirement shell.
**Implements:** FR-M13-001…005. **Depends on:** Modules 1–3.

#### Migration — `0008_module7.sql`
Reuses `user_goals`; adds contributions, assumptions and forecast results.
```sql
create table goal_contributions (
  id uuid primary key default gen_random_uuid(),
  goal_id uuid not null references user_goals(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  amount numeric(18,2) not null, contributed_at date not null
);
create table forecast_results (
  id uuid primary key default gen_random_uuid(),
  goal_id uuid references user_goals(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  scenario text not null,                  -- conservative|base|optimistic
  projected_value numeric(18,2), on_track boolean, assumptions jsonb,
  created_at timestamptz default now()
);
alter table goal_contributions enable row level security;
alter table forecast_results enable row level security;
create policy "own contrib" on goal_contributions for all using (auth.uid()=user_id) with check (auth.uid()=user_id);
create policy "own forecast" on forecast_results for all using (auth.uid()=user_id) with check (auth.uid()=user_id);
```

#### Engine — `lib/engines/forecast/index.ts`
```typescript
// Required monthly contribution to hit a target (future value of annuity, guards edge cases).
export function requiredMonthlyContribution(p: {
  target: number; current: number; monthsRemaining: number; annualReturn: number;
}): number | null {
  if (p.monthsRemaining <= 0) return null;            // FR-M13-003 past-date safety
  const gap = Math.max(0, p.target - p.current);
  if (gap === 0) return 0;
  const r = p.annualReturn / 12;
  const grownCurrent = p.current * Math.pow(1 + r, p.monthsRemaining);
  const remaining = Math.max(0, p.target - grownCurrent);
  if (r === 0) return remaining / p.monthsRemaining;
  const factor = (Math.pow(1 + r, p.monthsRemaining) - 1) / r;
  return remaining / factor;
}

const SCENARIOS = { conservative: 0.03, base: 0.05, optimistic: 0.08 };
export function projectGoal(p: { current: number; monthlyContribution: number; monthsRemaining: number; target: number }) {
  return (Object.keys(SCENARIOS) as (keyof typeof SCENARIOS)[]).map(scenario => {
    const r = SCENARIOS[scenario] / 12;
    let value = p.current;
    for (let m = 0; m < p.monthsRemaining; m++) value = value * (1 + r) + p.monthlyContribution;
    return { scenario, projected_value: Math.round(value), on_track: value >= p.target };
  });
}
```
UI: goal cards with progress %, contribution calculator, `ScenarioToggle` showing three projections, retirement-shell projection with visible assumptions/limitations (FR-M13-005).

#### Tests
```typescript
it('required contribution is null for past target dates', () =>
  expect(requiredMonthlyContribution({ target: 1000, current: 0, monthsRemaining: 0, annualReturn: 0.05 })).toBeNull());
it('zero gap needs zero contribution', () =>
  expect(requiredMonthlyContribution({ target: 500, current: 500, monthsRemaining: 12, annualReturn: 0.05 })).toBe(0));
```

#### Module 7 Acceptance Gate
```
[ ] Goal CRUD + progress % + remaining gap (FR-M13-001..002)
[ ] Contribution calc handles past dates, zero targets, missing values (FR-M13-003)
[ ] Conservative/base/optimistic projections visible (FR-M13-004)
[ ] Retirement shell states assumptions + limitations (FR-M13-005) → tag v0.7.0
```

---

### Module 8 — Financial Twin™ and Benchmarking

**Purpose:** Indicative peer comparison using **synthetic** benchmark profiles (no other user's personal data) with clear methodology disclaimers.
**Implements:** FR-M14-001…004. **Depends on:** Modules 4–6.

#### Migration — `0009_module8.sql`
```sql
create table benchmark_groups (
  id uuid primary key default gen_random_uuid(),
  country_code char(2), age_band text, income_band text, household_type text,
  dna_profile text
);
create table benchmark_metrics (
  id uuid primary key default gen_random_uuid(),
  group_id uuid references benchmark_groups(id) on delete cascade,
  metric_name text not null,               -- net_worth|savings_rate|debt_ratio|retirement|emergency_fund|invest_rate
  benchmark_value numeric(18,4), source text
);
create table financial_twins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  group_id uuid references benchmark_groups(id),
  generated_at timestamptz default now(), comparison jsonb
);
alter table financial_twins enable row level security;
create policy "own twin" on financial_twins for all using (auth.uid()=user_id) with check (auth.uid()=user_id);
-- benchmark_groups/metrics are reference data: world-readable, admin-writable.
alter table benchmark_groups enable row level security;
alter table benchmark_metrics enable row level security;
create policy "read groups" on benchmark_groups for select using (true);
create policy "read metrics" on benchmark_metrics for select using (true);
```

#### Engine — `lib/engines/twin/index.ts`
```typescript
// Match user to a peer group, then compare each metric to the synthetic benchmark.
export function matchPeerGroup(u: { country: string; ageBand: string; incomeBand: string; householdType: string; dnaProfile?: string }) {
  return { country_code: u.country, age_band: u.ageBand, income_band: u.incomeBand,
           household_type: u.householdType, dna_profile: u.dnaProfile ?? null };
}
export function compareToTwin(userMetrics: Record<string, number>, benchmark: Record<string, number>) {
  return Object.keys(benchmark).map(metric => ({
    metric,
    user_value: userMetrics[metric] ?? null,
    benchmark_value: benchmark[metric],
    gap: userMetrics[metric] != null ? userMetrics[metric] - benchmark[metric] : null,
  }));
}
export const TWIN_DISCLAIMER =
  'Comparisons use indicative synthetic benchmarks, not other users’ data, and depend on available data sources.';
```
UI: user-vs-twin comparison table (`MetricCard` gaps), `CountryCurrencyTag`, and a persistent methodology note. Target Path™ / Best-Fit Path™ render as `LockedFeatureCard` placeholders.

#### Module 8 Acceptance Gate
```
[ ] Peer group shown from country/age/income/household/DNA (FR-M14-001)
[ ] Synthetic twin comparison table + limitations (FR-M14-002)
[ ] Net worth/savings/debt/retirement/emergency/invest metrics compared (FR-M14-003)
[ ] Methodology + "indicative" label always visible (FR-M14-004)
[ ] No real user data leaks into any benchmark → tag v0.8.0
```

---

### Module 9 — Reports and Exports

**Purpose:** Monthly summary reports (health, goals, net worth) built print/PDF-ready, with report history and advice-boundary disclaimers.
**Implements:** FR-M15-001…004. **Depends on:** Modules 4–8.

#### Migration — `0010_module9.sql`
```sql
create table reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  report_month date not null, report_type text not null,
  snapshot_ref jsonb, created_at timestamptz default now()
);
alter table reports enable row level security;
create policy "own reports" on reports for all using (auth.uid()=user_id) with check (auth.uid()=user_id);
```

#### Approach
Generate reports server-side by composing the already-stored monthly snapshots (dashboard, score, resilience, goals) — do **not** recalculate, read the immutable snapshot so a report always reflects that month. Render with the `ReportSection` component using print-friendly CSS (`@media print`). PDF export can be added later with a library such as `@react-pdf/renderer` or a headless-Chrome print; the layout is already PDF-ready per FR-M15-003.

Every report footer must render the standard educational/informational disclaimer and pass `violatesAdviceBoundary` (FR-M15-004).

#### Module 9 Acceptance Gate
```
[ ] Monthly report opens for a selected month (FR-M15-001)
[ ] Report history lists prior months (FR-M15-002)
[ ] Print preview renders cleanly desktop + mobile (FR-M15-003)
[ ] Disclaimer present; no product-recommendation wording (FR-M15-004) → tag v0.9.0
```

---

### Module 10 — AI Coach and Insights

**Purpose:** Explainable, bounded AI insights generated **from structured calculation outputs** (never free-form prompts), with strict guardrails and feedback capture.
**Implements:** FR-M16-001…004. **Depends on:** Modules 4–9.

#### Migration — `0011_module10.sql`
```sql
create table ai_prompt_templates (
  id uuid primary key default gen_random_uuid(),
  template_key text unique not null,       -- score_explanation|risk_explanation|goal_progress
  template_text text not null, version text not null, is_active boolean default true
);
create table ai_insights (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  insight_type text not null, body text not null,
  source_context jsonb,                    -- DQ-008: the structured inputs used
  model_name text, model_version text, created_at timestamptz default now()
);
create table ai_output_audit (
  id uuid primary key default gen_random_uuid(),
  insight_id uuid references ai_insights(id) on delete cascade,
  passed_guardrails boolean, notes text, created_at timestamptz default now()
);
create table ai_feedback (
  id uuid primary key default gen_random_uuid(),
  insight_id uuid references ai_insights(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  helpful boolean, created_at timestamptz default now()
);
alter table ai_insights enable row level security;
alter table ai_feedback enable row level security;
create policy "own insights" on ai_insights for all using (auth.uid()=user_id) with check (auth.uid()=user_id);
create policy "own ai feedback" on ai_feedback for all using (auth.uid()=user_id) with check (auth.uid()=user_id);
```

#### Bounded generation — `lib/engines/coach/index.ts`
```typescript
import { violatesAdviceBoundary } from '@/lib/advice-boundary/check';

// Inputs are STRUCTURED numbers/deltas, never raw user prompts (FR-M16-001).
export interface InsightContext {
  metric: string; previous: number; current: number; direction: 'up' | 'down' | 'flat';
}

// The AI is asked to explain a measured change and is post-filtered (FR-M16-002).
export async function generateInsight(ctx: InsightContext, callModel: (prompt: string) => Promise<string>) {
  const prompt = `Explain, in plain English and WITHOUT giving personal financial product advice, ` +
    `why the user's ${ctx.metric} moved from ${ctx.previous} to ${ctx.current} (${ctx.direction}). ` +
    `Suggest general areas to review. Do not tell the user to buy, sell or switch any product.`;
  const body = await callModel(prompt);
  const passed = !violatesAdviceBoundary(body);
  return { body: passed ? body : 'This month your ' + ctx.metric + ' changed. Review the related pillar for context.',
           passedGuardrails: passed, sourceContext: ctx };
}
```
Store `model_name`, `model_version`, `source_context` on every insight (DQ-008). Record `ai_output_audit`. Provide 👍/👎 feedback → `ai_feedback` (FR-M16-004). Prompt templates are versioned in `ai_prompt_templates` (FR-M16-003).

> Model choice is pluggable behind `callModel`. Keep the key server-side; never expose it to the browser.

#### Module 10 Acceptance Gate
```
[ ] Insights reference measurable changes (savings rate, debt ratio) (FR-M16-001)
[ ] Guardrail filters/refuses advice-boundary violations (FR-M16-002)
[ ] Prompt templates versioned + auditable (FR-M16-003)
[ ] 👍/👎 feedback stored (FR-M16-004)
[ ] Every insight stores model + source context → tag v0.10.0
```

---

### Module 11 — Settings, Consent and Privacy

**Purpose:** Profile/preferences editing, consent records, notification prefs, data-export and account-deletion workflows.
**Implements:** FR-M17-001…005. **Depends on:** Module 1 (consent/audit tables already scaffolded in Foundation).

#### Migration — `0012_module11.sql`
```sql
create table user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email_notifications boolean default true, inapp_notifications boolean default true,
  updated_at timestamptz default now()
);
create table data_export_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  status text default 'pending', requested_at timestamptz default now(), completed_at timestamptz
);
create table account_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  status text default 'pending', confirmed boolean default false, requested_at timestamptz default now()
);
alter table user_settings enable row level security;
alter table data_export_requests enable row level security;
alter table account_deletion_requests enable row level security;
create policy "own settings" on user_settings for all using (auth.uid()=user_id) with check (auth.uid()=user_id);
create policy "own export" on data_export_requests for all using (auth.uid()=user_id) with check (auth.uid()=user_id);
create policy "own deletion" on account_deletion_requests for all using (auth.uid()=user_id) with check (auth.uid()=user_id);
```
Consent capture writes to the `consents` table from Foundation, storing `consent_type`, `consent_version`, `granted_at` (FR-M17-002). Export/deletion are **request workflows** with status (do not hard-delete immediately; this respects the "prohibited actions" boundary — a human/admin completes destructive steps).

#### Module 11 Acceptance Gate
```
[ ] Edit profile/household flows through to dashboard + future calcs (FR-M17-001)
[ ] Consent records store version + timestamp + scope (FR-M17-002)
[ ] Notification prefs respected (FR-M17-003)
[ ] Export + deletion requests capture status/confirmation (FR-M17-004..005)
[ ] Privacy notice card visible → tag v0.11.0
```

---

### Module 12 — Admin and Operations

**Purpose:** Role-based admin, reference-data management, audit-log review, operational health, and privacy-safe support views.
**Implements:** FR-M18-001…004. **Depends on:** Module 1.

#### Migration — `0013_module12.sql`
```sql
create table admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'admin'       -- admin|support
);
create table system_jobs (
  id uuid primary key default gen_random_uuid(),
  job_type text not null, status text, ran_at timestamptz default now(), detail jsonb
);
create table support_cases (
  id uuid primary key default gen_random_uuid(),
  subject_user_id uuid references auth.users(id), status text default 'open',
  metadata jsonb, created_at timestamptz default now()
);

-- Admin gate helper: is the caller an admin?
create or replace function is_admin() returns boolean language sql stable as $$
  select exists (select 1 from admin_users where user_id = auth.uid());
$$;

alter table admin_users enable row level security;
alter table system_jobs enable row level security;
alter table support_cases enable row level security;
-- Only admins can read admin/ops tables (FR-M18-001)
create policy "admins read jobs" on system_jobs for select using (is_admin());
create policy "admins read cases" on support_cases for select using (is_admin());
create policy "admins read admins" on admin_users for select using (is_admin());

-- Reference-data write policies (countries/currencies/thresholds): admins only
create policy "admins write countries" on countries for all using (is_admin()) with check (is_admin());
create policy "admins write currencies" on currencies for all using (is_admin()) with check (is_admin());
```
Admin routes live under `app/(app)/admin` and are additionally guarded server-side by `is_admin()`. **Support role cannot open full financial data** — support views read only account metadata (FR-M18-004); financial tables stay behind the owner-only RLS policies, so even an admin/support session cannot select another user's financial rows unless a future explicit consent mechanism grants it.

#### Module 12 Acceptance Gate
```
[ ] Non-admins cannot reach admin routes/APIs (FR-M18-001)
[ ] Admins manage countries/currencies/categories/thresholds used by forms (FR-M18-002)
[ ] Audit events filterable by type + date (FR-M18-003)
[ ] Support view exposes metadata only, not financial rows (FR-M18-004) → tag v1.0.0
```

---

## Part 3 — Cross-Cutting Concerns

### 3.1 Security & compliance checklist (apply continuously)

From your Security & Compliance spec — verify on **every** module, not once:

```
[ ] RLS enabled on every user-owned table; owner-only policy tested
[ ] Service-role key used only in server code; never shipped to browser
[ ] All money fields FK to currencies; country fields FK/checked to countries (DQ-001/002)
[ ] Amounts CHECK >= 0 unless explicitly permitted (DQ-003)
[ ] Every user-owned row has NOT NULL user_id (DQ-004)
[ ] Monthly snapshots unique per (user, month, model_version) (DQ-005)
[ ] Financial history soft-deleted (is_active/deleted_at), not hard-deleted (DQ-006)
[ ] AI outputs store model_name/version/source_context (DQ-008)
[ ] Audit events written for login, update, delete, export, calc runs
[ ] Consent captured with type/version/timestamp before AI or any integration
[ ] Advice-boundary check passes on all user-facing insight/report copy
[ ] Input validated with Zod at every API boundary
```

### 3.2 Non-functional requirements (baseline targets)

| Area | Target |
|------|--------|
| Performance | Dashboard summary API < 500 ms P95 on typical data volumes |
| Accessibility | WCAG 2.2 AA (contrast, keyboard nav, screen-reader labels) |
| Responsive | Works desktop / laptop / tablet / mobile / small-mobile per UX breakpoints |
| Reliability | Score/forecast engines are pure functions with unit tests; deterministic |
| Privacy | Data minimisation; encryption in transit + at rest (Supabase managed) |
| Observability | Audit log + `system_jobs` for background/calc runs |

### 3.3 Deployment

```bash
# App → Vercel
vercel                      # link project
vercel env add NEXT_PUBLIC_SUPABASE_URL
vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY
vercel env add SUPABASE_SERVICE_ROLE_KEY   # server-only
vercel --prod

# Database migrations → Supabase (per module, in order)
supabase link --project-ref YOUR_REF
supabase db push            # applies supabase/migrations/*.sql
```
Run migrations in numeric order (`0001` → `0013`); each corresponds to a module gate.

### 3.4 Full build sequence & release-gate summary

| Tag | Milestone | Modules complete | Demo-able outcome |
|-----|-----------|------------------|-------------------|
| v0.0.0 | Foundation | — | App runs, auth + RLS + design tokens |
| v0.1.0 | Onboarding live | 1 | Sign up → onboard → dashboard shell |
| v0.2.0 | Data capture | 1–2 | User enters full financial profile manually |
| v0.3.0 | **MVP dashboard** | 1–3 | Net worth, cash flow, savings rate live |
| v0.4.0 | **Health Score™** | 1–4 | 0–100 score + pillars + history |
| v0.5.0 | Financial DNA™ | 1–5 | Behavioural profile |
| v0.6.0 | Resilience & Risk | 1–6 | Resilience score + risk flags |
| v0.7.0 | Goals & Forecasting | 1–7 | Goals + 3-scenario projections |
| v0.8.0 | Financial Twin™ | 1–8 | Synthetic benchmarking |
| v0.9.0 | Reports | 1–9 | Monthly print/PDF-ready reports |
| v0.10.0 | AI Coach | 1–10 | Bounded explainable insights |
| v0.11.0 | Settings/Consent/Privacy | 1–11 | Consent, export/deletion requests |
| v1.0.0 | Admin & Ops → **full suite** | 1–12 | Complete platform |

> Recommended pilot point: after **v0.4.0** (Health Score™). Your master document advises collecting pilot feedback before investing in Open Banking or AI Coach — so consider a limited pilot at v0.4.0–v0.6.0 before building Modules 8–12.

### 3.5 What this guide deliberately defers (matches your master doc phasing)

- **Open Banking / CDR (Australia) and Account Aggregator (India)** integrations — MVP is manual-entry first (FR-CORE-004). Add after the data model and scoring are stable.
- **Native mobile apps** — web-first responsive covers Phase 1.
- **Real benchmark datasets** — Module 8 uses synthetic twins until real data matures.
- **Advanced Monte Carlo / stress testing** — Module 7 ships deterministic projections first; the Forecasting Engine spec's Monte Carlo design is a later enhancement.

---

## Appendix — Requirement Traceability Index

| Module | FRD Requirement IDs | Engine / Spec IDs |
|--------|--------------------|-------------------|
| Cross-module | FR-CORE-001…006 | — |
| 1 Foundation | FR-M07-001…007 | — |
| 2 Data Capture | FR-M08-001…007 | DQ-001…008 |
| 3 Dashboard | FR-M09-001…005 | — |
| 4 Health Score™ | FR-M10-001…005 | FIE-HS-001…004 |
| 5 Financial DNA™ | FR-M11-001…003 | — |
| 6 Resilience & Risk | FR-M12-001…005 | — |
| 7 Goals & Forecasting | FR-M13-001…005 | — |
| 8 Financial Twin™ | FR-M14-001…004 | — |
| 9 Reports | FR-M15-001…004 | — |
| 10 AI Coach | FR-M16-001…004 | — |
| 11 Settings/Consent/Privacy | FR-M17-001…005 | — |
| 12 Admin & Ops | FR-M18-001…004 | — |

*This build guide is derived from FHIP Volume 1 (Consolidated Master Document) and its supporting specification suite. Code is reference implementation intended to be built, run and tested per module against each Acceptance Gate before proceeding. Replace indicative formula constants (scoring multipliers, scenario return rates, thresholds) with values you calibrate and version.*
