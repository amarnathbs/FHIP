'use client';

import { useEffect, useState } from 'react';
import { fetchJson } from '@/components/retirement/smsf/format';
import {
  diagnoseEntityRegisters,
  type DiagLiabilityRow,
  type DiagRetirementRow,
  type DiagSmsfFund,
  type EntityRegisterFinding,
} from '@/lib/engines/entityRegisterDiagnostics';

// Read-only heads-up (design slice, 16-10-2026): says where SMSF money may be recorded twice, or where an
// SMSF debt sits among personal liabilities. It changes nothing. Renders nothing when there is nothing to
// say, and nothing at all if any read fails (a notice must never become an error banner).
// Design: docs/architecture/ENTITY_LEVEL_ASSETS_AND_LIABILITIES_DESIGN_2026-10-16.md

interface RetirementApiRow {
  id: string;
  account_name: string;
  owner: string | null;
  master_item_key: string | null;
  current_balance: number | string;
  currency_code: string;
  is_active: boolean;
}
interface LiabilityApiRow {
  id: string;
  liability_name: string;
  owner: string | null;
  balance: number | string;
  currency_code: string;
  is_active: boolean;
}
interface FundApiRow {
  id: string;
  retirement_account_id: string;
  mode: 'summary' | 'detailed';
  is_active: boolean;
  summary_balance?: number | string | null;
  currency_code?: string;
}
interface LoanLinkApiRow {
  liability_id: string;
}

export function EntityRegisterNotice({ page }: { page: 'retirement' | 'liabilities' }) {
  const [findings, setFindings] = useState<EntityRegisterFinding[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [retirement, liabilities, funds] = await Promise.all([
          fetchJson<RetirementApiRow[]>('/api/retirement'),
          fetchJson<LiabilityApiRow[]>('/api/liabilities'),
          fetchJson<FundApiRow[]>('/api/smsf'),
        ]);
        const linked: string[] = [];
        for (const f of funds.filter((x) => x.is_active)) {
          const links = await fetchJson<LoanLinkApiRow[]>(`/api/smsf/${f.id}/property-loan`);
          for (const l of links) linked.push(l.liability_id);
        }
        const result = diagnoseEntityRegisters({
          retirement: retirement.map<DiagRetirementRow>((r) => ({
            id: r.id,
            name: r.account_name,
            owner: r.owner,
            masterItemKey: r.master_item_key,
            balance: Number(r.current_balance),
            currency: r.currency_code,
            isActive: r.is_active !== false,
          })),
          liabilities: liabilities.map<DiagLiabilityRow>((l) => ({
            id: l.id,
            name: l.liability_name,
            owner: l.owner,
            balance: Number(l.balance),
            currency: l.currency_code,
            isActive: l.is_active !== false,
          })),
          funds: funds.map<DiagSmsfFund>((f) => ({
            id: f.id,
            retirementAccountId: f.retirement_account_id,
            mode: f.mode,
            isActive: f.is_active,
            typedNet: f.summary_balance === null || f.summary_balance === undefined ? null : Number(f.summary_balance),
            currency: f.currency_code,
          })),
          smsfLinkedLiabilityIds: linked,
        });
        if (!cancelled) setFindings(result.filter((f) => f.pages.includes(page)));
      } catch {
        if (!cancelled) setFindings([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [page]);

  if (findings.length === 0) return null;
  return (
    <section aria-label="Check your SMSF entries" className="space-y-2">
      {findings.map((f) => (
        <div key={f.code} role="note" className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-ink">
          <p className="font-medium">{f.title}</p>
          <p className="mt-1">{f.message}</p>
        </div>
      ))}
    </section>
  );
}
