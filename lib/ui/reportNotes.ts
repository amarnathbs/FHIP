// Small customer-facing sentences used by the Monthly Report renderer. Pure, so they can be tested without React.

/** "Not available — reason." with exactly one closing full stop, whether or not the reason already ends in one. */
export function unavailableSentence(text: string | null): string {
  const reason = (text ?? '').trim().replace(/[.\s]+$/, '');
  return `Not available${reason ? ` — ${reason}` : ''}.`;
}

/** Shown inside an included Portfolio X-Ray chapter when the look-through sector breakdown has no data. */
export const XRAY_NO_DATA_NOTE = 'No X-Ray data: look-through sector information is not available for your holdings yet, so no breakdown is shown.';
