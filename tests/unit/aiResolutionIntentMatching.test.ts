// Module 11.2 — free-text intent matching unit tests (spec sections 47, 83, 86).
import { describe, it, expect } from 'vitest';
import { normaliseQuestion } from '@/lib/ai/resolution/normalisation';
import { matchIntent } from '@/lib/ai/resolution/intentMatcher';

function match(question: string) {
  return matchIntent(normaliseQuestion(question));
}

describe('matchIntent', () => {
  it('matches synonymous phrasings of the same deterministic question to the same intent (spec section 83)', () => {
    expect(match('What is my net worth?')?.intentCode).toBe('CURRENT_NET_WORTH');
    expect(match('How much is my net worth?')?.intentCode).toBe('CURRENT_NET_WORTH');
    expect(match('Tell me my current net worth.')?.intentCode).toBe('CURRENT_NET_WORTH');
  });

  it('does NOT map a why-phrased question to its factual counterpart (spec section 83 negative example)', () => {
    const r = match('Why is my net worth low?');
    expect(r?.intentCode).not.toBe('CURRENT_NET_WORTH');
  });

  it('routes a why-question about the score to SCORE_EXPLANATION, not FINANCIAL_HEALTH_SCORE', () => {
    expect(match('Why is my score only 58?')?.intentCode).toBe('SCORE_EXPLANATION');
  });

  it('classifies a hypothetical question as SCENARIO_REQUEST even when it names a real metric', () => {
    expect(match('What happens if I retire at 60?')?.intentCode).toBe('SCENARIO_REQUEST');
    expect(match('What if I save an extra $500 a month?')?.intentCode).toBe('SCENARIO_REQUEST');
  });

  it('does not guess on an unmatched free-text question (spec section 47)', () => {
    expect(match('Tell me something interesting about pineapples.')).toBeNull();
  });

  it('matches knowledge-base definition questions', () => {
    expect(match('What is net worth?')?.intentCode).toBe('NET_WORTH_DEFINITION');
    expect(match('What is superannuation?')?.intentCode).toBe('SUPERANNUATION_DEFINITION');
    expect(match('What is NPS?')?.intentCode).toBe('NPS_DEFINITION');
  });

  it('matches goal-count deterministic questions', () => {
    expect(match('How many goals do I have?')?.intentCode).toBe('GOAL_COUNT');
    expect(match('Which goals are on track?')?.intentCode).toBe('GOALS_ON_TRACK_COUNT');
  });

  // Collision guard (spec section 34): a generic definition question must
  // never accidentally resolve to a PERSONALISED deterministic intent —
  // that would answer the wrong question with someone else's data question
  // shape. This test is itself proven non-vacuous by aiResolutionNormalisation
  // having already caught (and this suite having caught) two real
  // collisions during development: CURRENT_NET_WORTH/"net worth", and
  // SAVINGS_RATE/"savings rate", both fixed by requiring "my" in the
  // deterministic pattern.
  it('never resolves a bare, non-personalised definition question to a personalised deterministic intent', () => {
    const definitionQuestions = [
      'What is net worth?',
      'What is a savings rate?',
      'What does reporting currency mean?',
      'What is superannuation?',
      'What is NPS?',
      'What is an emergency fund?',
    ];
    for (const q of definitionQuestions) {
      const result = match(q);
      expect(result, `"${q}" should not match a personalised intent`).not.toBeNull();
      expect(result!.intentCode.endsWith('_DEFINITION')).toBe(true);
    }
  });
});
