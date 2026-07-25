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
