/** The sentence shown after "Check the categories again" (pure, so a test can pin the wording). */

export interface RecheckTextInput {
  status: 'done' | 'nothing_to_check';
  needs_decision_before: number;
  needs_decision_after: number;
  guesses_withdrawn: number;
}

const lines = (n: number) => `${n} ${n === 1 ? 'transaction' : 'transactions'}`;

export function recheckResultText(r: RecheckTextInput): string {
  if (r.status === 'nothing_to_check') return 'Everything on this statement is already approved, so there is nothing to check.';
  const kept = ' Nothing was approved for you, and anything you approved or chose yourself was left as it was.';
  const withdrawn =
    r.guesses_withdrawn > 0
      ? ` ${lines(r.guesses_withdrawn)} had an earlier guess that our rules no longer support, so ${r.guesses_withdrawn === 1 ? 'it is' : 'they are'} back in the list for your choice.`
      : '';
  if (r.needs_decision_after < r.needs_decision_before) {
    return `Checked again. ${lines(r.needs_decision_before)} needed your choice before; now ${r.needs_decision_after} ${r.needs_decision_after === 1 ? 'does' : 'do'}.${withdrawn}${kept}`;
  }
  if (r.needs_decision_after > r.needs_decision_before) {
    return `Checked again. ${lines(r.needs_decision_after)} now need your choice (${r.needs_decision_before} before).${withdrawn}${kept}`;
  }
  return `Checked again. Nothing needed to change: ${lines(r.needs_decision_after)} still ${r.needs_decision_after === 1 ? 'needs' : 'need'} your choice.${withdrawn}${kept}`;
}
