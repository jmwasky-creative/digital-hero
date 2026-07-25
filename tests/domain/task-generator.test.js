import assert from "node:assert/strict";
import test from "node:test";

import {
  createSeededRandom,
  createTaskGenerator,
  createTechnicalSliceTask,
  generateArithmeticTask,
  taskFingerprint,
} from "../../public/game/task-generator.js";

test("technical slice has the fixed 5 + 3 = 8 contract", () => {
  assert.deepEqual(createTechnicalSliceTask(), {
    initialValue: 5,
    targetValue: 8,
    numberBlock: 3,
    dropCount: 2,
    restoreCount: 2,
    answerOptions: [5, 6, 7, 8],
  });
  assert.deepEqual(
    createTechnicalSliceTask("same-replay"),
    createTechnicalSliceTask("same-replay"),
  );
});

test("seeded PRNG and generated task are fixed-seed deterministic", () => {
  const firstRandom = createSeededRandom("fixed-seed");
  const replayRandom = createSeededRandom("fixed-seed");
  assert.deepEqual(
    [firstRandom(), firstRandom(), firstRandom()],
    [replayRandom(), replayRandom(), replayRandom()],
  );

  const first = generateArithmeticTask({ seed: "fixed-seed" });
  const replay = generateArithmeticTask({ seed: "fixed-seed" });
  assert.deepEqual(first, replay);
  assert.equal(first.fingerprint, taskFingerprint(first));
});

test("all sampled tasks remain in range and subtraction never goes negative", () => {
  for (let index = 0; index < 500; index += 1) {
    const task = generateArithmeticTask({ seed: `range-${index}` });
    assert.ok(task.initialValue >= 1 && task.initialValue <= 20);
    assert.ok(task.targetValue >= 0 && task.targetValue <= 20);
    assert.ok(task.amount > 0);
    assert.equal(
      task.targetValue,
      task.operation === "add"
        ? task.initialValue + task.amount
        : task.initialValue - task.amount,
    );
    assert.ok(task.answerOptions.includes(task.targetValue));
  }
});

test("recent fingerprints are excluded deterministically", () => {
  const original = generateArithmeticTask({ seed: "avoid-repeat" });
  const next = generateArithmeticTask({
    seed: "avoid-repeat",
    recentFingerprints: [original.fingerprint],
  });

  assert.notEqual(next.fingerprint, original.fingerprint);
  assert.deepEqual(
    next,
    generateArithmeticTask({
      seed: "avoid-repeat",
      recentFingerprints: [original.fingerprint],
    }),
  );
});

test("task streams are replayable from seed and resumable from snapshots", () => {
  const generator = createTaskGenerator({
    seed: "lesson-one",
    recentLimit: 4,
  });
  const firstTwo = [generator.next(), generator.next()];
  const checkpoint = generator.snapshot();
  const afterCheckpoint = [generator.next(), generator.next()];

  const replay = createTaskGenerator({
    seed: "lesson-one",
    recentLimit: 4,
  });
  assert.deepEqual([replay.next(), replay.next()], firstTwo);

  const resumed = createTaskGenerator(checkpoint);
  assert.deepEqual([resumed.next(), resumed.next()], afterCheckpoint);
  assert.equal(
    new Set([...firstTwo, ...afterCheckpoint].map((task) => task.fingerprint))
      .size,
    4,
  );
});
