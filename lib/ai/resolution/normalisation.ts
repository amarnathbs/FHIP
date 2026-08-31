// Module 11.2 — deterministic question normalisation (spec section 9).
//
// Purely textual/rule-based. No LLM, no embeddings. The goal is to make
// trivially-different phrasings of the SAME question hash/match identically,
// while never collapsing a NEGATED or WH-question ("why is my X low?") into
// its plain factual counterpart ("what is my X?") — that distinction is the
// whole reason DETERMINISTIC vs LIVE_AI_REQUIRED routing can be trusted.

export interface NormalisedQuestion {
  /** Cleaned text, still English prose — used for hashing/matching. */
  text: string;
  /** True if a negation token was found ANYWHERE in the original text (spec section 84). */
  hasNegation: boolean;
  /** True if the question contains a "why"/"how much tax"/causal-request shape. */
  isWhyQuestion: boolean;
  /** Numbers found in the original text, preserved verbatim (spec section 85). */
  numbers: string[];
  /** ISO-ish date/month/year tokens found in the original text (spec section 85). */
  dateTokens: string[];
  /** True if the text contains hypothetical/conditional framing (spec section 86). */
  isHypothetical: boolean;
}

// Conversational framing that carries no intent-distinguishing meaning and is
// safe to strip (spec section 9: "strip harmless conversational framing").
// Deliberately does NOT strip "why", "not", "no", or any negation/causal word.
const FRAMING_PREFIXES = [
  /^(can|could|would) you (please )?(tell me|show me|let me know)\s*/i,
  /^(please )?tell me\s*/i,
  /^i (would like|want) to know\s*/i,
  /^(hey|hi|hello)[,! ]*/i,
  /^(so|well|ok|okay)[,! ]*/i,
];

const NEGATION_TOKENS = /\b(no|not|none|never|don'?t|doesn'?t|didn'?t|isn'?t|aren'?t|wasn'?t|weren'?t|without|lack of|zero)\b/i;

const WHY_TOKENS = /\b(why|how come|what caused|what's causing|what is causing|reason for|reason my)\b/i;

const HYPOTHETICAL_TOKENS = /\b(what happens if|what if|if i (save|retire|pay|invest|move|increase|decrease|stop|start)|if rates|if the market|suppose i|hypothetically)\b/i;

const NUMBER_PATTERN = /[$₹]?-?\d[\d,]*(\.\d+)?%?/g;

// Deliberately conservative — month names and a handful of unambiguous date
// shapes. Does not attempt full date parsing.
const DATE_PATTERN =
  /\b(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{1,2}-\d{1,2}-\d{2,4}|jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(tember)?|oct(ober)?|nov(ember)?|dec(ember)?|age \d+|\d{4})\b/gi;

/** FHIP-specific synonym normalisation (spec section 9's "normalise common FHIP synonyms"). */
const SYNONYM_MAP: Array<[RegExp, string]> = [
  [/\bhow much (money )?do i have\b/i, 'what is my net worth'],
  [/\bhow much am i worth\b/i, 'what is my net worth'],
  [/\btake[- ]home pay\b/i, 'net income'],
  [/\bwhat i (bring home|earn)\b/i, 'net income'],
  [/\bsuper\b/i, 'superannuation'],
  [/\bhow much do i owe\b/i, 'total liabilities'],
  [/\bhow much i owe\b/i, 'total liabilities'],
  [/\brainy day fund\b/i, 'emergency fund'],
  [/\bhealth score\b/i, 'financial health score'],
];

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Unicode-normalise, case-fold, strip harmless framing/punctuation, collapse
 * whitespace, apply FHIP synonym substitution. Deliberately does NOT touch
 * negation, numbers, dates or hypothetical framing — those are extracted
 * separately, from the ORIGINAL text, before any stripping happens, so
 * normalisation can never silently discard meaning-bearing content.
 */
export function normaliseQuestion(raw: string): NormalisedQuestion {
  const original = raw.normalize('NFKC');

  const numbers = [...original.matchAll(NUMBER_PATTERN)].map((m) => m[0]);
  const dateTokens = [...original.matchAll(DATE_PATTERN)].map((m) => m[0]);
  const hasNegation = NEGATION_TOKENS.test(original);
  const isWhyQuestion = WHY_TOKENS.test(original);
  const isHypothetical = HYPOTHETICAL_TOKENS.test(original);

  let text = original.toLowerCase();
  for (const prefix of FRAMING_PREFIXES) text = text.replace(prefix, '');
  text = collapseWhitespace(text);
  text = text.replace(/[?!]+\s*$/g, '');
  text = text.replace(/[.,;:]+\s*$/g, '');
  text = collapseWhitespace(text);
  for (const [pattern, replacement] of SYNONYM_MAP) text = text.replace(pattern, replacement);
  text = collapseWhitespace(text);

  return { text, hasNegation, isWhyQuestion, numbers, dateTokens, isHypothetical };
}
