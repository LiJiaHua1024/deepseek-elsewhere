import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { DeletedMemoryPath, MemoryDreamRun, MemoryNote } from './types.js'

interface MemoryDB extends DBSchema {
  notes: { key: string; value: MemoryNote }
  meta: { key: string; value: unknown }
}

const DB_NAME = 'elsewhere-memory'
const DB_VERSION = 1

let dbPromise: Promise<IDBPDatabase<MemoryDB>> | null = null

const getDB = () => {
  if (!dbPromise) {
    dbPromise = openDB<MemoryDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('notes')) {
          db.createObjectStore('notes', { keyPath: 'path' })
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta')
        }
      },
      blocked() {},
      blocking() {
        void dbPromise?.then((db) => db.close()).catch(() => {})
        dbPromise = null
      },
      terminated() {
        dbPromise = null
      },
    }).catch((error: unknown) => {
      dbPromise = null
      throw error
    })
  }
  return dbPromise
}

export const memoryDbAvailable = () => typeof indexedDB !== 'undefined'

export const listMemoryNotes = async (): Promise<MemoryNote[]> => {
  if (!memoryDbAvailable()) {
    return []
  }
  const db = await getDB()
  return db.getAll('notes')
}

export const getMemoryNote = async (path: string): Promise<MemoryNote | undefined> => {
  if (!memoryDbAvailable()) {
    return undefined
  }
  const db = await getDB()
  return db.get('notes', path)
}

export const putMemoryNote = async (note: MemoryNote): Promise<void> => {
  if (!memoryDbAvailable()) {
    return
  }
  const db = await getDB()
  await db.put('notes', note)
}

export const putMemoryNotes = async (notes: readonly MemoryNote[]): Promise<void> => {
  if (!memoryDbAvailable() || notes.length === 0) {
    return
  }
  const db = await getDB()
  const tx = db.transaction('notes', 'readwrite')
  await Promise.all([...notes.map((note) => tx.store.put(note)), tx.done])
}

export const deleteMemoryNote = async (path: string): Promise<void> => {
  if (!memoryDbAvailable()) {
    return
  }
  const db = await getDB()
  await db.delete('notes', path)
}

export const clearMemoryNotes = async (): Promise<void> => {
  if (!memoryDbAvailable()) {
    return
  }
  const db = await getDB()
  await db.clear('notes')
}

export const getMemoryMeta = async <T>(key: string): Promise<T | undefined> => {
  if (!memoryDbAvailable()) {
    return undefined
  }
  const db = await getDB()
  return (await db.get('meta', key)) as T | undefined
}

export const setMemoryMeta = async (key: string, value: unknown): Promise<void> => {
  if (!memoryDbAvailable()) {
    return
  }
  const db = await getDB()
  await db.put('meta', value, key)
}

export const getDeletedMemoryPaths = () => getMemoryMeta<DeletedMemoryPath[]>('deletedPaths')
export const setDeletedMemoryPaths = (value: DeletedMemoryPath[]) =>
  setMemoryMeta('deletedPaths', value)
export const getDreamedSessions = () => getMemoryMeta<Record<string, number>>('dreamedSessions')
export const setDreamedSessions = (value: Record<string, number>) =>
  setMemoryMeta('dreamedSessions', value)
export const getLastDreamApplied = () => getMemoryMeta<MemoryDreamRun | null>('lastDreamApplied')
export const setLastDreamApplied = (value: MemoryDreamRun | null) =>
  setMemoryMeta('lastDreamApplied', value)
