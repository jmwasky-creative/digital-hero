const DB_NAME = "chick-number-blocks";
const DB_VERSION = 1;
const SNAPSHOT_STORE = "snapshots";
const EVENT_STORE = "events";
const DEFAULT_SNAPSHOT_KEY = "current";
const LOCAL_PREFIX = "chick-number-blocks:";

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function compareEvents(left, right) {
  return (left.clientSeq || 0) - (right.clientSeq || 0) ||
    (left.occurredAt || 0) - (right.occurredAt || 0) ||
    String(left.eventId || "").localeCompare(String(right.eventId || ""));
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
  });
}

export class GameStorage {
  constructor(environment = globalThis) {
    this.environment = environment;
    this.dbPromise = null;
  }

  async openDatabase() {
    if (!this.environment.indexedDB) throw new Error("IndexedDB is unavailable");
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const request = this.environment.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) {
          db.createObjectStore(SNAPSHOT_STORE);
        }
        if (!db.objectStoreNames.contains(EVENT_STORE)) {
          const events = db.createObjectStore(EVENT_STORE, { keyPath: "eventId" });
          events.createIndex("clientSeq", "clientSeq", { unique: false });
          events.createIndex("syncState", "syncState", { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        this.dbPromise = null;
        reject(request.error || new Error("Unable to open IndexedDB"));
      };
      request.onblocked = () => reject(new Error("IndexedDB upgrade is blocked"));
    });
    return this.dbPromise;
  }

  get localStorage() {
    try {
      const storage = this.environment.localStorage;
      const probe = `${LOCAL_PREFIX}probe`;
      storage.setItem(probe, "1");
      storage.removeItem(probe);
      return storage;
    } catch {
      return null;
    }
  }

  async loadSnapshot(key = DEFAULT_SNAPSHOT_KEY) {
    try {
      const db = await this.openDatabase();
      const transaction = db.transaction(SNAPSHOT_STORE, "readonly");
      return clone(await requestResult(transaction.objectStore(SNAPSHOT_STORE).get(key))) ?? null;
    } catch {
      const raw = this.localStorage?.getItem(`${LOCAL_PREFIX}snapshot:${key}`);
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    }
  }

  async saveSnapshot(snapshot, key = DEFAULT_SNAPSHOT_KEY) {
    const safeSnapshot = clone(snapshot);
    try {
      const db = await this.openDatabase();
      const transaction = db.transaction(SNAPSHOT_STORE, "readwrite");
      await requestResult(transaction.objectStore(SNAPSHOT_STORE).put(safeSnapshot, key));
      return safeSnapshot;
    } catch {
      const storage = this.localStorage;
      if (!storage) return safeSnapshot;
      storage.setItem(`${LOCAL_PREFIX}snapshot:${key}`, JSON.stringify(safeSnapshot));
      return safeSnapshot;
    }
  }

  async appendEvent(event, snapshot = undefined, snapshotKey = DEFAULT_SNAPSHOT_KEY) {
    const safeEvent = {
      ...clone(event),
      eventId: event?.eventId || this.environment.crypto?.randomUUID?.() ||
        `evt-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      syncState: event?.syncState || "pending"
    };
    try {
      const db = await this.openDatabase();
      const stores = snapshot === undefined
        ? [EVENT_STORE]
        : [EVENT_STORE, SNAPSHOT_STORE];
      const transaction = db.transaction(stores, "readwrite");
      transaction.objectStore(EVENT_STORE).put(safeEvent);
      if (snapshot !== undefined) {
        transaction.objectStore(SNAPSHOT_STORE).put(clone(snapshot), snapshotKey);
      }
      await new Promise((resolve, reject) => {
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error || new Error("Transaction failed"));
        transaction.onabort = () => reject(transaction.error || new Error("Transaction aborted"));
      });
      return safeEvent;
    } catch {
      const storage = this.localStorage;
      if (!storage) return safeEvent;
      const key = `${LOCAL_PREFIX}events`;
      let events = [];
      try {
        events = JSON.parse(storage.getItem(key) || "[]");
        if (!Array.isArray(events)) events = [];
      } catch {
        events = [];
      }
      const existingIndex = events.findIndex((item) => item.eventId === safeEvent.eventId);
      if (existingIndex >= 0) events[existingIndex] = safeEvent;
      else events.push(safeEvent);
      storage.setItem(key, JSON.stringify(events));
      if (snapshot !== undefined) await this.saveSnapshot(snapshot, snapshotKey);
      return safeEvent;
    }
  }

  async listEvents(options = {}) {
    const normalized = typeof options === "number" ? { limit: options } : (options || {});
    const limit = Number.isSafeInteger(normalized.limit) && normalized.limit >= 0
      ? normalized.limit
      : Number.POSITIVE_INFINITY;
    const syncState = normalized.syncState;
    let events;

    try {
      const db = await this.openDatabase();
      const transaction = db.transaction(EVENT_STORE, "readonly");
      events = await requestResult(transaction.objectStore(EVENT_STORE).getAll());
    } catch {
      const raw = this.localStorage?.getItem(`${LOCAL_PREFIX}events`);
      try {
        events = JSON.parse(raw || "[]");
        if (!Array.isArray(events)) events = [];
      } catch {
        events = [];
      }
    }

    return events
      .filter((event) => syncState === undefined || event.syncState === syncState)
      .sort(compareEvents)
      .slice(0, limit)
      .map(clone);
  }

  async listPendingEvents(limit = 100) {
    const events = await this.listEvents();
    return events
      .filter((event) => event.syncState !== "synced")
      .slice(0, limit);
  }

  async markEventsSynced(eventIds) {
    const ids = new Set(eventIds);
    if (ids.size === 0) return;
    try {
      const db = await this.openDatabase();
      const transaction = db.transaction(EVENT_STORE, "readwrite");
      const store = transaction.objectStore(EVENT_STORE);
      await Promise.all([...ids].map(async (id) => {
        const event = await requestResult(store.get(id));
        if (event) store.put({ ...event, syncState: "synced", syncedAt: Date.now() });
      }));
      await new Promise((resolve, reject) => {
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
      });
    } catch {
      const storage = this.localStorage;
      if (!storage) return;
      const key = `${LOCAL_PREFIX}events`;
      try {
        const events = JSON.parse(storage.getItem(key) || "[]");
        storage.setItem(key, JSON.stringify(events.map((event) =>
          ids.has(event.eventId)
            ? { ...event, syncState: "synced", syncedAt: Date.now() }
            : event
        )));
      } catch {
        // Corrupt fallback data is treated as empty.
      }
    }
  }
}

export const gameStorage = new GameStorage();
export const loadSnapshot = (...args) => gameStorage.loadSnapshot(...args);
export const saveSnapshot = (...args) => gameStorage.saveSnapshot(...args);
export const appendEvent = (...args) => gameStorage.appendEvent(...args);
export const listEvents = (...args) => gameStorage.listEvents(...args);
export default gameStorage;
