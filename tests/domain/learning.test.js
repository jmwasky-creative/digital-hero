import { describe, expect, it } from 'vitest';
import {
  LEARNING_CONSTANTS,
  PRESENTATION_TYPES,
  SKILLS,
  adjustDifficulty,
  calculateMastery,
  calculateReward,
  createQuestion,
  evaluateAnswer,
  toPublicQuestion,
} from '../../src/domain/learning.js';

function seededRandom(seed = 1) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const additions = new Set([
  SKILLS.ADDITION_WITHIN_10,
  SKILLS.ADDITION_WITHIN_20_NO_CARRY,
  SKILLS.ADDITION_WITHIN_20_CARRY,
]);

describe('question generation', () => {
  it('generates legal, answerable questions across every skill, tier, and presentation', () => {
    for (const skill of Object.values(SKILLS)) {
      for (const tier of [1, 2, 3]) {
        for (const presentationType of Object.values(PRESENTATION_TYPES)) {
          const random = seededRandom(tier + skill.length + presentationType.length);
          for (let index = 0; index < 100; index += 1) {
            const question = createQuestion({ skill, tier, presentationType, random });
            const { left, right } = question.operands;
            expect(left).toBeGreaterThanOrEqual(0);
            expect(right).toBeGreaterThanOrEqual(0);
            expect(question.answer).toBeGreaterThanOrEqual(0);
            expect(question.answer).toBeLessThanOrEqual(20);
            expect(new Set(question.options.map((option) => option.value)).size).toBe(3);
            expect(question.options.map((option) => option.value)).toContain(question.answer);
            if (additions.has(skill)) expect(left + right).toBe(question.answer);
            if (skill.startsWith('subtraction')) expect(left - right).toBe(question.answer);
          }
        }
      }
    }
  });

  it('enforces carry and borrow skill constraints', () => {
    for (let tier = 1; tier <= 3; tier += 1) {
      for (let index = 0; index < 100; index += 1) {
        const carry = createQuestion({ skill: SKILLS.ADDITION_WITHIN_20_CARRY, tier, random: seededRandom(index + 5) });
        expect((carry.operands.left % 10) + (carry.operands.right % 10)).toBeGreaterThanOrEqual(10);
        const noCarry = createQuestion({ skill: SKILLS.ADDITION_WITHIN_20_NO_CARRY, tier, random: seededRandom(index + 50) });
        expect((noCarry.operands.left % 10) + (noCarry.operands.right % 10)).toBeLessThan(10);
        const borrow = createQuestion({ skill: SKILLS.SUBTRACTION_WITHIN_20_BORROW, tier, random: seededRandom(index + 100) });
        expect(borrow.operands.left % 10).toBeLessThan(borrow.operands.right % 10);
      }
    }
  });

  it('skips excluded signatures even when the random source repeats', () => {
    const random = () => 0;
    const first = createQuestion({ skill: SKILLS.ADDITION_WITHIN_10, tier: 3, random });
    const second = createQuestion({ skill: SKILLS.ADDITION_WITHIN_10, tier: 3, random, excludedSignatures: [first.signature] });
    expect(second.signature).not.toBe(first.signature);
  });

  it('does not expose answers through public questions and evaluates option IDs', () => {
    const question = createQuestion({ skill: SKILLS.ADDITION_WITHIN_10, tier: 2, random: seededRandom() });
    const publicQuestion = toPublicQuestion(question);
    expect(publicQuestion).not.toHaveProperty('answer');
    expect(publicQuestion).not.toHaveProperty('correctOptionId');
    expect(publicQuestion).not.toHaveProperty('signature');
    expect(evaluateAnswer(question, question.correctOptionId)).toMatchObject({ isCorrect: true, validOption: true });
    expect(evaluateAnswer(question, 'not-an-option')).toEqual({ isCorrect: false, validOption: false });
  });
});

describe('rewards, mastery, and adaptive difficulty', () => {
  it('uses the frozen reward schedule', () => {
    expect(calculateReward()).toEqual({ experience: 0, coins: 0 });
    expect(calculateReward({ isCorrect: true })).toEqual({ experience: 10, coins: 5 });
    expect(calculateReward({ completedRun: true })).toEqual({ experience: 20, coins: 10 });
    expect(calculateReward({ isCorrect: true, completedRun: true })).toEqual({ experience: 30, coins: 15 });
  });

  it('keeps a tier with fewer than ten first answers', () => {
    expect(adjustDifficulty({ currentTier: 2, attempts: Array.from({ length: 9 }, () => ({ isCorrect: true, usedHint: false, responseTimeSeconds: 1 })) })).toMatchObject({ tier: 2, reason: 'insufficient_data' });
  });

  it('moves one tier for strong, weak, hint-heavy, and consecutive-error evidence', () => {
    const strong = Array.from({ length: 10 }, () => ({ isCorrect: true, usedHint: false, responseTimeSeconds: 10 }));
    expect(adjustDifficulty({ currentTier: 2, attempts: strong })).toMatchObject({ tier: 3, change: 1 });
    const weak = Array.from({ length: 10 }, (_, index) => ({ isCorrect: index % 2 === 0, usedHint: false, responseTimeSeconds: 10 }));
    expect(adjustDifficulty({ currentTier: 2, attempts: weak })).toMatchObject({ tier: 1, reason: 'low_accuracy' });
    const hintHeavy = Array.from({ length: 10 }, () => ({ isCorrect: true, usedHint: true, responseTimeSeconds: 10 }));
    expect(adjustDifficulty({ currentTier: 2, attempts: hintHeavy })).toMatchObject({ tier: 1, reason: 'high_hint_rate' });
    const lastThreeWrong = [...strong.slice(0, 7), ...Array.from({ length: 3 }, () => ({ isCorrect: false, usedHint: false, responseTimeSeconds: 10 }))];
    expect(adjustDifficulty({ currentTier: 2, attempts: lastThreeWrong })).toMatchObject({ tier: 1, reason: 'three_consecutive_incorrect' });
  });

  it('clamps difficulty and uses a median response time', () => {
    const fast = Array.from({ length: 10 }, (_, index) => ({ isCorrect: true, usedHint: false, responseTimeSeconds: index === 9 ? 100 : 10 }));
    expect(adjustDifficulty({ currentTier: 3, attempts: fast, expectedSeconds: 12 })).toMatchObject({ tier: 3, change: 0 });
    expect(LEARNING_CONSTANTS.EXPECTED_SECONDS_BY_TIER[1]).toBe(12);
  });

  it('returns smoothed mastery and makes assisted answers weaker evidence', () => {
    expect(calculateMastery([])).toEqual({ score: 50, sampleSize: 0, isReady: false });
    const independent = calculateMastery(Array.from({ length: 5 }, () => ({ isCorrect: true })));
    const assisted = calculateMastery(Array.from({ length: 5 }, () => ({ isCorrect: true, assisted: true })));
    expect(independent.isReady).toBe(true);
    expect(independent.score).toBeGreaterThan(assisted.score);
    expect(calculateMastery(Array.from({ length: 30 }, () => ({ isCorrect: false }))).sampleSize).toBe(20);
  });
});
