import assert from "node:assert/strict";
import { test } from "node:test";
import { AudioManager } from "../../public/game/audio-manager.js";
import { GameStorage } from "../../public/game/storage.js";

function memoryLocalStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key)
  };
}

function controllableSpeech() {
  class FakeUtterance {
    constructor(text) {
      this.text = text;
    }
  }

  const spoken = [];
  let current = null;
  const synthesis = {
    cancelCalls: 0,
    speak(utterance) {
      current = utterance;
      spoken.push(utterance);
    },
    cancel() {
      this.cancelCalls += 1;
      // Some browsers do not dispatch an event for a canceled utterance.
      current = null;
    },
    finish() {
      const utterance = current;
      current = null;
      utterance?.onend?.({ type: "end" });
    },
    fail() {
      const utterance = current;
      current = null;
      utterance?.onerror?.({ type: "error", error: "synthesis-failed" });
    }
  };
  return { FakeUtterance, synthesis, spoken };
}

function fakeAudioEnvironment() {
  const state = { starts: 0 };
  class FakeAudioContext {
    constructor() {
      this.sampleRate = 1000;
      this.state = "running";
      this.destination = {};
    }

    createGain() {
      return { gain: { value: 1 }, connect() {} };
    }

    createBuffer(channels, length) {
      const samples = new Float32Array(length);
      return {
        length,
        getChannelData() {
          return samples;
        }
      };
    }

    createBufferSource() {
      return {
        buffer: null,
        connect() {},
        start() {
          state.starts += 1;
        }
      };
    }
  }
  return {
    environment: {
      localStorage: memoryLocalStorage(),
      AudioContext: FakeAudioContext,
      performance: { now: () => 100 }
    },
    state
  };
}

test("GameStorage falls back to localStorage for snapshots and outbox events", async () => {
  const localStorage = memoryLocalStorage();
  const storage = new GameStorage({ localStorage });
  await storage.saveSnapshot({ level: 2 });
  assert.deepEqual(await storage.loadSnapshot(), { level: 2 });

  await storage.appendEvent({
    eventId: "local-1",
    deviceId: "device-local",
    clientSeq: 1,
    eventType: "TASK_COMPLETED"
  });
  assert.deepEqual(
    (await storage.listEvents()).map((event) => event.eventId),
    ["local-1"]
  );
  assert.deepEqual(
    (await storage.listPendingEvents()).map((event) => event.eventId),
    ["local-1"]
  );

  await storage.markEventsSynced(["local-1"]);
  assert.deepEqual(await storage.listPendingEvents(), []);
});

test("AudioManager degrades safely without AudioContext or speechSynthesis", async () => {
  const manager = new AudioManager({ localStorage: memoryLocalStorage() });
  assert.equal(await manager.unlock(), false);
  assert.equal(manager.playEffect("ui.tap"), false);
  assert.equal(manager.speakNumber(8), false);
  assert.equal(await manager.speakAndWait("八"), false);
  assert.equal(manager.readNumber(8), false);
  assert.equal(manager.readTask({ current: 5, target: 8 }), false);
  assert.equal(manager.setTrackEnabled("music", false), true);
  assert.equal(manager.getSettings().music.enabled, false);
  assert.deepEqual(manager.setSettings({
    voice: { enabled: false, volume: 0.4 },
    effect: false,
    music: { enabled: true, volume: 2 }
  }), {
    voice: { enabled: false, volume: 0.4 },
    effect: { enabled: false, volume: 0.75 },
    music: { enabled: true, volume: 1 }
  });
});

test("speakAndWait resolves on completion, errors, and replacement cancellation", async () => {
  const fake = controllableSpeech();
  const manager = new AudioManager({
    localStorage: memoryLocalStorage(),
    speechSynthesis: fake.synthesis,
    SpeechSynthesisUtterance: fake.FakeUtterance
  });

  const first = manager.speakAndWait("第一句");
  const second = manager.speakAndWait("第二句", { rate: 0.9, pitch: 1 });
  assert.equal(await first, false);
  assert.equal(fake.spoken[1].text, "第二句");
  assert.equal(fake.spoken[1].lang, "zh-CN");
  assert.equal(fake.spoken[1].rate, 0.9);

  fake.synthesis.finish();
  assert.equal(await second, true);

  const failed = manager.speakAndWait("失败语音");
  fake.synthesis.fail();
  assert.equal(await failed, false);

  const disabled = manager.speakAndWait("关闭前");
  manager.setTrackEnabled("voice", false);
  assert.equal(await disabled, false);
  assert.equal(await manager.speakAndWait("不会播放"), false);
  assert.equal(fake.spoken.length, 4);
  assert.ok(fake.synthesis.cancelCalls >= 4);
});

test("block.drop is a short soft transient that can play twice", () => {
  const fake = fakeAudioEnvironment();
  const manager = new AudioManager(fake.environment);

  assert.equal(manager.playEffect("block.drop"), true);
  assert.equal(manager.playEffect("block.drop"), true);
  assert.equal(fake.state.starts, 2);

  const buffer = manager.buffers.get("block.drop");
  const samples = buffer.getChannelData(0);
  const peak = samples.reduce((maximum, sample) =>
    Math.max(maximum, Math.abs(sample)), 0);
  assert.ok(buffer.length <= 90, "drop sound should stay below 90 ms");
  assert.ok(peak * 2 < 0.3, "two overlapping drops should retain safe headroom");
});
