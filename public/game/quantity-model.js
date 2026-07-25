const MIN_VALUE = 0;
const MAX_VALUE = 20;

function assertInteger(value, label) {
  if (!Number.isInteger(value)) {
    throw new TypeError(`${label} must be an integer; received ${String(value)}`);
  }
}
function assertAmount(amount) {
  assertInteger(amount, "amount");
  if (amount <= 0) {
    throw new RangeError(`amount must be greater than 0; received ${amount}`);
  }
}

function frozenSnapshot(total, ones, tens) {
  return Object.freeze({
    value: total,
    total,
    ones,
    tens,
  });
}

/**
 * A small domain model for representing a quantity with loose one-blocks and
 * bundles of ten. The quantity is always in the inclusive range 0..20.
 *
 * The constructor intentionally starts with loose one-blocks. This lets the
 * presentation layer demonstrate "ten ones become one ten" explicitly.
 */
export class QuantityModel {
  #total;
  #ones;
  #tens;
  #history = [];

  constructor(input = 0) {
    const value =
      typeof input === "object" && input !== null ? input.value : input;

    assertInteger(value, "value");
    if (value < MIN_VALUE || value > MAX_VALUE) {
      throw new RangeError(
        `value must be between ${MIN_VALUE} and ${MAX_VALUE}; received ${value}`,
      );
    }

    this.#total = value;
    this.#ones = value;
    this.#tens = 0;
    this.#assertInvariant();
  }

  get value() {
    return this.#total;
  }

  get total() {
    return this.#total;
  }

  get ones() {
    return this.#ones;
  }

  get tens() {
    return this.#tens;
  }

  get lastDelta() {
    return this.#history.at(-1) ?? null;
  }

  get history() {
    return Object.freeze([...this.#history]);
  }

  snapshot() {
    return frozenSnapshot(this.#total, this.#ones, this.#tens);
  }

  addOne(meta) {
    return this.add(1, meta);
  }

  removeOne(meta) {
    return this.remove(1, meta);
  }

  add(amount, meta) {
    assertAmount(amount);
    if (this.#total + amount > MAX_VALUE) {
      throw new RangeError(
        `cannot add ${amount}: quantity would exceed ${MAX_VALUE}`,
      );
    }

    return this.#change("add", amount, meta, () => {
      this.#total += amount;
      this.#ones += amount;
    });
  }

  remove(amount, meta) {
    assertAmount(amount);
    if (amount > this.#total) {
      throw new RangeError(
        `cannot remove ${amount}: only ${this.#total} available`,
      );
    }

    return this.#change("remove", amount, meta, () => {
      // Expand only as many ten-bundles as are needed to perform the removal.
      if (this.#ones < amount) {
        const bundlesNeeded = Math.ceil((amount - this.#ones) / 10);
        this.#tens -= bundlesNeeded;
        this.#ones += bundlesNeeded * 10;
      }
      this.#ones -= amount;
      this.#total -= amount;
    });
  }

  combineTen(meta) {
    if (this.#ones < 10) {
      throw new RangeError(
        `cannot combine ten: only ${this.#ones} loose one-blocks available`,
      );
    }

    return this.#change("combineTen", 10, meta, () => {
      this.#ones -= 10;
      this.#tens += 1;
    });
  }

  expandTen(meta) {
    if (this.#tens < 1) {
      throw new RangeError("cannot expand ten: no ten-bundle available");
    }

    return this.#change("expandTen", 10, meta, () => {
      this.#tens -= 1;
      this.#ones += 10;
    });
  }

  #change(operation, amount, meta, mutate) {
    const before = this.snapshot();
    mutate();
    this.#assertInvariant();
    const after = this.snapshot();
    const delta = Object.freeze({
      before,
      after,
      amount,
      operation,
      ...(meta === undefined ? {} : { meta }),
    });
    this.#history.push(delta);
    return delta;
  }

  #assertInvariant() {
    if (
      !Number.isInteger(this.#total) ||
      !Number.isInteger(this.#ones) ||
      !Number.isInteger(this.#tens) ||
      this.#total < MIN_VALUE ||
      this.#total > MAX_VALUE ||
      this.#ones < 0 ||
      this.#tens < 0 ||
      this.#total !== this.#ones + 10 * this.#tens
    ) {
      throw new Error("QuantityModel invariant violated");
    }
  }
}
