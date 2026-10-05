import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveAll, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

const SEGMENT_KEY = 'segment'
const SEGMENTPROD_KEY = 'segmentprod'

// 拼装进度只许按这个顺序往下走：待拼装 → 拼装中 → 已验收；登记返工退回待拼装。
const SEGMENT_FLOW = ['待拼装', '拼装中', '已验收'] as const
const SEGMENT_STEP_ACTIONS = ['开始拼装', '提交验收'] as const

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// ---------------------------------------------------------------------------
// 管片拼装：读写理成同一份
// ---------------------------------------------------------------------------

// 拼装记录可填报的字段；状态只走动作流转，不在这张表单里改。
const SEGMENT_EDITABLE_FIELDS = [
  '管片环号',
  '管片型号',
  '拼装点位',
  '螺栓扭矩',
  '错台量',
  '拼装日期',
  '复核意见',
  '返工结论',
] as const

export type SegmentEntryInput = {
  id?: number
  crew: string
} & Partial<Record<(typeof SEGMENT_EDITABLE_FIELDS)[number], string>>

function text(value: unknown): string {
  return String(value ?? '').trim()
}

function syncSegmentRow(row: EntryRow): EntryRow {
  // 行内「拼装状态」列与当前状态始终是同一份，不各说各话。
  const rework = text(row['返工结论'])
  return {
    ...row,
    pending: row.status !== '已验收',
    abnormal: rework !== '',
    拼装状态: row.status,
  }
}

function crewRejection(row: EntryRow, crew: string): string | null {
  const owner = text(row['拼装班组'])
  if (!crew || !owner || crew === owner) {
    return null
  }
  return `管片环 ${text(row['管片环号'])} 属于「${owner}」，只有本拼装班组能改拼装点位，跨班组操作一律打回（当前班组：${crew}）`
}

// 保存拼装填报：整笔一个事务，落库失败原样退回，页面在保存成功前看不到新值。
export function saveSegmentEntry(input: SegmentEntryInput): ActionResult {
  const store = allRows()
  const rows = store[SEGMENT_KEY] ?? []
  let next: EntryRow[]
  let ringLabel = ''

  if (input.id !== undefined && input.id !== null) {
    const index = rows.findIndex((row) => Number(row.id) === Number(input.id))
    if (index < 0) {
      return { ok: false, message: `没有找到编号为 ${input.id} 的管片环` }
    }
    const rejected = crewRejection(rows[index], input.crew)
    if (rejected) {
      return { ok: false, message: rejected }
    }
    const merged: EntryRow = { ...rows[index] }
    for (const field of SEGMENT_EDITABLE_FIELDS) {
      if (input[field] !== undefined) {
        merged[field] = text(input[field])
      }
    }
    ringLabel = text(merged['管片环号'])
    next = [...rows]
    next[index] = syncSegmentRow(merged)
  } else {
    const ring = text(input['管片环号'])
    if (!ring) {
      return { ok: false, message: '管片环号不能为空，保存整笔退回' }
    }
    if (rows.some((row) => text(row['管片环号']) === ring)) {
      return { ok: false, message: `管片环 ${ring} 已登记过，重复提交只落一条记录` }
    }
    const id = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
    ringLabel = ring
    const created: EntryRow = {
      id,
      status: '待拼装',
      pending: true,
      abnormal: false,
      管片环号: ring,
      管片型号: text(input['管片型号']),
      拼装点位: text(input['拼装点位']),
      螺栓扭矩: text(input['螺栓扭矩']),
      错台量: text(input['错台量']),
      拼装班组: input.crew,
      拼装日期: text(input['拼装日期']),
      复核意见: text(input['复核意见']),
      返工结论: text(input['返工结论']),
      拼装状态: '待拼装',
    }
    next = [...rows, syncSegmentRow(created)]
  }

  try {
    saveAll({ ...store, [SEGMENT_KEY]: next })
  } catch (error) {
    return {
      ok: false,
      message: `管片环 ${ringLabel} 写入本地库失败，整笔已退回：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  return { ok: true, message: `管片环 ${ringLabel} 已保存，清单以落库这份为准` }
}

// 从 current 到 target 在顺序流里还差哪几步，用来把「跳着改」说清楚。
function missingSteps(current: string, target: string): string[] {
  const from = SEGMENT_FLOW.indexOf(current as (typeof SEGMENT_FLOW)[number])
  const to = SEGMENT_FLOW.indexOf(target as (typeof SEGMENT_FLOW)[number])
  if (from < 0 || to < 0 || from >= to) {
    return []
  }
  return SEGMENT_STEP_ACTIONS.slice(from, to)
}

function stepRejection(row: EntryRow, action: string, target: string): ActionResult {
  const missing = missingSteps(String(row.status), target)
  const ring = text(row['管片环号'])
  if (missing.length > 0) {
    return {
      ok: false,
      message: `管片环 ${ring} 当前「${row.status}」，缺${missing.map((step) => `「${step}」`).join('、')}，不能${action}`,
    }
  }
  return {
    ok: false,
    message: `管片环 ${ring} 当前「${row.status}」，不能${action}`,
  }
}

// 返工结论回写管片生产的出厂待办：同型号已出厂/待出厂的管片退回待出厂并挂上结论。
// 与拼装记录同事务落库，要么一起成，要么一起退回。
function writeBackRework(prodRows: EntryRow[], ring: EntryRow, conclusion: string): EntryRow[] {
  const model = text(ring['管片型号'])
  return prodRows.map((prod) => {
    if (text(prod['管片型号']) !== model) {
      return prod
    }
    if (prod.status !== '已出厂' && prod.status !== '待出厂') {
      return prod
    }
    return {
      ...prod,
      status: '待出厂',
      pending: true,
      abnormal: true,
      返工结论: conclusion,
      生产状态: '待出厂',
    }
  })
}

// 重新验收通过后，把出厂待办里挂着的返工结论摘掉，管片回到已出厂。
function clearRework(prodRows: EntryRow[], ring: EntryRow): EntryRow[] {
  const model = text(ring['管片型号'])
  return prodRows.map((prod) => {
    if (text(prod['管片型号']) !== model || text(prod['返工结论']) === '') {
      return prod
    }
    return {
      ...prod,
      status: '已出厂',
      pending: false,
      abnormal: false,
      返工结论: '',
      生产状态: '已出厂',
    }
  })
}

export type SegmentActionPayload = {
  crew?: string
  复核意见?: string
  返工结论?: string
}

export function runSegmentAction(
  id: number,
  action: string,
  payload: SegmentActionPayload = {},
): ActionResult {
  const store = allRows()
  const rows = store[SEGMENT_KEY] ?? []
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的管片环` }
  }
  const row = rows[index]
  const ring = text(row['管片环号'])
  const rejected = crewRejection(row, text(payload.crew))
  if (rejected) {
    return { ok: false, message: rejected }
  }

  let updated: EntryRow
  let prodNext: EntryRow[] | null = null
  let message = ''

  if (action === '开始拼装') {
    if (row.status === '拼装中') {
      return { ok: false, message: `管片环 ${ring} 已经在「拼装中」，不用重复开始` }
    }
    if (row.status !== '待拼装') {
      return {
        ok: false,
        message: `管片环 ${ring} 已验收，要重拼请先「登记返工」退回待拼装`,
      }
    }
    updated = { ...row, status: '拼装中' }
    message = `管片环 ${ring} 已开始拼装`
  } else if (action === '提交验收') {
    if (row.status === '已验收') {
      // 幂等：同一管片环重复提交验收只落一条记录，连着点也不重复落。
      return { ok: true, message: `管片环 ${ring} 已落过验收记录，重复提交只算一条，不再落库` }
    }
    if (row.status !== '拼装中') {
      return stepRejection(row, action, '已验收')
    }
    updated = {
      ...row,
      status: '已验收',
      复核意见: text(payload['复核意见']) || text(row['复核意见']) || '验收合格，同意进入下道工序',
      返工结论: '',
    }
    prodNext = clearRework(store[SEGMENTPROD_KEY] ?? [], updated)
    message = `管片环 ${ring} 已验收`
  } else if (action === '登记返工') {
    if (row.status !== '已验收') {
      return stepRejection(row, action, '已验收')
    }
    const conclusion = text(payload['返工结论']) || text(row['返工结论']) || '验收复核不通过，退回重新拼装'
    updated = {
      ...row,
      status: '待拼装',
      复核意见: '',
      返工结论: conclusion,
    }
    prodNext = writeBackRework(store[SEGMENTPROD_KEY] ?? [], updated, conclusion)
    message = `管片环 ${ring} 已登记返工，验收结论已清空，退回待拼装`
  } else {
    return { ok: false, message: `管片环没有登记「${action}」这个动作` }
  }

  const next = [...rows]
  next[index] = syncSegmentRow(updated)
  const batch: Record<string, EntryRow[]> = { ...store, [SEGMENT_KEY]: next }
  if (prodNext) {
    batch[SEGMENTPROD_KEY] = prodNext
  }
  try {
    saveAll(batch)
  } catch (error) {
    return {
      ok: false,
      message: `管片环 ${ring} ${action}写库失败，已就地撤销：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  return { ok: true, message }
}

// 待返工环数只认拼装记录这一份（返工结论非空的环），两个页面共用同一个取数。
export function segmentReworkCount(): number {
  return listRows(SEGMENT_KEY).filter((row) => text(row['返工结论']) !== '').length
}

function metricValue(key: string, label: string, rows: EntryRow[]): number {
  if (key === SEGMENT_KEY) {
    if (label === '待拼装环数') {
      return rows.filter((row) => row.status === '待拼装').length
    }
    if (label === '已验收环数') {
      return rows.filter((row) => row.status === '已验收').length
    }
    if (label === '返工环数') {
      return segmentReworkCount()
    }
  }
  if (key === SEGMENTPROD_KEY && label === '待返工环数') {
    return segmentReworkCount()
  }
  const meta = moduleMeta(key)
  const matched = meta.statuses.find((status) => label.includes(status))
  if (matched) {
    return rows.filter((row) => row.status === matched).length
  }
  if (label.includes('异常')) {
    return rows.filter((row) => row.abnormal).length
  }
  return 0
}

// 统计卡与列表读同一份库，页面不再各自抄一份写死的数。
export function moduleStats(key: string): { label: string; value: number }[] {
  const meta = moduleMeta(key)
  const rows = listRows(key)
  return meta.metrics.map((label) => ({ label, value: metricValue(key, label, rows) }))
}

// ---------------------------------------------------------------------------
// 存量数据：按拼装日期重新过一遍
// ---------------------------------------------------------------------------

function normalizeSegmentRows(rows: EntryRow[]): { rows: EntryRow[]; changed: boolean } {
  let changed = false
  const sorted = [...rows].sort((a, b) => {
    const dateA = text(a['拼装日期'])
    const dateB = text(b['拼装日期'])
    if (dateA !== dateB) {
      return dateA < dateB ? -1 : 1
    }
    return Number(a.id) - Number(b.id)
  })
  const seen = new Set<string>()
  const migrated: EntryRow[] = []
  for (const row of sorted) {
    const ring = text(row['管片环号'])
    if (ring && seen.has(ring)) {
      // 同一管片环重复落的验收记录，只留先落库的那条。
      changed = true
      continue
    }
    seen.add(ring)
    let status = String(row.status)
    let conclusion = text(row['返工结论'])
    if (!(SEGMENT_FLOW as readonly string[]).includes(status)) {
      // 历史「已返工」等旧态一律退回待拼装，结论保留或补一条。
      if (status === '已返工' && !conclusion) {
        conclusion = '历史返工退回，待重新拼装'
      }
      status = '待拼装'
    }
    const normalized = syncSegmentRow({
      ...row,
      status,
      复核意见: status === '已验收' ? text(row['复核意见']) : '',
      返工结论: conclusion,
    })
    if (JSON.stringify(normalized) !== JSON.stringify(row)) {
      changed = true
    }
    migrated.push(normalized)
  }
  if (sorted.length !== rows.length) {
    changed = true
  }
  return { rows: migrated, changed }
}

function normalizeSegmentprodRows(rows: EntryRow[]): { rows: EntryRow[]; changed: boolean } {
  let changed = false
  const migrated = rows.map((row) => {
    const normalized: EntryRow = {
      ...row,
      返工结论: text(row['返工结论']),
      生产状态: row.status,
    }
    if (JSON.stringify(normalized) !== JSON.stringify(row)) {
      changed = true
    }
    return normalized
  })
  return { rows: migrated, changed }
}

// 模块加载时把存量管片环按拼装日期重新过一遍：排序、去重、清掉挂着的中间结论。
// 幂等，重复跑结果不变。
export function migrateSegmentRows(): void {
  const store = allRows()
  const segment = normalizeSegmentRows(store[SEGMENT_KEY] ?? [])
  const segmentprod = normalizeSegmentprodRows(store[SEGMENTPROD_KEY] ?? [])
  if (!segment.changed && !segmentprod.changed) {
    return
  }
  try {
    saveAll({ ...store, [SEGMENT_KEY]: segment.rows, [SEGMENTPROD_KEY]: segmentprod.rows })
  } catch {
    // 迁移写不进去就保持原样，下次读取时再试，不覆盖落库那份。
  }
}

migrateSegmentRows()

// ---------------------------------------------------------------------------
// 通用流转（其余模块沿用）
// ---------------------------------------------------------------------------

export function runAction(key: string, id: number, action: string): ActionResult {
  if (key === SEGMENT_KEY) {
    return runSegmentAction(id, action)
  }
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  try {
    saveRows(key, next)
  } catch (error) {
    return {
      ok: false,
      message: `${meta.entity}${action}写库失败，已就地撤销：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
