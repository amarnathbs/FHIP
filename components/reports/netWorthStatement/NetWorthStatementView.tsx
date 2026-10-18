// Net Worth Statements -- the presentational components (PO request 16-10-2026). No 'use client': usable from the page and from the
// bare print route. Every figure is read from the builder's output (lib/engines/netWorthStatement.ts); nothing is computed here
// beyond formatting. Every table is the shared <DataTable>. Print rules live under `.nws-root` in app/globals.css.
import type { ReactNode } from 'react';
import { DataTable, DataTd, DataTh } from '@/components/ui/DataTable';
import { formatMoney, formatMoneyCode } from '@/lib/engines/money';
import {
  ENTITY_NOT_ITEMISED_NOTE,
  NET_WORTH_STATEMENT_DISCLAIMER,
  NOT_PROVIDED_LABEL,
  type EntityStatement,
  type FamilyStatement,
  type NotIncludedLine,
  type PersonalStatement,
  type StatementCurrency,
  type StatementGroup,
  type StatementHeader,
  type StatementLine,
} from '@/lib/engines/netWorthStatement';

type AnyStatement = PersonalStatement | EntityStatement | FamilyStatement;

const money = (n: number, c: StatementCurrency) => formatMoney(n, c);

function Amount({ line, currency }: { line: StatementLine; currency: StatementCurrency }) {
  if (line.status !== 'ok' || line.amount === null) {
    return <span className="italic text-gray-600" data-testid="not-provided">{NOT_PROVIDED_LABEL}</span>;
  }
  return (
    <>
      {money(line.amount, currency)}
      {line.native ? (
        <span className="block text-xs font-normal text-gray-600" data-testid="native-amount">
          {formatMoneyCode(line.native.amount, line.native.currency)}
        </span>
      ) : null}
    </>
  );
}

function MaybeAmount({ value, currency, fallback = 'Not itemised' }: { value: number | null; currency: StatementCurrency; fallback?: string }) {
  if (value === null) return <span className="italic text-gray-600">{fallback}</span>;
  return <>{money(value, currency)}</>;
}

function StatementHead({ header, id }: { header: StatementHeader; id: string }) {
  return (
    <header className="nws-head border-b border-gray-300 pb-2">
      <h2 id={id} className="text-xl font-semibold text-trust">
        {header.title}
      </h2>
      <p className="mt-0.5 text-sm font-medium text-ink">{header.subtitle}</p>
      <p className="text-xs text-gray-700">
        <span className="whitespace-nowrap">{header.asAtLabel}</span>
        <span aria-hidden="true"> &middot; </span>
        <span className="whitespace-nowrap">Reporting currency: {header.currency}</span>
        {header.holderName ? (
          <>
            <span aria-hidden="true"> &middot; </span>
            <span>Prepared for {header.holderName}</span>
          </>
        ) : null}
      </p>
    </header>
  );
}

function Block({ title, children, id }: { title: string; children: ReactNode; id: string }) {
  return (
    <section aria-labelledby={id} className="nws-block mt-3">
      <h3 id={id} className="mb-1 text-sm font-semibold text-ink">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Totalled({ children }: { children: ReactNode }) {
  return <tr className="nws-total border-t-2 border-gray-400 bg-gray-50 font-semibold">{children}</tr>;
}

function ItemRow({ line, currency, showOwner = true }: { line: StatementLine; currency: StatementCurrency; showOwner?: boolean }) {
  return (
    <tr className="border-t border-gray-100">
      <DataTh scope="row" className="font-normal text-left">
        {line.name}
      </DataTh>
      {showOwner ? <DataTd>{line.ownerLabel}</DataTd> : null}
      <DataTd kind="num">
        <Amount line={line} currency={currency} />
      </DataTd>
    </tr>
  );
}

function AssetsTable({ groups, total, currency, label }: { groups: StatementGroup[]; total: number; currency: StatementCurrency; label: string }) {
  return (
    <DataTable label={label} className="nws-table">
      <caption className="sr-only">{label}: item, owner and amount in {currency}, grouped, with a subtotal for each group and a total.</caption>
      <thead>
        <tr className="bg-gray-100 text-left">
          <DataTh>Item</DataTh>
          <DataTh>Owner</DataTh>
          <DataTh kind="num">Amount ({currency})</DataTh>
        </tr>
      </thead>
      {groups.map((g) => (
        <tbody key={g.key} data-testid={`group-${g.key}`}>
          <tr className="bg-gray-50">
            <DataTh scope="rowgroup" colSpan={2} className="text-left text-xs uppercase tracking-wide text-gray-700">
              {g.label}
            </DataTh>
            <DataTd kind="num" className="font-medium" data-testid={`subtotal-${g.key}`}>
              <span className="mr-2 text-xs font-normal normal-case text-gray-600">Subtotal</span>
              {money(g.subtotal, currency)}
            </DataTd>
          </tr>
          {g.lines.map((l) => (
            <ItemRow key={l.id} line={l} currency={currency} />
          ))}
        </tbody>
      ))}
      <tbody>
        <Totalled>
          <DataTh scope="row" colSpan={2} className="text-left">
            Total assets
          </DataTh>
          <DataTd kind="num" data-testid="total-assets">
            {money(total, currency)}
          </DataTd>
        </Totalled>
      </tbody>
    </DataTable>
  );
}

function LiabilitiesTable({ lines, total, currency, label }: { lines: StatementLine[]; total: number; currency: StatementCurrency; label: string }) {
  return (
    <DataTable label={label} className="nws-table">
      <caption className="sr-only">{label}: item, owner and amount in {currency}, with a total.</caption>
      <thead>
        <tr className="bg-gray-100 text-left">
          <DataTh>Item</DataTh>
          <DataTh>Owner</DataTh>
          <DataTh kind="num">Amount ({currency})</DataTh>
        </tr>
      </thead>
      <tbody>
        {lines.length === 0 ? (
          <tr>
            <DataTd colSpan={3} className="italic text-gray-600">
              No liabilities recorded.
            </DataTd>
          </tr>
        ) : (
          lines.map((l) => <ItemRow key={l.id} line={l} currency={currency} />)
        )}
        <Totalled>
          <DataTh scope="row" colSpan={2} className="text-left">
            Total liabilities
          </DataTh>
          <DataTd kind="num" data-testid="total-liabilities">
            {money(total, currency)}
          </DataTd>
        </Totalled>
      </tbody>
    </DataTable>
  );
}

function NetWorthLine({ label, value, currency, testId }: { label: string; value: number | null; currency: StatementCurrency; testId: string }) {
  return (
    <div role="group" aria-label={label} className="nws-networth mt-3 flex items-baseline justify-between rounded border-2 border-gray-400 bg-gray-50 px-3 py-1.5">
      <span className="text-sm font-semibold text-ink">{label}</span>
      <strong className="text-base tabular-nums text-ink" data-testid={testId}>
        <MaybeAmount value={value} currency={currency} fallback={NOT_PROVIDED_LABEL} />
      </strong>
    </div>
  );
}

function NotIncludedTable({ lines, currency }: { lines: NotIncludedLine[]; currency: StatementCurrency }) {
  if (lines.length === 0) return null;
  const id = `ni-${lines[0].id.replace(/[^a-z0-9]+/gi, '-')}`;
  return (
    <section aria-labelledby={id} className="nws-notincluded mt-2" data-testid="not-included">
      <h3 id={id} className="text-xs font-semibold text-ink">
        Not included in the totals
      </h3>
      <ul className="list-disc space-y-0.5 pl-5 text-xs text-gray-700">
        {lines.map((l) => (
          <li key={l.id}>
            {l.name} ({l.ownerLabel}), recorded as {l.native ? formatMoneyCode(l.native.amount, l.native.currency) : 'an amount'}: {l.reason}
          </li>
        ))}
      </ul>
      <span className="sr-only">Reporting currency {currency}</span>
    </section>
  );
}

function Notes({ notes, fxNote, explanation }: { notes: string[]; fxNote: string | null; explanation: string[] }) {
  const all = [...explanation, ...(fxNote ? [fxNote] : []), ...notes];
  if (all.length === 0) return null;
  return (
    <ul className="nws-notes mt-3 list-disc space-y-0.5 pl-5 text-xs text-gray-700">
      {all.map((n, i) => (
        <li key={i}>{n}</li>
      ))}
    </ul>
  );
}

function Disclaimer() {
  return <p className="nws-disclaimer mt-3 border-t border-gray-300 pt-2 text-[11px] leading-snug text-gray-600">{NET_WORTH_STATEMENT_DISCLAIMER}</p>;
}

export function PersonalStatementPage({ s }: { s: PersonalStatement }) {
  const c = s.header.currency;
  const id = 'nws-personal';
  return (
    <article className="nws-statement" aria-labelledby={id} data-statement="personal">
      <StatementHead header={s.header} id={id} />
      <Block title="Assets" id="nws-personal-assets">
        {s.assetGroups.length === 0 ? (
          <p className="text-sm text-gray-700">No personal assets are recorded.</p>
        ) : (
          <AssetsTable groups={s.assetGroups} total={s.totals.assets} currency={c} label="Personal assets" />
        )}
      </Block>
      <Block title="Liabilities" id="nws-personal-liabilities">
        <LiabilitiesTable lines={s.liabilities} total={s.totals.liabilities} currency={c} label="Personal liabilities" />
      </Block>
      <NetWorthLine label="Personal net worth (assets minus liabilities)" value={s.totals.net} currency={c} testId="net-worth" />
      <Block title="By person" id="nws-personal-people">
        <DataTable label="Personal net worth by person" className="nws-table">
          <caption className="sr-only">Net worth by person: own items, share of joint items, and net worth. Each joint item is counted once.</caption>
          <thead>
            <tr className="bg-gray-100 text-left">
              <DataTh>Person</DataTh>
              <DataTh kind="num">Own items</DataTh>
              <DataTh kind="num">Share of joint items</DataTh>
              <DataTh kind="num">Net worth</DataTh>
            </tr>
          </thead>
          <tbody>
            {s.byPerson.rows.map((r) => (
              <tr key={r.key} className="border-t border-gray-100" data-testid={`person-${r.key}`}>
                <DataTh scope="row" className="font-normal text-left">
                  {r.label}
                </DataTh>
                <DataTd kind="num">{money(r.ownNet, c)}</DataTd>
                <DataTd kind="num">{money(r.jointShareNet, c)}</DataTd>
                <DataTd kind="num" data-testid={`person-${r.key}-net`}>
                  {money(r.net, c)}
                </DataTd>
              </tr>
            ))}
            <Totalled>
              <DataTh scope="row" className="text-left">
                Personal net worth
              </DataTh>
              <DataTd kind="num">{money(s.byPerson.total.ownNet, c)}</DataTd>
              <DataTd kind="num">{money(s.byPerson.total.jointShareNet, c)}</DataTd>
              <DataTd kind="num" data-testid="person-total-net">
                {money(s.byPerson.total.net, c)}
              </DataTd>
            </Totalled>
          </tbody>
        </DataTable>
        {s.byPerson.jointPool ? (
          <p className="nws-small mt-1 text-xs text-gray-700" data-testid="joint-pool">
            Joint items before they are divided: assets {money(s.byPerson.jointPool.assets, c)}, liabilities {money(s.byPerson.jointPool.liabilities, c)}, net{' '}
            {money(s.byPerson.jointPool.net, c)}. {s.byPerson.jointSplitText ?? ''}
          </p>
        ) : null}
      </Block>
      <NotIncludedTable lines={s.notIncluded} currency={c} />
      <Notes notes={s.notes} fxNote={s.fxNote} explanation={[s.levelExplanation]} />
      <Disclaimer />
    </article>
  );
}

export function EntityStatementPage({ s }: { s: EntityStatement }) {
  const c = s.header.currency;
  const id = `nws-entity-${s.entityId.replace(/[^a-z0-9]+/gi, '-')}`;
  const itemised = s.itemisation === 'itemised';
  return (
    <article className="nws-statement" aria-labelledby={id} data-statement="entity" data-entity-id={s.entityId}>
      <StatementHead header={s.header} id={id} />
      <Block title="Assets" id={`${id}-assets`}>
        <DataTable label={`${s.header.subtitle} assets`} className="nws-table">
          <caption className="sr-only">{s.header.subtitle} assets: item and amount in {c}, with a total.</caption>
          <thead>
            <tr className="bg-gray-100 text-left">
              <DataTh>Item</DataTh>
              <DataTh kind="num">Amount ({c})</DataTh>
            </tr>
          </thead>
          <tbody>
            {s.assets.length === 0 ? (
              <tr>
                <DataTd colSpan={2} className="italic text-gray-600">
                  Not itemised
                </DataTd>
              </tr>
            ) : (
              s.assets.map((l) => (
                <tr key={l.id} className="border-t border-gray-100">
                  <DataTh scope="row" className="font-normal text-left">
                    {l.name}
                  </DataTh>
                  <DataTd kind="num">
                    <Amount line={l} currency={c} />
                  </DataTd>
                </tr>
              ))
            )}
            <Totalled>
              <DataTh scope="row" className="text-left">
                Total assets
              </DataTh>
              <DataTd kind="num" data-testid="entity-total-assets">
                <MaybeAmount value={s.assetsTotal} currency={c} />
              </DataTd>
            </Totalled>
          </tbody>
        </DataTable>
      </Block>
      <Block title="Liabilities" id={`${id}-liabilities`}>
        <DataTable label={`${s.header.subtitle} liabilities`} className="nws-table">
          <caption className="sr-only">{s.header.subtitle} liabilities: item and amount in {c}, with a total.</caption>
          <thead>
            <tr className="bg-gray-100 text-left">
              <DataTh>Item</DataTh>
              <DataTh kind="num">Amount ({c})</DataTh>
            </tr>
          </thead>
          <tbody>
            {s.liabilities.length === 0 ? (
              <tr>
                <DataTd colSpan={2} className="italic text-gray-600" data-testid={s.liabilitiesNotRecorded ? 'liabilities-not-recorded' : undefined}>
                  {s.liabilitiesNotRecorded ? 'Not recorded at the fund' : itemised ? 'No liabilities recorded.' : 'Not itemised'}
                </DataTd>
              </tr>
            ) : (
              s.liabilities.map((l) => (
                <tr key={l.id} className="border-t border-gray-100">
                  <DataTh scope="row" className="font-normal text-left">
                    {l.name}
                  </DataTh>
                  <DataTd kind="num">
                    <Amount line={l} currency={c} />
                  </DataTd>
                </tr>
              ))
            )}
            <Totalled>
              <DataTh scope="row" className="text-left">
                Total liabilities
              </DataTh>
              <DataTd kind="num" data-testid="entity-total-liabilities">
                <MaybeAmount value={s.liabilitiesTotal} currency={c} fallback={s.liabilitiesNotRecorded ? 'Not recorded' : 'Not itemised'} />
              </DataTd>
            </Totalled>
          </tbody>
        </DataTable>
      </Block>
      <NetWorthLine label={`${s.header.subtitle} net value`} value={s.net} currency={c} testId="entity-net" />
      {s.notItemisedNote ? (
        <p className="mt-2 rounded border border-gray-300 bg-gray-50 px-2 py-1 text-xs text-gray-800" data-testid="not-itemised-note">
          {s.notItemisedNote}
          {s.enteredAs.length > 0 ? ` Entered as: ${s.enteredAs.join(', ')}.` : ''}
        </p>
      ) : null}
      {s.shownNotCounted.length > 0 ? (
        <section aria-labelledby={`${id}-notcounted`} className="nws-notincluded mt-2" data-testid="shown-not-counted">
          <h3 id={`${id}-notcounted`} className="text-xs font-semibold text-ink">
            Shown but not counted
          </h3>
          <ul className="list-disc space-y-0.5 pl-5 text-xs text-gray-700">
            {s.shownNotCounted.map((l) => (
              <li key={l.id}>
                {l.name}: {l.amount === null ? NOT_PROVIDED_LABEL : money(l.amount, c)}. A separate fund-level row already carries the fund, so counting this record as well would count the fund twice.
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <Block title="What this adds to the family total" id={`${id}-family`}>
        <DataTable label={`${s.header.subtitle} contribution to the family total`} className="nws-table">
          <caption className="sr-only">How this entity enters the family net worth.</caption>
          <tbody>
            <tr className="border-t border-gray-100">
              <DataTh scope="row" className="font-normal text-left">
                Net value of the {s.entityKind === 'smsf' ? 'fund' : 'entity'} (100%)
              </DataTh>
              <DataTd kind="num">
                <MaybeAmount value={s.net} currency={c} fallback={NOT_PROVIDED_LABEL} />
              </DataTd>
            </tr>
            <tr className="border-t border-gray-100">
              <DataTh scope="row" className="font-normal text-left">
                {s.basis === 'ownership_share' ? 'Your ownership share' : 'Share counted'}
              </DataTh>
              <DataTd kind="num" data-testid="entity-percent">
                {s.includedPercent}%
              </DataTd>
            </tr>
            <Totalled>
              <DataTh scope="row" className="text-left">
                Amount included in the family total
              </DataTh>
              <DataTd kind="num" data-testid="entity-contribution">
                <MaybeAmount value={s.contribution} currency={c} fallback={NOT_PROVIDED_LABEL} />
              </DataTd>
            </Totalled>
          </tbody>
        </DataTable>
        <p className="mt-1 text-xs text-gray-700">{s.contributionText}</p>
      </Block>
      <NotIncludedTable lines={s.notIncluded} currency={c} />
      <Notes notes={s.notes} fxNote={null} explanation={[s.levelExplanation]} />
      <Disclaimer />
    </article>
  );
}

export function FamilyStatementPage({ s }: { s: FamilyStatement }) {
  const c = s.header.currency;
  const id = 'nws-family';
  const d = s.dashboard;
  return (
    <article className="nws-statement" aria-labelledby={id} data-statement="family">
      <StatementHead header={s.header} id={id} />
      <Block title="How the family net worth is made up" id="nws-family-levels">
        <DataTable label="Family net worth by level" className="nws-table">
          <caption className="sr-only">Personal level plus each entity, line by line, equals the family net worth. Amounts in {c}.</caption>
          <thead>
            <tr className="bg-gray-100 text-left">
              <DataTh>Level</DataTh>
              <DataTh>Counted</DataTh>
              <DataTh kind="num">Assets</DataTh>
              <DataTh kind="num">Liabilities</DataTh>
              <DataTh kind="num">Net worth</DataTh>
            </tr>
          </thead>
          <tbody>
            {s.levels.map((r) => (
              <tr key={r.key} className="border-t border-gray-100" data-testid={`level-${r.key}`}>
                <DataTh scope="row" className="font-normal text-left">
                  {r.label}
                </DataTh>
                <DataTd>{r.basisText}</DataTd>
                <DataTd kind="num">
                  <MaybeAmount value={r.netOnly ? null : r.assets} currency={c} />
                </DataTd>
                <DataTd kind="num">
                  <MaybeAmount value={r.netOnly ? null : r.liabilities} currency={c} />
                </DataTd>
                <DataTd kind="num" data-testid={`level-${r.key}-net`}>
                  <MaybeAmount value={r.net} currency={c} fallback={NOT_PROVIDED_LABEL} />
                </DataTd>
              </tr>
            ))}
            <Totalled>
              <DataTh scope="row" colSpan={2} className="text-left">
                Family net worth
              </DataTh>
              <DataTd kind="num">{money(s.totals.assets, c)}</DataTd>
              <DataTd kind="num">{money(s.totals.liabilities, c)}</DataTd>
              <DataTd kind="num" data-testid="family-net">
                {money(s.totals.net, c)}
              </DataTd>
            </Totalled>
          </tbody>
        </DataTable>
        <p className="mt-1 text-xs text-gray-700" data-testid="family-equation">
          {s.contributions.map((x, i) => `${i === 0 ? '' : ' + '}${x.label} ${x.net === null ? NOT_PROVIDED_LABEL : money(x.net, c)}`).join('')} = {money(s.contributionSum, c)}
        </p>
      </Block>
      <Block title="Personal level in detail" id="nws-family-personal">
        <DataTable label="Personal level by group" className="nws-table">
          <caption className="sr-only">Personal assets by group and personal liabilities, amounts in {c}.</caption>
          <thead>
            <tr className="bg-gray-100 text-left">
              <DataTh>Group</DataTh>
              <DataTh kind="num">Amount ({c})</DataTh>
            </tr>
          </thead>
          <tbody>
            {s.personalGroups.map((g) => (
              <tr key={g.key} className="border-t border-gray-100">
                <DataTh scope="row" className="font-normal text-left">
                  {g.label}
                </DataTh>
                <DataTd kind="num">{money(g.subtotal, c)}</DataTd>
              </tr>
            ))}
            <tr className="border-t border-gray-200 font-medium">
              <DataTh scope="row" className="text-left font-medium">
                Liabilities
              </DataTh>
              <DataTd kind="num">{money(s.personalLiabilities, c)}</DataTd>
            </tr>
          </tbody>
        </DataTable>
      </Block>
      <Block title="Reconciliation to the Dashboard" id="nws-family-dashboard">
        <DataTable label="Reconciliation to the Dashboard" className="nws-table">
          <caption className="sr-only">The figures on this statement against the Dashboard figures, amounts in {c}.</caption>
          <thead>
            <tr className="bg-gray-100 text-left">
              <DataTh>Figure</DataTh>
              <DataTh kind="num">Dashboard</DataTh>
              <DataTh kind="num">This statement</DataTh>
              <DataTh kind="status">Result</DataTh>
            </tr>
          </thead>
          <tbody>
            {d.headline ? (
              <tr className="border-t border-gray-100">
                <DataTh scope="row" className="font-normal text-left">
                  {d.headline.label}
                </DataTh>
                <DataTd kind="num">{money(d.headline.value, c)}</DataTd>
                <DataTd kind="num">{money(d.personalNet, c)}</DataTd>
                <DataTd kind="status" data-testid="recon-headline">
                  {d.headlineMatches ? 'Agrees' : 'Differs'}
                </DataTd>
              </tr>
            ) : null}
            <tr className="border-t border-gray-100">
              <DataTh scope="row" className="font-normal text-left">
                Family level
              </DataTh>
              <DataTd kind="num">{money(d.familyNet, c)}</DataTd>
              <DataTd kind="num">{money(s.totals.net, c)}</DataTd>
              <DataTd kind="status" data-testid="recon-family">
                {d.familyNet === s.totals.net ? 'Agrees' : 'Differs'}
              </DataTd>
            </tr>
            {d.previouslyReported !== null ? (
              <tr className="border-t border-gray-100">
                <DataTh scope="row" className="font-normal text-left">
                  Previously reported net worth
                </DataTh>
                <DataTd kind="num">{money(d.previouslyReported, c)}</DataTd>
                <DataTd kind="num">{money(s.totals.net + d.bridgeLines.reduce((a, b) => a + b.amount, 0), c)}</DataTd>
                <DataTd kind="status" data-testid="recon-previous">
                  {d.bridgeOk === false ? 'Differs' : d.bridgeLines.length > 0 ? 'Explained below' : 'Agrees'}
                </DataTd>
              </tr>
            ) : null}
          </tbody>
        </DataTable>
        {d.bridgeLines.length > 0 ? (
          <ul className="mt-1 list-disc pl-5 text-xs text-gray-700">
            {d.bridgeLines.map((l, i) => (
              <li key={i}>
                {l.label}: {l.amount >= 0 ? '+' : '-'}
                {money(Math.abs(l.amount), c)}
              </li>
            ))}
          </ul>
        ) : null}
        <p className="mt-1 text-xs text-gray-700">{d.text}</p>
      </Block>
      <NotIncludedTable lines={s.notIncluded} currency={c} />
      <Notes notes={s.notes} fxNote={s.fxNote} explanation={[s.levelExplanation]} />
      <Disclaimer />
    </article>
  );
}

export function StatementPage({ s }: { s: AnyStatement }) {
  if (s.kind === 'personal') return <PersonalStatementPage s={s} />;
  if (s.kind === 'entity') return <EntityStatementPage s={s} />;
  return <FamilyStatementPage s={s} />;
}

export function NetWorthStatementView({ statements, parityMessages }: { statements: AnyStatement[]; parityMessages?: string[] }) {
  return (
    <div className="nws-root space-y-8" data-testid="nws-root">
      {parityMessages && parityMessages.length > 0 ? (
        <div role="alert" className="no-print rounded border border-risk bg-red-50 p-3 text-sm text-risk" data-testid="nws-parity-warning">
          <p className="font-medium">This statement does not agree with the Dashboard model, so it should not be relied on until this is looked at.</p>
          <ul className="mt-1 list-disc pl-5">
            {parityMessages.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {statements.map((s) => (
        <StatementPage key={s.kind === 'entity' ? s.entityId : s.kind} s={s} />
      ))}
    </div>
  );
}

export { ENTITY_NOT_ITEMISED_NOTE };
