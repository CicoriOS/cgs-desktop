// This browser's copy of conversations, per device (IndexedDB is per origin; the record belongs to a device and a session file).
// A saved conversation shows at once when it is opened again, and the history the device sends replaces it. Only the most
// recent sessions are kept, and forgetting a device (its key changed or was revoked) forgets what was read from it.
import type { CachedSession, HistoryCache } from "../core/history";

const DB_NAME = "cgs-connect-history";
const STORE = "sessions";
/** Sessions kept across all devices of this origin; the least recently saved go first. */
export const KEPT_SESSIONS = 20;

interface Row extends CachedSession {
  /** `<device>\n<session path>` */
  id: string;
  device: string;
  at: number;
}

export interface DeviceHistory extends HistoryCache {
  /** Drops every conversation kept for this device. */
  clear(): Promise<void>;
}

function done<T>(request: IDBRequest<T>): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
  return promise;
}

function finished(tx: IDBTransaction): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  tx.oncomplete = () => resolve();
  tx.onerror = tx.onabort = () => reject(tx.error);
  return promise;
}

/** Primary keys of an index in cursor order, without reading the (large) rows. */
async function keys(index: IDBIndex, range: IDBValidKey | IDBKeyRange | null, direction: IDBCursorDirection): Promise<IDBValidKey[]> {
  const out: IDBValidKey[] = [];
  const request = index.openKeyCursor(range, direction);
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  request.onerror = () => reject(request.error);
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return resolve();
    out.push(cursor.primaryKey);
    cursor.continue();
  };
  await promise;
  return out;
}

export function deviceHistory(idb: IDBFactory, device: string, now: () => number = Date.now): DeviceHistory {
  let db: Promise<IDBDatabase> | undefined;
  const open = () => {
    db ??= (() => {
      const request = idb.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("device", "device");
        store.createIndex("at", "at");
      };
      return done(request);
    })();
    return db;
  };
  const idOf = (path: string) => `${device}\n${path}`;
  return {
    async load(path) {
      const row = (await done((await open()).transaction(STORE, "readonly").objectStore(STORE).get(idOf(path)))) as Row | undefined;
      return row ? { turns: row.turns, tools: row.tools, title: row.title } : undefined;
    },
    async save(path, session) {
      const tx = (await open()).transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const row: Row = { id: idOf(path), device, at: now(), turns: session.turns, tools: session.tools, title: session.title };
      store.put(row);
      for (const id of (await keys(store.index("at"), null, "prev")).slice(KEPT_SESSIONS)) store.delete(id);
      await finished(tx);
    },
    async clear() {
      const tx = (await open()).transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      for (const id of await keys(store.index("device"), device, "next")) store.delete(id);
      await finished(tx);
    },
  };
}
