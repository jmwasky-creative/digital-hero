import { STORY_TEMPLATES } from '../../data/questions/story-templates.js';

/** Mathematical capabilities used by the curriculum and progress records. */
export const SKILLS = Object.freeze({
  NUMBER_BASICS: 'number_basics',
  ADDITION_WITHIN_10: 'addition_within_10',
  ADDITION_WITHIN_20_NO_CARRY: 'addition_within_20_no_carry',
  ADDITION_WITHIN_20_CARRY: 'addition_within_20_carry',
  SUBTRACTION_WITHIN_10: 'subtraction_within_10',
  SUBTRACTION_WITHIN_20_NO_BORROW: 'subtraction_within_20_no_borrow',
  SUBTRACTION_WITHIN_20_BORROW: 'subtraction_within_20_borrow',
});

export const PRESENTATION_TYPES = Object.freeze({
  SYMBOLIC: 'symbolic',
  VISUAL: 'visual',
  STORY: 'story',
});

const skillValues = new Set(Object.values(SKILLS));
const presentationValues = new Set(Object.values(PRESENTATION_TYPES));
const EXPECTED_SECONDS_BY_TIER = Object.freeze({ 1: 12, 2: 16, 3: 20 });

function assertTier(tier) {
  if (!Number.isInteger(tier) || tier < 1 || tier > 3) {
    throw new RangeError('tier must be an integer from 1 to 3');
  }
}

function assertRandom(random) {
  if (typeof random !== 'function') throw new TypeError('random must be a function');
}

function nextRandom(random) {
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new RangeError('random must return a finite number in [0, 1)');
  }
  return value;
}

function randomIndex(length, random) {
  return Math.floor(nextRandom(random) * length);
}

function isNoCarryAddition(left, right) {
  return (left % 10) + (right % 10) < 10;
}

function isNoBorrowSubtraction(left, right) {
  return (left % 10) >= (right % 10);
}

function candidatesFor(skill, tier) {
  const candidates = [];
  const add = (left, right, operation = 'addition') => candidates.push({ left, right, answer: left + right, operation });
  const subtract = (left, right) => candidates.push({ left, right, answer: left - right, operation: 'subtraction' });

  if (skill === SKILLS.NUMBER_BASICS) {
    const max = [8, 14, 19][tier - 1];
    for (let value = 0; value <= max; value += 1) {
      candidates.push({ left: value, right: 1, answer: value + 1, operation: 'successor' });
    }
  } else if (skill === SKILLS.ADDITION_WITHIN_10) {
    const max = [5, 8, 10][tier - 1];
    for (let left = 0; left <= max; left += 1) {
      for (let right = 0; right <= max; right += 1) if (left + right <= max) add(left, right);
    }
  } else if (skill === SKILLS.ADDITION_WITHIN_20_NO_CARRY) {
    const max = [10, 15, 20][tier - 1];
    for (let left = 0; left <= max; left += 1) {
      for (let right = 0; right <= max - left; right += 1) {
        if (isNoCarryAddition(left, right)) add(left, right);
      }
    }
  } else if (skill === SKILLS.ADDITION_WITHIN_20_CARRY) {
    const max = [12, 16, 20][tier - 1];
    for (let left = 0; left <= max; left += 1) {
      for (let right = 0; right <= max - left; right += 1) {
        if (!isNoCarryAddition(left, right)) add(left, right);
      }
    }
  } else if (skill === SKILLS.SUBTRACTION_WITHIN_10) {
    const max = [5, 8, 10][tier - 1];
    for (let left = 0; left <= max; left += 1) {
      for (let right = 0; right <= left; right += 1) subtract(left, right);
    }
  } else if (skill === SKILLS.SUBTRACTION_WITHIN_20_NO_BORROW) {
    const max = [10, 15, 20][tier - 1];
    for (let left = 0; left <= max; left += 1) {
      for (let right = 0; right <= left; right += 1) {
        if (isNoBorrowSubtraction(left, right)) subtract(left, right);
      }
    }
  } else if (skill === SKILLS.SUBTRACTION_WITHIN_20_BORROW) {
    const max = [12, 16, 20][tier - 1];
    for (let left = 0; left <= max; left += 1) {
      for (let right = 1; right <= left; right += 1) {
        if (!isNoBorrowSubtraction(left, right)) subtract(left, right);
      }
    }
  }
  return candidates;
}

function signatureOf({ skill, tier, operation, left, right }) {
  // Presentation changes how a problem is shown, not what is being practised.
  // Keeping it out of the signature prevents the same arithmetic problem from
  // being issued twice in a run with different wording.
  return [skill, tier, operation, left, right].join('|');
}

function optionValues(answer, random) {
  const values = new Set([answer]);
  const pool = Array.from({ length: 21 }, (_, value) => value).filter((value) => value !== answer);
  const start = randomIndex(pool.length, random);
  for (let offset = 0; values.size < 3; offset += 1) values.add(pool[(start + offset) % pool.length]);
  return [...values];
}

function shuffledOptions(answer, random) {
  const values = optionValues(answer, random);
  for (let index = values.length - 1; index > 0; index -= 1) {
    const otherIndex = randomIndex(index + 1, random);
    [values[index], values[otherIndex]] = [values[otherIndex], values[index]];
  }
  return values.map((value, index) => ({ id: `option-${index + 1}`, value }));
}

function promptFor(problem, presentationType, random) {
  const symbol = problem.operation === 'subtraction' ? '-' : '+';
  if (problem.operation === 'successor') {
    if (presentationType === PRESENTATION_TYPES.VISUAL) return `●`.repeat(problem.left) + ' 后面再放一个 ●，一共有几个？';
    if (presentationType === PRESENTATION_TYPES.STORY) return STORY_TEMPLATES.successor[randomIndex(STORY_TEMPLATES.successor.length, random)](problem);
    return `${problem.left} 后面的一个数字是？`;
  }
  if (presentationType === PRESENTATION_TYPES.VISUAL) {
    return `${'●'.repeat(problem.left)} ${symbol} ${'●'.repeat(problem.right)} = ?`;
  }
  if (presentationType === PRESENTATION_TYPES.STORY) {
    const templates = problem.operation === 'subtraction' ? STORY_TEMPLATES.subtraction : STORY_TEMPLATES.addition;
    return templates[randomIndex(templates.length, random)](problem);
  }
  return `${problem.left} ${symbol} ${problem.right} = ?`;
}

/**
 * Creates a private question. `excludedSignatures` can contain signatures from
 * the same run; generation then deterministically selects an unused problem.
 */
export function createQuestion({ skill, tier, presentationType = PRESENTATION_TYPES.SYMBOLIC, random = Math.random, excludedSignatures = [] }) {
  if (!skillValues.has(skill)) throw new RangeError('unknown skill');
  if (!presentationValues.has(presentationType)) throw new RangeError('unknown presentationType');
  assertTier(tier);
  assertRandom(random);

  const excluded = new Set(excludedSignatures);
  const candidates = candidatesFor(skill, tier);
  const start = randomIndex(candidates.length, random);
  let problem;
  for (let offset = 0; offset < candidates.length; offset += 1) {
    const possible = candidates[(start + offset) % candidates.length];
    const signature = signatureOf({ skill, tier, ...possible });
    if (!excluded.has(signature)) {
      problem = possible;
      break;
    }
  }
  if (!problem) throw new RangeError('no unique question remains for this skill and tier');

  const signature = signatureOf({ skill, tier, ...problem });
  const options = shuffledOptions(problem.answer, random);
  const correctOption = options.find((option) => option.value === problem.answer);
  return Object.freeze({
    id: `q-${signature.replaceAll('|', '-')}`,
    signature,
    skill,
    tier,
    presentationType,
    operation: problem.operation,
    operands: Object.freeze({ left: problem.left, right: problem.right }),
    prompt: promptFor(problem, presentationType, random),
    options: Object.freeze(options),
    answer: problem.answer,
    correctOptionId: correctOption.id,
  });
}

/** Removes answer-bearing fields before a question is sent to a client. */
export function toPublicQuestion(question) {
  const { answer, correctOptionId, signature, ...publicQuestion } = question;
  return publicQuestion;
}

export function evaluateAnswer(question, optionId) {
  if (!question?.correctOptionId || !Array.isArray(question.options)) throw new TypeError('a private question is required');
  const option = question.options.find((candidate) => candidate.id === optionId);
  if (!option) return Object.freeze({ isCorrect: false, validOption: false });
  return Object.freeze({
    isCorrect: option.id === question.correctOptionId,
    validOption: true,
    correctOptionId: question.correctOptionId,
    correctValue: question.answer,
  });
}

/** Rewards one correctly solved question and/or a completed five-question run. */
export function calculateReward({ isCorrect = false, completedRun = false } = {}) {
  return Object.freeze({
    experience: (isCorrect ? 10 : 0) + (completedRun ? 20 : 0),
    coins: (isCorrect ? 5 : 0) + (completedRun ? 10 : 0),
  });
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/**
 * Adjusts one tier at most. Attempts are first-answer records for one skill.
 * Fields: isCorrect, usedHint, responseTimeSeconds. The latest 20 are used.
 */
export function adjustDifficulty({ currentTier, attempts = [], expectedSeconds } = {}) {
  assertTier(currentTier);
  const recent = attempts.slice(-20);
  if (recent.length < 10) return Object.freeze({ tier: currentTier, change: 0, reason: 'insufficient_data' });
  const accuracy = recent.filter((attempt) => attempt.isCorrect).length / recent.length;
  const hintRate = recent.filter((attempt) => attempt.usedHint).length / recent.length;
  const responseTimes = recent.map((attempt) => attempt.responseTimeSeconds).filter((value) => Number.isFinite(value) && value >= 0);
  const expected = expectedSeconds ?? EXPECTED_SECONDS_BY_TIER[currentTier];
  if (!Number.isFinite(expected) || expected <= 0) throw new RangeError('expectedSeconds must be a positive number');
  const responseMedian = median(responseTimes);
  const lastThreeIncorrect = recent.length >= 3 && recent.slice(-3).every((attempt) => !attempt.isCorrect);
  const shouldIncrease = accuracy > 0.85 && hintRate <= 0.2 && responseMedian !== null && responseMedian <= expected * 1.25;
  const shouldDecrease = accuracy < 0.7 || hintRate > 0.4 || lastThreeIncorrect;
  if (shouldDecrease) return Object.freeze({ tier: Math.max(1, currentTier - 1), change: currentTier > 1 ? -1 : 0, reason: lastThreeIncorrect ? 'three_consecutive_incorrect' : accuracy < 0.7 ? 'low_accuracy' : 'high_hint_rate' });
  if (shouldIncrease) return Object.freeze({ tier: Math.min(3, currentTier + 1), change: currentTier < 3 ? 1 : 0, reason: 'strong_performance' });
  return Object.freeze({ tier: currentTier, change: 0, reason: 'maintain' });
}

/**
 * Returns a smoothed 0..100 mastery score from the latest 20 first attempts.
 * Hints and assisted completions contribute partial rather than full evidence.
 */
export function calculateMastery(attempts = []) {
  const recent = attempts.slice(-20);
  if (recent.length === 0) return Object.freeze({ score: 50, sampleSize: 0, isReady: false });
  const evidence = recent.reduce((total, attempt) => {
    if (!attempt.isCorrect) return total;
    if (attempt.assisted) return total + 0.25;
    if (attempt.usedHint) return total + 0.6;
    return total + 1;
  }, 0);
  // Beta(2,2) prior avoids treating a single answer as certain mastery.
  const score = Math.round(((evidence + 2) / (recent.length + 4)) * 100);
  return Object.freeze({ score, sampleSize: recent.length, isReady: recent.length >= 5 });
}

export const LEARNING_CONSTANTS = Object.freeze({ EXPECTED_SECONDS_BY_TIER });
