// What this browser keeps per device (ADR 0036 section 5). The wire library decides what is saved: the device's pinned
// static key and this browser's non-extractable ECDSA key. This module only gives it a place, scoped to the origin
// (IndexedDB is per origin) and to the device (the record key). The private key is stored as a CryptoKey by structured
// clone; nothing here ever exports it. Passwords are never stored.
import type { BrowserStore, SavedBrowser } from "@cgs/wire";

const DB_NAME = "cgs-connect";
const STORE = "devices";

export interface DeviceStore extends BrowserStore {
  /** Forgets the pin and the key: the next connection needs the password again (manual reset after a changed device). */
  clear(): Promise<void>;
}

function done<T>(request: IDBRequest<T>): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
  return promise;
}

async function open(idb: IDBFactory): Promise<IDBDatabase> {
  const request = idb.open(DB_NAME, 1);
  request.onupgradeneeded = () => request.result.createObjectStore(STORE);
  return done(request);
}

export function deviceStore(idb: IDBFactory, deviceId: string): DeviceStore {
  let db: Promise<IDBDatabase> | undefined;
  const run = async <T>(mode: IDBTransactionMode, act: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    db ??= open(idb);
    return done(act((await db).transaction(STORE, mode).objectStore(STORE)));
  };
  return {
    async load() {
      return ((await run("readonly", (s) => s.get(deviceId))) as SavedBrowser | undefined) ?? null;
    },
    async save(value) {
      await run("readwrite", (s) => s.put(value, deviceId));
    },
    async clear() {
      await run("readwrite", (s) => s.delete(deviceId));
    },
  };
}
