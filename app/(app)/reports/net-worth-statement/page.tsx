import { PageBackLink } from '@/components/navigation/PageBackLink';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { loadNetWorthStatementData } from '@/lib/services/netWorthStatementData';
import { parseStatementView, statementViewKey, statementsForView, type NetWorthStatementSet } from '@/lib/engines/netWorthStatement';
import { NetWorthStatementView } from '@/components/reports/netWorthStatement/NetWorthStatementView';
import { OpenPrintTabLink } from '@/components/reports/OpenPrintTabLink';
import { StatementPicker } from '@/components/reports/netWorthStatement/StatementPicker';

// Net Worth Statement (PO request 16-10-2026). Reports > Net Worth Statement. Available to every signed-in plan (Free and
// Premium): it only presents the person's own entered data, and browser printing is free for everyone (the rule on /reports). No plan check here on purpose; tests/unit/netWorthStatementAccess.test.ts pins that.
async function NetWorthStatementPageContent({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const { view: rawView } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const data = await loadNetWorthStatementData(user.id, supabase);

  return (
    <div className="space-y-5">
      <div className="no-print">
        <h1 className="text-2xl font-semibold text-trust">Net Worth Statement</h1>
        <p className="mt-1 text-muted">
          A one-page list of what you own and owe, item by item, with totals. Personal, each entity, and the family total are separate pages.
        </p>
      </div>
      {data.status === 'unavailable' ? (
        <div role="status" className="rounded-card border border-dashed bg-gray-50 p-6 text-sm text-gray-700" data-testid="nws-unavailable">
          The statement cannot be shown right now. {data.reason} Nothing has been estimated or shown as zero.
        </div>
      ) : (
        <StatementContent data={data.set} rawView={rawView} />
      )}
    </div>
  );
}

function StatementContent({ data, rawView }: { data: NetWorthStatementSet; rawView: string | undefined }) {
  const view = parseStatementView(rawView, data);
  const statements = statementsForView(data, view);
  const key = statementViewKey(view);
  return (
    <>
      <div className="no-print flex flex-wrap items-center justify-between gap-3">
        <StatementPicker set={data} view={view} />
        <OpenPrintTabLink
          href={`/reports/net-worth-statement/print?view=${encodeURIComponent(key)}&print=1`}
          windowName="net-worth-statement"
          className="rounded border px-3 py-1.5 text-sm text-gray-700 hover:border-trust"
        >
          Print / Save as PDF{key === 'all' ? ' (one page each)' : ''}
        </OpenPrintTabLink>
      </div>
      <NetWorthStatementView statements={statements} parityMessages={data.parity.ok ? [] : data.parity.messages} />
    </>
  );
}

// Every page carries the shared back link to its parent (Reports).
export default function NetWorthStatementPage(props: Parameters<typeof NetWorthStatementPageContent>[0]) {
  return (
    <>
      <PageBackLink href="/reports" label="Reports" />
      <NetWorthStatementPageContent {...props} />
    </>
  );
}
