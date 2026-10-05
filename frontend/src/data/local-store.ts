import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
// 读写纪律：localStorage 里那份是唯一准数——读永远读它，写先落库再算成功，
// 落库失败什么都不改（就地撤销），不允许内存里先变、库里还是旧的。
const STORAGE_KEY = 'shield-tunnel-construction:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function hasStorage(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.localStorage
  } catch {
    return false
  }
}

// 没有 localStorage 的环境（测试、SSR）退化成进程内内存，语义保持一致。
let memoryStore: Record<string, EntryRow[]> | null = null

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

export function allRows(): Record<string, EntryRow[]> {
  // 每次读都回落库那份：刷新、返回、重新进入看到的必然是同一份。
  if (hasStorage()) {
    return readStorage()
  }
  if (memoryStore === null) {
    memoryStore = clone(SEED_ROWS)
  }
  return memoryStore
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

// 整库一次落盘：多模块的改动拼成一份一起写，setItem 抛错就整体不生效，
// 调用方拿到的就是「整笔退回」，不会出现只落一半的中间态。
export function saveAll(next: Record<string, EntryRow[]>): void {
  if (hasStorage()) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    return
  }
  memoryStore = next
}

export function saveRows(key: string, rows: EntryRow[]): void {
  saveAll({ ...allRows(), [key]: rows })
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
