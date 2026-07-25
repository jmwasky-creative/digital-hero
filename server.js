import http from "node:http";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC_DIR = resolve(HERE, "public");
const DEFAULT_DATA_FILE = resolve(HERE, "data", "events.json");
const MAX_BODY_BYTES = 512 * 1024;

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".woff2": "font/woff2"
};

function sendJson(response, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...extraHeaders
  });
  response.end(body);
}

function secureHeaders() {
  return {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=()"
  };
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("Request body is too large");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Body must be valid JSON");
    error.status = 400;
    throw error;
  }
}

function isNonEmptyString(value, max = 160) {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function validateEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return "Each event must be an object";
  }
  if (!isNonEmptyString(event.eventId)) return "eventId is required";
  if (!isNonEmptyString(event.deviceId)) return "deviceId is required";
  if (!Number.isSafeInteger(event.clientSeq) || event.clientSeq < 1) {
    return "clientSeq must be a positive integer";
  }
  if (event.eventType !== undefined && !isNonEmptyString(event.eventType, 80)) {
    return "eventType must be a non-empty string";
  }
  if (event.profileId !== undefined && !isNonEmptyString(event.profileId)) {
    return "profileId must be a non-empty string";
  }
  if (event.occurredAt !== undefined &&
      !Number.isFinite(event.occurredAt) &&
      !isNonEmptyString(event.occurredAt, 80)) {
    return "occurredAt must be a number or non-empty string";
  }
  if (event.payload !== undefined && (event.payload === null || typeof event.payload !== "object")) {
    return "payload must be an object";
  }
  return null;
}

class EventStore {
  constructor(dataFile) {
    this.dataFile = dataFile;
    this.events = [];
    this.byId = new Map();
    this.byDeviceSeq = new Map();
    this.lastSeqByDevice = new Map();
    this.load();
  }

  load() {
    if (!this.dataFile) return;
    try {
      const parsed = JSON.parse(readFileSync(this.dataFile, "utf8"));
      const events = Array.isArray(parsed) ? parsed : parsed.events;
      if (Array.isArray(events)) {
        for (const event of events) this.index(event);
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.warn(`Ignoring unreadable event store: ${error.message}`);
      }
    }
  }

  deviceKey(event) {
    return `${event.deviceId}\u0000${event.clientSeq}`;
  }

  index(event) {
    if (validateEvent(event)) return;
    this.events.push(event);
    this.byId.set(event.eventId, event);
    this.byDeviceSeq.set(this.deviceKey(event), event);
    this.lastSeqByDevice.set(
      event.deviceId,
      Math.max(this.lastSeqByDevice.get(event.deviceId) || 0, event.clientSeq)
    );
  }

  persist() {
    if (!this.dataFile) return;
    mkdirSync(dirname(this.dataFile), { recursive: true });
    const temporaryFile = `${this.dataFile}.${process.pid}.tmp`;
    writeFileSync(
      temporaryFile,
      `${JSON.stringify({ version: 1, events: this.events }, null, 2)}\n`,
      { mode: 0o600 }
    );
    renameSync(temporaryFile, this.dataFile);
  }

  appendBatch(events) {
    const accepted = [];
    const duplicates = [];
    const stagedIds = new Map();
    const stagedDeviceSeq = new Map();
    const stagedLastSeq = new Map(this.lastSeqByDevice);

    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      const reason = validateEvent(event);
      if (reason) {
        return { error: { status: 400, code: "INVALID_EVENT", index, message: reason } };
      }

      const knownById = this.byId.get(event.eventId) || stagedIds.get(event.eventId);
      const key = this.deviceKey(event);
      const knownBySequence = this.byDeviceSeq.get(key) || stagedDeviceSeq.get(key);
      if (knownById || knownBySequence) {
        const original = knownById || knownBySequence;
        duplicates.push({
          eventId: event.eventId,
          clientSeq: event.clientSeq,
          originalEventId: original.eventId
        });
        continue;
      }

      const lastSeq = stagedLastSeq.get(event.deviceId) || 0;
      if (lastSeq > 0 && event.clientSeq !== lastSeq + 1) {
        return {
          error: {
            status: 409,
            code: "SYNC_SEQUENCE_GAP",
            deviceId: event.deviceId,
            expectedClientSeq: lastSeq + 1,
            receivedClientSeq: event.clientSeq
          }
        };
      }
      // An existing installation may begin syncing after playing offline, so its
      // first uploaded sequence is accepted as the baseline.
      stagedLastSeq.set(event.deviceId, event.clientSeq);
      stagedIds.set(event.eventId, event);
      stagedDeviceSeq.set(key, event);
      accepted.push(event);
    }

    for (const event of accepted) this.index(event);
    if (accepted.length > 0) this.persist();
    return { accepted, duplicates };
  }

  snapshot() {
    return {
      eventCount: this.events.length,
      lastClientSeqByDevice: Object.fromEntries(this.lastSeqByDevice)
    };
  }
}

function safePublicPath(publicDir, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const requested = decoded === "/" ? "/index.html" : decoded;
  const candidate = resolve(publicDir, `.${requested}`);
  const rel = relative(publicDir, candidate);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return candidate;
}

function serveStatic(request, response, publicDir, pathname) {
  const filePath = safePublicPath(publicDir, pathname);
  if (!filePath) {
    sendJson(response, 403, { error: "FORBIDDEN_PATH" }, secureHeaders());
    return;
  }

  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) throw Object.assign(new Error("Not a file"), { code: "ENOENT" });
    const body = readFileSync(filePath);
    response.writeHead(200, {
      ...secureHeaders(),
      "content-type": CONTENT_TYPES[extname(filePath).toLowerCase()] || "application/octet-stream",
      "content-length": body.length,
      "cache-control": pathname === "/sw.js" ? "no-cache" : "public, max-age=300"
    });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      sendJson(response, 404, { error: "NOT_FOUND" }, secureHeaders());
      return;
    }
    console.error(error);
    sendJson(response, 500, { error: "INTERNAL_ERROR" }, secureHeaders());
  }
}

export function createGameServer(options = {}) {
  const publicDir = resolve(options.publicDir || DEFAULT_PUBLIC_DIR);
  const store = options.store || new EventStore(
    options.dataFile === undefined ? DEFAULT_DATA_FILE : options.dataFile
  );

  const server = http.createServer(async (request, response) => {
    response.setHeader("connection", "close");
    let url;
    try {
      url = new URL(request.url, "http://localhost");
    } catch {
      sendJson(response, 400, { error: "BAD_REQUEST" }, secureHeaders());
      return;
    }

    if (request.method === "GET" && url.pathname === "/health/live") {
      sendJson(response, 200, { status: "ok", service: "chick-number-blocks" }, secureHeaders());
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/v1/bootstrap") {
      sendJson(response, 200, {
        apiVersion: "v1",
        rulesetVersion: "1.0.0",
        serverTime: Date.now(),
        snapshot: {
          chapter: 1,
          level: 1,
          task: 1,
          homeParts: [],
          ...store.snapshot()
        },
        settings: {
          voice: { enabled: true, volume: 1 },
          effect: { enabled: true, volume: 0.75 },
          music: { enabled: true, volume: 0.15 }
        },
        reportSummary: null
      }, secureHeaders());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/v1/sync/events") {
      try {
        const payload = await readJsonBody(request);
        const events = Array.isArray(payload) ? payload : payload?.events;
        if (!Array.isArray(events) || events.length > 500) {
          sendJson(response, 400, {
            error: "INVALID_BATCH",
            message: "events must be an array containing at most 500 items"
          }, secureHeaders());
          return;
        }
        const result = store.appendBatch(events);
        if (result.error) {
          const { status, ...body } = result.error;
          sendJson(response, status, { error: body.code, ...body }, secureHeaders());
          return;
        }
        const deviceIds = [...new Set(events.map((event) => event.deviceId))];
        const snapshot = store.snapshot();
        const acceptedThroughSeqByDevice = Object.fromEntries(
          deviceIds.map((deviceId) => [
            deviceId,
            snapshot.lastClientSeqByDevice[deviceId] || 0
          ])
        );
        sendJson(response, 200, {
          status: "ok",
          accepted: result.accepted.map(({ eventId, deviceId, clientSeq }) => ({
            eventId, deviceId, clientSeq
          })),
          duplicates: result.duplicates,
          acceptedEventIds: result.accepted.map((event) => event.eventId),
          duplicateEventIds: result.duplicates.map((event) => event.eventId),
          acceptedThroughSeq: deviceIds.length === 1
            ? acceptedThroughSeqByDevice[deviceIds[0]]
            : 0,
          acceptedThroughSeqByDevice,
          ...snapshot
        }, secureHeaders());
      } catch (error) {
        sendJson(response, error.status || 500, {
          error: error.status ? "INVALID_REQUEST" : "INTERNAL_ERROR",
          message: error.status ? error.message : "Unable to sync events"
        }, secureHeaders());
      }
      return;
    }

    if ((request.method === "GET" || request.method === "HEAD") &&
        !url.pathname.startsWith("/api/") &&
        url.pathname !== "/health/live") {
      serveStatic(request, response, publicDir, url.pathname);
      return;
    }

    sendJson(response, 404, { error: "NOT_FOUND" }, secureHeaders());
  });

  server.eventStore = store;
  return server;
}

const isMain = process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  const port = Number.parseInt(process.env.PORT || "3000", 10);
  const host = process.env.HOST || "127.0.0.1";
  const server = createGameServer();
  server.listen(port, host, () => {
    console.log(`小鸡数字积木新家 running at http://${host}:${port}`);
  });
}
