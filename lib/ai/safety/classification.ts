// Module 11.0 — safety/advice-boundary classification (spec sections 30-31).
//
// Builds the classification CONTRACT and a first, deliberately conservative
// rule-based classifier. Full conversational routing is explicitly deferred
// (spec section 30) — this exists so 11.1 has a versioned policy layer to
// build on, and so ai_runs/ai_safety_events have something real to record
// even in Module 11.0's DEV-only preview surface.

import { violatesAdviceBoundary } from '@/lib/advice-boundary/check';
import type { SafetyClassification } from '@/lib/ai/structuredOutput';

export interface ClassificationResult {
  classification: SafetyClassification;
  flags: string[];
  blocked: boolean;
  blockReason: string | null;
}

// Advice future FHIP AI must never give (spec section 31), as detectable
// surface patterns. Real coverage will grow in 11.1; these are the
// unambiguous, high-confidence cases worth catching even in 11.0's
// non-conversational preview surface.
const PRODUCT_ADVICE_PATTERNS = [
  /\bwhich (etf|mutual fund|stock|share)\b.*\b(buy|should i)\b/i,
  /\bbest (super fund|mortgage|lender|insurance policy)\b/i,
  /\brecommend (a|an) (etf|fund|stock|lender|insurer)\b/i,
];
const TAX_ADVICE_PATTERNS = [/\bhow much tax (will|do) i (owe|pay)\b/i, /\btax deduction for my\b/i, /\bfile my (tax return|taxes)\b/i];
const LEGAL_ADVICE_PATTERNS = [/\bis it legal\b/i, /\bshould i sue\b/i, /\blegal advice\b/i];
const MONEY_MOVEMENT_PATTERNS = [/\btransfer \$?\d/i, /\bmove my money\b/i, /\bsell my (shares|fund|property)\b/i, /\bwithdraw \$?\d/i];
const DATA_WRITE_PATTERNS = [/\bupdate my (income|expense|asset|liability|goal)\b/i, /\bdelete my (account|data|goal)\b/i, /\bchange my (balance|value) to\b/i];

// Prompt-injection heuristics (spec sections 40, 51-B/C): retrieved content
// or a user note trying to redirect model behaviour. This is a heuristic
// safety net, not a substitute for the architectural separation between
// system instructions and data (see lib/ai/context — the context object
// never contains instruction-shaped text in the first place).
const PROMPT_INJECTION_PATTERNS = [
  /ignore\s+(all\s+|any\s+|previous\s+|prior\s+|the\s+)*(rules|instructions|prompts?)/i,
  /disregard\s+(your\s+|the\s+|all\s+|previous\s+)*(system|previous)?\s*(prompt|instructions)/i,
  /reveal\s+(the\s+)?(system prompt|api key|financial information of|other user)/i,
  /you are now/i,
  /act as (an? )?(unrestricted|jailbroken|dan)\b/i,
];

function matchesAny(patterns: RegExp[], text: string): boolean {
  return patterns.some((p) => p.test(text));
}

/**
 * Classifies a piece of user-authored or retrieved-content text. `source`
 * distinguishes a direct user question from retrieved/RAG content — a
 * prompt-injection pattern found inside RETRIEVED content is always flagged
 * regardless of classification, since that is exactly the attack spec
 * section 40 describes (an uploaded statement's text trying to change AI
 * behaviour).
 */
export function classifyRequest(text: string, source: 'user_question' | 'retrieved_content' = 'user_question'): ClassificationResult {
  const flags: string[] = [];

  if (matchesAny(PROMPT_INJECTION_PATTERNS, text)) {
    flags.push('prompt_injection_pattern_detected');
    return { classification: 'PROMPT_INJECTION_SUSPECTED', flags, blocked: true, blockReason: 'Text matched a known prompt-injection pattern and was treated as inert data, not instructions.' };
  }

  if (source === 'retrieved_content') {
    // Retrieved content is never itself a "request" to classify as advice —
    // it is data. It only ever reaches PROMPT_INJECTION_SUSPECTED (above) or
    // passes through untagged.
    return { classification: 'FHIP_EXPLANATION', flags, blocked: false, blockReason: null };
  }

  if (matchesAny(MONEY_MOVEMENT_PATTERNS, text)) {
    return { classification: 'MONEY_MOVEMENT', flags: ['money_movement_requested'], blocked: true, blockReason: 'FHIP AI cannot move money or execute financial transactions.' };
  }
  if (matchesAny(DATA_WRITE_PATTERNS, text)) {
    return { classification: 'DATA_WRITE', flags: ['data_write_requested'], blocked: true, blockReason: 'FHIP AI cannot write to canonical financial records in Module 11.0.' };
  }
  if (matchesAny(TAX_ADVICE_PATTERNS, text)) {
    return { classification: 'TAX_ADVICE', flags: ['tax_advice_requested'], blocked: true, blockReason: 'FHIP AI does not provide personalised tax advice.' };
  }
  if (matchesAny(LEGAL_ADVICE_PATTERNS, text)) {
    return { classification: 'LEGAL_ADVICE', flags: ['legal_advice_requested'], blocked: true, blockReason: 'FHIP AI does not provide personalised legal advice.' };
  }
  if (matchesAny(PRODUCT_ADVICE_PATTERNS, text) || violatesAdviceBoundary(text)) {
    return { classification: 'PRODUCT_ADVICE', flags: ['product_advice_requested'], blocked: true, blockReason: 'FHIP AI does not recommend specific financial products.' };
  }
  if (/\bwhat will .* be worth in \d+ years\b/i.test(text) || /\bguarantee(d)?\b/i.test(text)) {
    return { classification: 'UNSUPPORTED_PREDICTION', flags: ['unsupported_prediction_requested'], blocked: false, blockReason: null };
  }
  if (/\b(ssn|social security|passport number|bank account number|card number)\b/i.test(text)) {
    return { classification: 'PRIVACY_SENSITIVE', flags: ['privacy_sensitive_terms_detected'], blocked: true, blockReason: 'Request references sensitive identifiers that must never be sent to an AI provider.' };
  }
  if (/\bwhat if\b|\bscenario\b/i.test(text)) {
    return { classification: 'SCENARIO_REQUEST', flags, blocked: false, blockReason: null };
  }
  if (/\bmy (score|dashboard|net worth|resilience|dna|goal|forecast|twin|report)\b/i.test(text)) {
    return { classification: 'FHIP_EXPLANATION', flags, blocked: false, blockReason: null };
  }
  return { classification: 'GENERAL_EDUCATION', flags, blocked: false, blockReason: null };
}

/** Scans arbitrary retrieved/RAG text for injection attempts (spec section 40/52-C). */
export function scanForPromptInjection(text: string): { suspected: boolean; matchedPattern: string | null } {
  for (const p of PROMPT_INJECTION_PATTERNS) {
    if (p.test(text)) return { suspected: true, matchedPattern: p.source };
  }
  return { suspected: false, matchedPattern: null };
}
