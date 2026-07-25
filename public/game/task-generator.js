const DEFAULT_SEED = "quantity-task";
const MIN_VALUE = 0;
const MAX_VALUE = 20;

function normalizeSeed(seed) {
  if (typeof seed !== "string" && typeof seed !== "number") {
    throw new TypeError("seed must be a string or finite number");
  }
  if (typeof seed === "number" && !Number.isFinite(seed)) {
    throw new TypeError("seed must be a string or finite number");
  }
  return String(seed);
}

function hashSeed(seed) {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Returns a deterministic PRNG producing values in [0, 1).
 */
export function createSeededRandom(seed = DEFAULT_SEED) {
  let state = hashSeed(normalizeSeed(seed));
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function buildTaskCandidates() {
  const candidates = [];

  for (let initialValue = 1; initialValue <= MAX_VALUE; initialValue += 1) {
    for (
      let amount = 1;
      initialValue + amount <= MAX_VALUE;
      amount += 1
    ) {
      candidates.push({
        initialValue,
        targetValue: initialValue + amount,
        amount,
        operation: "add",
        operator: "+",
      });
    }

    for (let amount = 1; amount <= initialValue; amount += 1) {
      candidates.push({
        initialValue,
        targetValue: initialValue - amount,
        amount,
        operation: "subtract",
        operator: "-",
      });
    }
  }

  return Object.freeze(candidates.map((candidate) => Object.freeze(candidate)));
}

const TASK_CANDIDATES = buildTaskCandidates();

export function taskFingerprint(task) {
  if (
    !task ||
    !["add", "subtract"].includes(task.operation) ||
    !Number.isInteger(task.initialValue) ||
    !Number.isInteger(task.amount) ||
    !Number.isInteger(task.targetValue)
  ) {
    throw new TypeError("task does not contain a valid arithmetic operation");
  }
  return [
    task.operation,
    task.initialValue,
    task.amount,
    task.targetValue,
  ].join(":");
}

function shuffledAnswerOptions(correctAnswer, random) {
  const answers = new Set([correctAnswer]);
  for (let distance = 1; answers.size < 4; distance += 1) {
    const candidates =
      random() < 0.5
        ? [correctAnswer - distance, correctAnswer + distance]
        : [correctAnswer + distance, correctAnswer - distance];
    for (const candidate of candidates) {
      if (candidate >= MIN_VALUE && candidate <= MAX_VALUE) {
        answers.add(candidate);
      }
      if (answers.size === 4) {
        break;
      }
    }
  }

  const result = [...answers];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return Object.freeze(result);
}

/**
 * Generates a deterministic addition/subtraction task within 0..20.
 *
 * `recentFingerprints` is filtered before selection, so a task cannot repeat
 * while any alternative remains. Passing the same options replays the same
 * task exactly.
 */
export function generateArithmeticTask(options = {}) {
  const normalizedOptions =
    typeof options === "string" || typeof options === "number"
      ? { seed: options }
      : options;

  if (!normalizedOptions || typeof normalizedOptions !== "object") {
    throw new TypeError("options must be an object, string, or number");
  }

  const seed = normalizeSeed(normalizedOptions.seed ?? DEFAULT_SEED);
  const recentFingerprints = normalizedOptions.recentFingerprints ?? [];
  if (
    !Array.isArray(recentFingerprints) &&
    !(recentFingerprints instanceof Set)
  ) {
    throw new TypeError("recentFingerprints must be an array or Set");
  }

  const recent = new Set(recentFingerprints);
  const available = TASK_CANDIDATES.filter(
    (candidate) => !recent.has(taskFingerprint(candidate)),
  );
  if (available.length === 0) {
    throw new RangeError("no non-repeating arithmetic tasks are available");
  }

  const random = createSeededRandom(seed);
  const selected = available[Math.floor(random() * available.length)];
  const fingerprint = taskFingerprint(selected);

  return Object.freeze({
    seed,
    initialValue: selected.initialValue,
    targetValue: selected.targetValue,
    amount: selected.amount,
    numberBlock: selected.amount,
    operation: selected.operation,
    operator: selected.operator,
    answerOptions: shuffledAnswerOptions(selected.targetValue, random),
    fingerprint,
  });
}

// Short alias for presentation code that does not need the longer domain name.
export const generateTask = generateArithmeticTask;

/**
 * Creates a reproducible task stream with a bounded recent-fingerprint window.
 * A snapshot can be passed back to this function to resume the same stream.
 */
export function createTaskGenerator(options = {}) {
  if (!options || typeof options !== "object") {
    throw new TypeError("options must be an object");
  }

  const seed = normalizeSeed(options.seed ?? DEFAULT_SEED);
  const recentLimit = options.recentLimit ?? 5;
  const cursor = options.cursor ?? 0;
  const initialRecent = options.recentFingerprints ?? [];

  if (!Number.isInteger(recentLimit) || recentLimit < 0) {
    throw new RangeError("recentLimit must be a non-negative integer");
  }
  if (!Number.isInteger(cursor) || cursor < 0) {
    throw new RangeError("cursor must be a non-negative integer");
  }
  if (!Array.isArray(initialRecent)) {
    throw new TypeError("recentFingerprints must be an array");
  }

  let currentCursor = cursor;
  let recent =
    recentLimit === 0 ? [] : initialRecent.slice(-recentLimit);

  return Object.freeze({
    next() {
      const task = generateArithmeticTask({
        seed: `${seed}:${currentCursor}`,
        recentFingerprints: recent,
      });
      currentCursor += 1;
      if (recentLimit > 0) {
        recent = [...recent, task.fingerprint].slice(-recentLimit);
      }
      return task;
    },

    snapshot() {
      return Object.freeze({
        seed,
        cursor: currentCursor,
        recentLimit,
        recentFingerprints: Object.freeze([...recent]),
      });
    },
  });
}

/**
 * The fixed first playable technical-validation slice.
 */
export function createTechnicalSliceTask(seed = "roof-5-8") {
  // Validate the replay key even though this deliberately fixed first slice
  // does not vary. Later slices can use the same seed contract.
  normalizeSeed(seed);
  return Object.freeze({
    initialValue: 5,
    targetValue: 8,
    numberBlock: 3,
    dropCount: 2,
    restoreCount: 2,
    answerOptions: Object.freeze([5, 6, 7, 8]),
  });
}
