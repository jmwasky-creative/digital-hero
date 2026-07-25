import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createGameServer } from "../../server.js";

let fixtureDir;
let publicDir;
let dataFile;
let server;
let origin;

function listen(testServer) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      testServer.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      testServer.off("error", onError);
      resolve();
    };
    testServer.once("error", onError);
    testServer.once("listening", onListening);
    testServer.listen(0, "127.0.0.1");
  });
}

function rawRequest(path, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port: server.address().port,
      method: options.method || "GET",
      path,
      headers: options.headers
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        text: Buffer.concat(chunks).toString("utf8")
      }));
    });
    request.on("error", reject);
    if (options.body) request.end(options.body);
    else request.end();
  });
}

before(async () => {
  fixtureDir = mkdtempSync(join(tmpdir(), "chick-number-blocks-"));
  publicDir = join(fixtureDir, "public");
  dataFile = join(fixtureDir, "data", "events.json");
  mkdirSync(join(publicDir, "game"), { recursive: true });
  writeFileSync(join(publicDir, "index.html"), "<h1>小鸡数字积木新家</h1>");
  writeFileSync(join(publicDir, "game", "demo.js"), "export const ready = true;");
  writeFileSync(join(fixtureDir, "secret.txt"), "never public");
  server = createGameServer({ publicDir, dataFile });
  await listen(server);
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  rmSync(fixtureDir, { recursive: true, force: true });
});

test("health, bootstrap and static game modules are available", async () => {
  const health = await fetch(`${origin}/health/live`).then((response) => response.json());
  assert.equal(health.status, "ok");

  const bootstrapResponse = await fetch(`${origin}/api/v1/bootstrap`);
  assert.equal(bootstrapResponse.status, 200);
  const bootstrap = await bootstrapResponse.json();
  assert.equal(bootstrap.apiVersion, "v1");
  assert.equal(bootstrap.rulesetVersion, "1.0.0");
  assert.equal(bootstrap.snapshot.eventCount, 0);
  assert.equal(bootstrap.settings.voice.enabled, true);

  const index = await fetch(`${origin}/`);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /小鸡数字积木新家/);

  const module = await fetch(`${origin}/game/demo.js`);
  assert.equal(module.status, 200);
  assert.match(module.headers.get("content-type"), /javascript/);
});

test("static path resolution cannot escape public directory", async () => {
  const traversal = await rawRequest("/%2e%2e%2fsecret.txt");
  assert.equal(traversal.status, 403);
  assert.doesNotMatch(traversal.text, /never public/);

  const missing = await rawRequest("/secret.txt");
  assert.equal(missing.status, 404);
});

test("event sync accepts a batch and is idempotent by eventId and clientSeq", async () => {
  const event = {
    eventId: "event-1",
    profileId: "profile-1",
    deviceId: "device-1",
    clientSeq: 7,
    eventType: "SESSION_STARTED",
    schemaVersion: 1,
    rulesetVersion: "1.0.0",
    occurredAt: Date.now(),
    payload: {}
  };

  const firstResponse = await fetch(`${origin}/api/v1/sync/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events: [event] })
  });
  assert.equal(firstResponse.status, 200);
  const first = await firstResponse.json();
  assert.deepEqual(first.acceptedEventIds, ["event-1"]);
  assert.equal(first.acceptedThroughSeq, 7);
  assert.equal(first.acceptedThroughSeqByDevice["device-1"], 7);
  assert.equal(first.eventCount, 1);

  const duplicateResponse = await fetch(`${origin}/api/v1/sync/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      events: [
        event,
        { ...event, eventId: "event-same-sequence" }
      ]
    })
  });
  assert.equal(duplicateResponse.status, 200);
  const duplicate = await duplicateResponse.json();
  assert.equal(duplicate.accepted.length, 0);
  assert.equal(duplicate.duplicates.length, 2);
  assert.equal(duplicate.acceptedThroughSeq, 7);
  assert.equal(duplicate.eventCount, 1);

  const gapResponse = await fetch(`${origin}/api/v1/sync/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      events: [{ ...event, eventId: "event-2", clientSeq: 9 }]
    })
  });
  assert.equal(gapResponse.status, 409);
  const gap = await gapResponse.json();
  assert.equal(gap.error, "SYNC_SEQUENCE_GAP");
  assert.equal(gap.expectedClientSeq, 8);
});

test("event sync rejects missing event arrays and malformed JSON", async () => {
  const missingEvents = await fetch(`${origin}/api/v1/sync/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events: "not-an-array" })
  });
  assert.equal(missingEvents.status, 400);
  assert.equal((await missingEvents.json()).error, "INVALID_BATCH");

  const nullPayload = await fetch(`${origin}/api/v1/sync/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "null"
  });
  assert.equal(nullPayload.status, 400);
  assert.equal((await nullPayload.json()).error, "INVALID_BATCH");

  const malformed = await rawRequest("/api/v1/sync/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{"
  });
  assert.equal(malformed.status, 400);
  assert.equal(JSON.parse(malformed.text).error, "INVALID_REQUEST");
});

test("accepted events survive a server restart", async () => {
  assert.match(readFileSync(dataFile, "utf8"), /event-1/);
  await new Promise((resolve) => server.close(resolve));
  server = createGameServer({ publicDir, dataFile });
  await listen(server);
  origin = `http://127.0.0.1:${server.address().port}`;

  const bootstrap = await fetch(`${origin}/api/v1/bootstrap`).then((response) => response.json());
  assert.equal(bootstrap.snapshot.eventCount, 1);
  assert.equal(bootstrap.snapshot.lastClientSeqByDevice["device-1"], 7);
});
