import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { loadNetWorthStatementData } from '@/lib/services/netWorthStatementData';
import { parseStatementView, statementViewKey, statementsForView } from '@/lib/engines/netWorthStatement';
import { NetWorthStatementView } from '@/components/reports/netWorthStatement/NetWorthStatementView';
import { PrintTabToolbar } from '@/components/reports/PrintTabToolbar';

// Bare print view (no AppShell chrome): A4 portrait, one page per statement. Session auth only; there is no render token
// because browser printing is the Free path. Opened by OpenPrintTabLink in its own tab; PrintTabToolbar closes it after printing
// (lib/reports/printTab.ts). A bare print page has no back link by design (see the back-link guard allow-list). (A server-side PDF would need a hosted renderer: Amplify has no Chromium at runtime.)
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
      <PrintTabToolbar autoPrint={print === '1'} parentHref={`/reports/net-worth-statement?view=${encodeURIComponent(statementViewKey(view))}`} parentLabel="Net Worth Statement" />
      <NetWorthStatementView statements={statementsForView(data.set, view)} parityMessages={data.set.parity.ok ? [] : data.set.parity.messages} />
    </div>
  );
}
