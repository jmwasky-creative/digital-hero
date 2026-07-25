import assert from "node:assert/strict";
import test from "node:test";

import { QuantityModel } from "../../public/game/quantity-model.js";

function assertInvariant(model) {
  assert.equal(model.total, model.ones + 10 * model.tens);
  assert.ok(model.total >= 0 && model.total <= 20);
  assert.ok(model.ones >= 0);
  assert.ok(model.tens >= 0);
}

test("constructs from a number or value object and exposes read-only state", () => {
  const numeric = new QuantityModel(5);
  const object = new QuantityModel({ value: 8 });

  assert.deepEqual(numeric.snapshot(), {
    value: 5,
    total: 5,
    ones: 5,
    tens: 0,
  });
  assert.equal(object.value, 8);
  assert.throws(() => {
    numeric.value = 12;
  }, TypeError);
});

test("add/remove operations preserve the quantity invariant and return deltas", () => {
  const model = new QuantityModel({ value: 5 });
  const added = model.add(3, { source: "number-block" });

  assert.equal(added.operation, "add");
  assert.equal(added.amount, 3);
  assert.equal(added.before.value, 5);
  assert.equal(added.after.value, 8);
  assert.deepEqual(added.meta, { source: "number-block" });
  assert.equal(model.lastDelta, added);
  assertInvariant(model);

  const removed = model.removeOne();
  assert.equal(removed.operation, "remove");
  assert.equal(removed.after.value, 7);
  assertInvariant(model);
});

test("combines ten loose blocks and expands the ten without changing total", () => {
  const model = new QuantityModel(15);
  const combined = model.combineTen();

  assert.deepEqual(combined.before, {
    value: 15,
    total: 15,
    ones: 15,
    tens: 0,
  });
  assert.deepEqual(combined.after, {
    value: 15,
    total: 15,
    ones: 5,
    tens: 1,
  });
  assert.equal(combined.operation, "combineTen");
  assertInvariant(model);

  const expanded = model.expandTen();
  assert.equal(expanded.operation, "expandTen");
  assert.deepEqual(model.snapshot(), combined.before);
  assertInvariant(model);
});

test("removal automatically expands enough ten-bundles when needed", () => {
  const model = new QuantityModel(20);
  model.combineTen();
  model.combineTen();

  const delta = model.remove(13);
  assert.deepEqual(delta.before, {
    value: 20,
    total: 20,
    ones: 0,
    tens: 2,
  });
  assert.deepEqual(delta.after, {
    value: 7,
    total: 7,
    ones: 7,
    tens: 0,
  });
  assertInvariant(model);
});

test("rejects invalid values and impossible operations without mutating", () => {
  assert.throws(() => new QuantityModel(-1), /between 0 and 20/);
  assert.throws(() => new QuantityModel(21), /between 0 and 20/);
  assert.throws(() => new QuantityModel(1.5), /integer/);

  const model = new QuantityModel(5);
  const before = model.snapshot();
  assert.throws(() => model.add(16), /exceed 20/);
  assert.throws(() => model.remove(6), /only 5 available/);
  assert.throws(() => model.add(0), /greater than 0/);
  assert.throws(() => model.combineTen(), /only 5 loose/);
  assert.throws(() => model.expandTen(), /no ten-bundle/);
  assert.deepEqual(model.snapshot(), before);
  assert.equal(model.history.length, 0);
});
