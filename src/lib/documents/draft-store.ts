import { DRAFT_MAX_AGE_MS, parseDraft } from './form-state.ts'
import type { Draft } from './form-state.ts'
import type { FormDef } from './forms.ts'

/*
 * Where the draft of a document is kept on the phone while it is being filled in. IndexedDB, because photos do not fit in
 * localStorage; the draft includes them, since a phone often removes the browser tab from memory while the camera app is
 * open. Everything that can go wrong with storage (a full phone, a private window, no IndexedDB) is swallowed here: the form
 * keeps working without a draft, it only cannot restore one.
 *
 * The storage itself is a small interface, so the rules around it are unit-tested with a map in memory; the IndexedDB
 * version is exercised in the browser tests.
 */

export type StoredDraft = { key: string; savedAt: string; draft: Draft }

export interface DraftStorage {
  get(key: string): Promise<unknown>
  put(record: StoredDraft): Promise<void>
  remove(key: string): Promise<void>
  /** Removes every draft saved before this moment (ISO). */
  purgeBefore(cutoff: string): Promise<void>
}

export function memoryDraftStorage(): DraftStorage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  return {
    data,
    async get(key) {
      return data.get(key) ?? null
    },
    async put(record) {
      data.set(record.key, record)
    },
    async remove(key) {
      data.delete(key)
    },
    async purgeBefore(cutoff) {
      for (const [key, value] of data) if (String((value as StoredDraft | null)?.savedAt ?? '') < cutoff) data.delete(key)
    },
  }
}

const DB_NAME = 'dig-documents'
const STORE = 'drafts'

/** The drafts in IndexedDB, or null when the browser has none (or refuses it). */
export function indexedDbDraftStorage(factory: IDBFactory | undefined = globalThis.indexedDB): DraftStorage | null {
  if (!factory) return null
  let opened: Promise<IDBDatabase> | null = null
  const open = () =>
    (opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(DB_NAME, 1)
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(STORE, { keyPath: 'key' })
        store.createIndex('savedAt', 'savedAt')
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('IndexedDB kon niet worden geopend.'))
      request.onblocked = () => reject(new Error('IndexedDB is geblokkeerd.'))
    }).catch((error) => {
      opened = null
      throw error
    }))

  /** Runs one request in a transaction and waits until the transaction is really saved. */
  async function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
    const db = await open()
    return new Promise<T | undefined>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode)
      const request = work(transaction.objectStore(STORE))
      transaction.oncomplete = () => resolve(request ? request.result : undefined)
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB-fout.'))
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB is afgebroken (vol?).'))
    })
  }

  return {
    get: (key) => run('readonly', (store) => store.get(key)).then((value) => value ?? null),
    put: async (record) => {
      await run('readwrite', (store) => store.put(record))
    },
    remove: async (key) => {
      await run('readwrite', (store) => store.delete(key))
    },
    async purgeBefore(cutoff) {
      const db = await open()
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(STORE, 'readwrite')
        // A key cursor on the date: the drafts themselves (with photos) are not read.
        const cursor = transaction.objectStore(STORE).index('savedAt').openKeyCursor(IDBKeyRange.upperBound(cutoff, true))
        cursor.onsuccess = () => {
          const position = cursor.result
          if (!position) return
          transaction.objectStore(STORE).delete(position.primaryKey)
          position.continue()
        }
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB-fout.'))
        transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB is afgebroken.'))
      })
    },
  }
}

/** The draft under this key, or null: none, too old, damaged or storage that does not work. A bad one is removed. */
export async function loadDraft(storage: DraftStorage | null, key: string, form: FormDef, now: Date): Promise<Draft | null> {
  if (!storage) return null
  try {
    const record = (await storage.get(key)) as StoredDraft | null
    if (!record) return null
    const draft = parseDraft(record.draft, form, now)
    if (!draft) await storage.remove(key)
    return draft
  } catch {
    return null
  }
}

/** Keeps the draft; false when that did not work (the screen then says the draft is not being kept). */
export async function saveDraft(storage: DraftStorage | null, key: string, draft: Draft, now: Date): Promise<boolean> {
  if (!storage) return false
  try {
    const savedAt = now.toISOString()
    await storage.put({ key, savedAt, draft: { ...draft, savedAt } })
    return true
  } catch {
    return false
  }
}

export async function deleteDraft(storage: DraftStorage | null, key: string): Promise<void> {
  try {
    await storage?.remove(key)
  } catch {
    // Nothing to do: a draft that stays is purged after a week.
  }
}

/** Drafts that nobody touched for a week go, whichever appointment they were for. */
export async function purgeOldDrafts(storage: DraftStorage | null, now: Date): Promise<void> {
  try {
    await storage?.purgeBefore(new Date(now.getTime() - DRAFT_MAX_AGE_MS).toISOString())
  } catch {
    // See deleteDraft.
  }
}
