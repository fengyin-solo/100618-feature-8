import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'shield-tunnel-construction:entries'
// 与 segment-service 的迁移版本保持一致：种子即当前口径，首次播种直接标记。
const SEGMENT_SCHEMA_VERSION_KEY = 'shield-tunnel-construction:segment-version'
const SEGMENT_SCHEMA_VERSION = '2'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    // 首次播种整份落库（含以后新增的派生表），避免只在内存里补表、刷新后丢失。
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    // 种子自带的就是当前拼装口径，直接标版本，别再触发存量重放覆盖派生表。
    window.localStorage.setItem(SEGMENT_SCHEMA_VERSION_KEY, SEGMENT_SCHEMA_VERSION)
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    const merged = { ...fallback, ...parsed }
    // 库里缺的种子表（旧版本库）补齐后同样落库，保证读到的表都是同一份。
    const missingKey = Object.keys(fallback).some((key) => !(key in parsed))
    if (missingKey) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged))
    }
    return merged
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  commitRows({ ...allRows(), [key]: rows })
}

// 丢弃内存视图，下次读取重新从 localStorage 装载：用于模拟「退出页面重新进入」。
export function reloadStorage(): Record<string, EntryRow[]> {
  cache = null
  return allRows()
}

// 原子提交：先整表克隆序列化，序列化/写库任何一步失败都直接抛出，
// 内存 cache 维持原内容不动 —— 调用方拿到的永远是「整笔成功」或「整笔还在」。
export function commitRows(next: Record<string, EntryRow[]>): void {
  const snapshot = cache
  const serialized = JSON.stringify(next)
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, serialized)
  }
  // 写库成功后才切换内存视图；下面这步只可能是内存赋值异常，用旧快照兜底。
  try {
    cache = next
  } catch {
    cache = snapshot
    throw new Error('本地数据更新失败，已整笔撤销')
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
