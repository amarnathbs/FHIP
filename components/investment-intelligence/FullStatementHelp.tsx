'use client';

import { useCallback, useId, useState } from 'react';
import { InfoDialog } from '@/components/ui/InfoDialog';
import {
  EXTERNAL_LINK_NOTE,
  FULL_STATEMENT_DELIVERY,
  FULL_STATEMENT_HELP_INTRO,
  FULL_STATEMENT_HELP_TITLE,
  FULL_STATEMENT_PRIVACY,
  FULL_STATEMENT_STEPS,
  STATEMENT_PROVIDERS,
  isAllowedStatementLink,
} from '@/lib/investment-intelligence/statementRequestLinks';

// The (!) button beside the statement Upload button (PO decision 2026-10-03):
// explains in plain words how to ask CAMS or KFintech for a FULL since-inception
// statement, so purchase dates and the whole history are included.
//
// The content and the two provider links come from
// lib/investment-intelligence/statementRequestLinks.ts, the single place the PO
// corrects them. A link whose address fails the https + allowed-domain check is
// not rendered as a link at all (the provider is still named in text).
//
// Accessible: the trigger is a real <button> with aria-haspopup="dialog" and
// aria-expanded; the dialog (components/ui/InfoDialog.tsx) traps focus, closes
// on Escape, and hands focus back to this button.

/** The popup's body, exported so the exact markup the user sees can be tested. */
export function FullStatementHelpContent({ id }: { id?: string }) {
  return (
    <div id={id} className="space-y-3">
      <p>{FULL_STATEMENT_HELP_INTRO}</p>
      <p className="font-medium">On the CAMS or KFintech request form:</p>
      <ol className="list-decimal space-y-1 pl-5">
        {FULL_STATEMENT_STEPS.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <p>{FULL_STATEMENT_DELIVERY}</p>
      <p className="font-medium">{FULL_STATEMENT_PRIVACY}</p>
      <div>
        <p className="font-medium">Official request pages</p>
        <ul className="mt-1 space-y-1">
          {STATEMENT_PROVIDERS.map((p) => (
            <li key={p.key}>
              {isAllowedStatementLink(p.url) ? (
                <a href={p.url} target="_blank" rel="noopener noreferrer" className="text-primary underline">
                  {p.linkText}
                </a>
              ) : (
                <span>{p.name}</span>
              )}
              <span className="text-muted"> — {EXTERNAL_LINK_NOTE}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function FullStatementHelp() {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const dialogId = useId();

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        aria-label="How to get a full statement"
        title="How to get a full statement"
        className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-line text-sm font-semibold text-primary hover:bg-gray-50"
      >
        <span aria-hidden="true">!</span>
      </button>
      <InfoDialog open={open} title={FULL_STATEMENT_HELP_TITLE} onClose={close}>
        <FullStatementHelpContent id={dialogId} />
      </InfoDialog>
    </>
  );
}
