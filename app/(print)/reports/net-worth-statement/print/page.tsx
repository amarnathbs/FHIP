import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { loadNetWorthStatementData } from '@/lib/services/netWorthStatementData';
import { parseStatementView, statementsForView } from '@/lib/engines/netWorthStatement';
import { NetWorthStatementView } from '@/components/reports/netWorthStatement/NetWorthStatementView';
import { PageBackLink } from '@/components/navigation/PageBackLink';
import { PrintToolbar } from '@/components/reports/netWorthStatement/PrintToolbar';

// Bare print view (no AppShell chrome): A4 portrait, one page per statement. Session auth only; there is no render token
// because browser printing is the Free path. (A server-side PDF export would be a Premium Export Centre feature.)
export default async function NetWorthStatementPrintPage({ searchParams }: { searchParams: Promise<{ view?: string; print?: string }> }) {
  const { view: rawView, print } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const data = await loadNetWorthStatementData(user.id, supabase);
  if (data.status === 'unavailable') {
    return (
      <div className="mx-auto max-w-3xl p-6 text-sm text-gray-700" role="status">
        The statement cannot be shown right now. {data.reason}
      </div>
    );
  }
  const view = parseStatementView(rawView, data.set);
  return (
    <div className="mx-auto max-w-3xl p-6 print:p-0">
      <div className="no-print">
        <PageBackLink href="/reports/net-worth-statement" label="Net Worth Statement" />
      </div>
      <PrintToolbar autoPrint={print === '1'} />
      <NetWorthStatementView statements={statementsForView(data.set, view)} parityMessages={data.set.parity.ok ? [] : data.set.parity.messages} />
    </div>
  );
}
