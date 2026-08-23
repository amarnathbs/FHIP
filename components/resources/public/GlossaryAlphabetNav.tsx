// Spec §41: "Provide A B C ... Z. Only enable letters containing terms
// where practical. Keyboard accessible. Do not make A–Z filtering depend
// entirely on client-side JavaScript." Rendered as plain anchor links to
// in-page letter-group ids (#letter-a etc.) — ordinary browser anchor
// navigation, works with JS disabled, and each link is a real focusable
// <a> (Tab-reachable, has visible :focus-visible via the same utility every
// other Resources interactive element uses).

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

export function GlossaryAlphabetNav({ availableLetters }: { availableLetters: Set<string> }) {
  return (
    <nav aria-label="Jump to letter" className="flex flex-wrap gap-1">
      {ALPHABET.map((letter) => {
        const enabled = availableLetters.has(letter);
        return enabled ? (
          <a
            key={letter}
            href={`#letter-${letter}`}
            className="flex h-8 w-8 items-center justify-center rounded-compact text-sm font-semibold text-trust hover:bg-trust/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-trust"
          >
            {letter}
          </a>
        ) : (
          <span key={letter} aria-hidden="true" className="flex h-8 w-8 items-center justify-center rounded-compact text-sm text-line">
            {letter}
          </span>
        );
      })}
    </nav>
  );
}
