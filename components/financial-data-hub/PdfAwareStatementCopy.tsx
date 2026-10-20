/**
 * The words and the file chooser of the Liability, Retirement and Australian-investment statement import screens, in the one
 * place that knows both states of that class's PDF-route switch (lib/financial-data-hub/pdf-statements/flags.ts).
 *
 *   switch OFF (the default, and what a panel assumes until the server has said otherwise): CSV only -- the wording the screens
 *     had before the PDF routes release, and a file chooser that does not offer a PDF;
 *   switch ON: "PDF or CSV", and a chooser that offers both.
 *
 * Presentation only. The `pdfRouteEnabled` boolean comes from the signed-in upload-status read (see uiVisibility.ts), never from
 * an environment variable in the client bundle; the upload route stays authoritative and refuses a PDF while its switch is off.
 */
import type { ChangeEventHandler } from 'react';
import { statementFileAccept, statementFileLabel } from '@/lib/financial-data-hub/pdf-statements/uiVisibility';

type Common = { pdfRouteEnabled: boolean };

export function LiabilityUploadIntro({ pdfRouteEnabled, isCreditCard }: Common & { isCreditCard: boolean }) {
  const kind = isCreditCard ? 'credit card' : 'loan';
  if (!pdfRouteEnabled) {
    return (
      <p className="text-sm text-muted">
        Upload your {kind} statement (CSV) and FHIP will extract the details for you to
        review before updating your Liabilities.
      </p>
    );
  }
  return (
    <p className="text-sm text-muted">
      Upload your {kind} statement (PDF or CSV) and FHIP will extract the details for you to
      review before updating your Liabilities. A PDF is read for its own balances and lines; the original file is deleted
      as soon as the details are saved.
    </p>
  );
}

export function LiabilityStatementFileField({ pdfRouteEnabled, onChange }: Common & { onChange: ChangeEventHandler<HTMLInputElement> }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-muted">{statementFileLabel(pdfRouteEnabled)}</span>
      <input type="file" accept={statementFileAccept('liability', pdfRouteEnabled)} className="block w-full text-sm" onChange={onChange} />
    </label>
  );
}

export function AuInvestmentUploadIntro({ pdfRouteEnabled }: Common) {
  if (!pdfRouteEnabled) {
    return (
      <>
        <p className="text-sm text-muted">
          Upload a transaction-history or portfolio-holdings CSV and FHIP will extract the details for you to review before
          anything is added to your Investments.
        </p>
        <p className="text-xs text-muted">
          FHIP currently reads two generic Australian CSV layouts (a transaction-history export and a portfolio/holdings
          export with standard column headers). Broker-specific exports or PDF statements outside these layouts are not
          yet supported — you can still add the investment manually below instead.
        </p>
      </>
    );
  }
  return (
    <>
      <p className="text-sm text-muted">
        Upload a transaction-history or portfolio-holdings statement (PDF or CSV) and FHIP will extract the details for you to
        review before anything is added to your Investments. A PDF is deleted as soon as its details are saved.
      </p>
      <p className="text-xs text-muted">
        FHIP reads two generic Australian CSV layouts (a transaction-history export and a portfolio/holdings export with
        standard column headers) and the matching PDF statements. A statement in another layout is read by AI for you to
        check before anything is saved, and you can always add the investment manually below instead.
      </p>
    </>
  );
}

export function AuInvestmentStatementFileField({ pdfRouteEnabled, onChange }: Common & { onChange: ChangeEventHandler<HTMLInputElement> }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-muted">{statementFileLabel(pdfRouteEnabled)}</span>
      <input type="file" accept={statementFileAccept('au_investment', pdfRouteEnabled)} className="block w-full text-sm" onChange={onChange} />
    </label>
  );
}

export function RetirementStatementFileField({ pdfRouteEnabled, onChange }: Common & { onChange: ChangeEventHandler<HTMLInputElement> }) {
  return (
    <label className="flex flex-col text-sm">
      <span className="mb-1 font-medium">{statementFileLabel(pdfRouteEnabled)}</span>
      <input type="file" accept={statementFileAccept('retirement', pdfRouteEnabled)} onChange={onChange} className="text-sm" />
      {/* COVERAGE HONESTY (spec section 83). This states the ACTUAL
          certified scope. It does not say "all Australian super funds
          supported", because that is not true. */}
      <span className="mt-1 text-xs text-muted">
        {pdfRouteEnabled
          ? 'A PDF is read for the balances and movements it prints, and is deleted as soon as the details are saved. A statement in a layout we do not know is read by AI for you to check before anything is saved. Scanned or photographed documents and password-protected files cannot be read — you can still add or update the account manually.'
          : 'CSV exports only in this release. PDF statements and scanned documents cannot be read automatically yet — you can still add or update the account manually.'}
      </span>
    </label>
  );
}
