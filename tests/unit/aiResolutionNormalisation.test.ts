// Module 11.2 — question normalisation unit tests (spec sections 9, 84-85, 99).
import { describe, it, expect } from 'vitest';
import { normaliseQuestion } from '@/lib/ai/resolution/normalisation';

describe('normaliseQuestion', () => {
  it('collapses trivially different phrasings to the same normalised text (spec section 83)', () => {
    const a = normaliseQuestion("What's my net worth?");
    const b = normaliseQuestion('What is my net worth');
    const c = normaliseQuestion('Can you tell me my current net worth?');
    expect(a.text).toContain('net worth');
    expect(b.text).toContain('net worth');
    expect(c.text).toContain('net worth');
    // c's framing-stripping should leave it identical in substance to b.
    expect(c.text).toBe('my current net worth');
  });

  it('strips harmless conversational framing but not meaning-bearing words', () => {
    const r = normaliseQuestion('Could you please tell me my monthly surplus?');
    expect(r.text).toBe('my monthly surplus');
  });

  it('preserves negation (spec section 84)', () => {
    const withDebt = normaliseQuestion('Do I have debt?');
    const withoutDebt = normaliseQuestion('Do I have no debt?');
    expect(withDebt.hasNegation).toBe(false);
    expect(withoutDebt.hasNegation).toBe(true);
  });

  it('detects a why-question distinctly from its factual counterpart (spec section 84)', () => {
    const onTrack = normaliseQuestion('Is my goal on track?');
    const notOnTrack = normaliseQuestion('Why is my goal not on track?');
    expect(onTrack.isWhyQuestion).toBe(false);
    expect(notOnTrack.isWhyQuestion).toBe(true);
    expect(notOnTrack.hasNegation).toBe(true);
  });

  it('preserves numbers and dates rather than discarding them (spec section 85)', () => {
    const r = normaliseQuestion('What was my score in July? What happens at age 65?');
    expect(r.numbers.some((n) => n === '65')).toBe(true);
    expect(r.dateTokens.some((d) => /july/i.test(d))).toBe(true);
  });

  it('flags hypothetical/scenario framing without collapsing it into a factual intent (spec section 86)', () => {
    const r = normaliseQuestion('What happens if I retire at 60?');
    expect(r.isHypothetical).toBe(true);
  });

  it('does not flag an ordinary factual question as hypothetical', () => {
    const r = normaliseQuestion('What is my retirement balance?');
    expect(r.isHypothetical).toBe(false);
  });

  it('applies FHIP synonym normalisation', () => {
    const r = normaliseQuestion('How much money do I have?');
    expect(r.text).toContain('net worth');
  });

  it('collapses repeated whitespace and trailing punctuation', () => {
    const r = normaliseQuestion('What   is my   net worth??  ');
    expect(r.text).toBe('what is my net worth');
  });
});
