import { filterRows } from '@/api/filter'
import { allRows, commitRows, listRows } from '@/data/local-store'
import { SEED_ROWS } from '@/data/seed'
import {
  ASSEMBLY_CREWS,
  DEFAULT_ASSEMBLY_CREW,
  SEGMENT_STATUS,
  type AcceptanceRecord,
  type AssemblyCrew,
  type ReworkOrder,
  type SegmentDraft,
  type SegmentRing,
} from '@/data/segment-assembly'
import type { EntryRow } from '@/data/types'

// 管片拼装领域服务：拼装页与管片生产页的唯一读写口径。
// 数据仍落在既有 localStorage 键、既有内存 cache（local-store），沿用既有读取方式；
// 本文件只在同一份数据上加领域规则，任何页面不得另算一套。

const RING_KEY = 'segment'
const ACCEPTANCE_KEY = 'segment_acceptance'
const REWORK_KEY = 'segment_rework'
// 存量重放版本：版本号一升就按拼装日期把旧拼装记录重过一遍。
const SCHEMA_VERSION = '2'
const VERSION_KEY = 'shield-tunnel-construction:segment-version'

export type DomainResult<T = undefined> =
  | { ok: true; message: string; data: T }
  | { ok: false; message: string }

// ---- 读取：两处页面共用这些 selector，差异口径只有这一份 ----

function rings(): SegmentRing[] {
  return listRows(RING_KEY) as SegmentRing[]
}
function acceptances(): AcceptanceRecord[] {
  return listRows(ACCEPTANCE_KEY) as AcceptanceRecord[]
}
function reworkOrders(): ReworkOrder[] {
  return listRows(REWORK_KEY) as ReworkOrder[]
}

export function listSegmentRings(filters: Record<string, string> = {}): SegmentRing[] {
  ensureMigrated()
  return filterRows(rings(), filters) as SegmentRing[]
}

export function listAcceptanceRecords(): AcceptanceRecord[] {
  ensureMigrated()
  return acceptances()
}

export function listReworkOrders(): ReworkOrder[] {
  ensureMigrated()
  return reworkOrders()
}

export type SegmentStat = { label: string; value: number }

export function segmentStatusSummary(): { status: string; count: number }[] {
  ensureMigrated()
  const rows = rings()
  return [
    SEGMENT_STATUS.waiting,
    SEGMENT_STATUS.assembling,
    SEGMENT_STATUS.accepted,
  ].map((status) => ({ status, count: rows.filter((row) => row.status === status).length }))
}

export function segmentStats(): SegmentStat[] {
  ensureMigrated()
  const rows = rings()
  return [
    { label: '待拼装环数', value: rows.filter((row) => row.status === SEGMENT_STATUS.waiting).length },
    { label: '拼装中环数', value: rows.filter((row) => row.status === SEGMENT_STATUS.assembling).length },
    { label: '已验收环数', value: rows.filter((row) => row.status === SEGMENT_STATUS.accepted).length },
    // 返工环数与管片生产页出厂待办共用同一个 selector，永远不会出现两个数。
    { label: '待返工环数', value: pendingReworkRings().length },
  ]
}

export type PendingReworkRing = {
  ringId: number
  管片环号: string
  返工结论: string
  登记日期: string
  拼装班组: string
}

// 待返工环数口径（由我拍板，两处沿用）：
// 去重后的「挂着未关闭返工单、且管片环尚未重新验收」的环；
// 重新验收通过即关闭返工单，该环立刻从待返工清单消失。
export function pendingReworkRings(): PendingReworkRing[] {
  ensureMigrated()
  const rows = rings()
  const open = reworkOrders().filter((order) => !order.closed)
  const seen = new Set<number>()
  const result: PendingReworkRing[] = []
  for (const order of open) {
    const ring = rows.find((item) => Number(item.id) === Number(order.ringId))
    if (!ring || ring.status === SEGMENT_STATUS.accepted || seen.has(Number(order.ringId))) {
      continue
    }
    seen.add(Number(order.ringId))
    result.push({
      ringId: Number(order.ringId),
      管片环号: ring.管片环号,
      返工结论: order.返工结论,
      登记日期: order.登记日期,
      拼装班组: ring.拼装班组,
    })
  }
  return result
}

// ---- 写入：先校验、再整表序列化落库，库不成功内存不动 ----

const inflight = new Set<string>()

// 连续点两次：第一笔还在提交时，第二笔直接挡下；第一笔落库后，第二笔再由幂等判断挡下。
function once<T>(token: string, fn: () => DomainResult<T>): DomainResult<T> {
  if (inflight.has(token)) {
    return { ok: false, message: '该操作正在提交，请勿重复点击' }
  }
  inflight.add(token)
  try {
    return fn()
  } finally {
    inflight.delete(token)
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function nonEmpty(value: unknown, label: string): string | null {
  return String(value ?? '').trim() === '' ? label : null
}

// 整笔提交：环、验收记录、返工单一起进库，任何一处写失败都整体撤销，绝不只落一半。
function commit(
  nextRings: SegmentRing[],
  nextAcceptances: AcceptanceRecord[],
  nextRework: ReworkOrder[],
): DomainResult {
  try {
    commitRows({ ...allRows(), [RING_KEY]: nextRings, [ACCEPTANCE_KEY]: nextAcceptances, [REWORK_KEY]: nextRework })
    return { ok: true, message: '', data: undefined }
  } catch {
    // commitRows 在写库失败时不会替换内存 cache，这里读到的仍是旧的落库那份。
    return { ok: false, message: '写库失败，已整笔撤销，页面数据保持上一次保存结果' }
  }
}

function findRing(rows: SegmentRing[], id: number): SegmentRing | undefined {
  return rows.find((row) => Number(row.id) === id)
}

// 登记新环：成功前只是页面草稿，不进 store、不回显；成功后整笔落库再重读。
export function createRing(draft: SegmentDraft): DomainResult<{ id: number }> {
  ensureMigrated()
  return once('create-ring', () => {
    const missing = [
      nonEmpty(draft.管片环号, '管片环号'),
      nonEmpty(draft.管片型号, '管片型号'),
      nonEmpty(draft.拼装点位, '拼装点位'),
      nonEmpty(draft.拼装日期, '拼装日期'),
    ].filter((item): item is string => item !== null)
    if (missing.length) {
      return { ok: false, message: `以下内容未填写，整笔未保存：${missing.join('、')}` }
    }
    const crew = (ASSEMBLY_CREWS as readonly string[]).includes(draft.拼装班组)
      ? draft.拼装班组
      : DEFAULT_ASSEMBLY_CREW
    const rows = rings()
    if (rows.some((row) => row.管片环号 === draft.管片环号.trim())) {
      return { ok: false, message: `管片环号「${draft.管片环号.trim()}」已存在，不能重复登记` }
    }
    const id = rows.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
    const row: SegmentRing = {
      id,
      status: SEGMENT_STATUS.waiting,
      pending: true,
      abnormal: false,
      管片环号: draft.管片环号.trim(),
      管片型号: draft.管片型号.trim(),
      拼装点位: draft.拼装点位.trim(),
      // 螺栓扭矩、错台量允许待拼装阶段先空着，进拼装后补齐才能提交验收。
      螺栓扭矩: draft.螺栓扭矩.trim(),
      错台量: draft.错台量.trim(),
      拼装班组: crew,
      拼装日期: draft.拼装日期.trim(),
      复核意见: '',
    }
    const result = commit([...rows, row], acceptances(), reworkOrders())
    return result.ok ? { ok: true, message: `管片环 ${row.管片环号} 已登记`, data: { id } } : result
  })
}

// 保存环面数据（拼装点位、螺栓扭矩、错台量等）。
// 保存成功前调用方只持有草稿；拼装点位只有本环拼装班组能改，跨班组一律打回。
export function saveRingProfile(
  id: number,
  operatorCrew: AssemblyCrew,
  draft: Partial<SegmentDraft>,
): DomainResult {
  ensureMigrated()
  return once(`save-ring:${id}`, () => {
    const rows = rings()
    const current = findRing(rows, id)
    if (!current) {
      return { ok: false, message: `没有找到编号为 ${id} 的管片环` }
    }
    const nextPoint = String(draft.拼装点位 ?? current.拼装点位).trim()
    if (nonEmpty(nextPoint, '拼装点位')) {
      return { ok: false, message: '拼装点位不能为空，整笔未保存' }
    }
    if (nextPoint !== current.拼装点位 && current.拼装班组 !== operatorCrew) {
      return {
        ok: false,
        message: `只有本拼装班组（${current.拼装班组}）能改拼装点位，当前班组「${operatorCrew}」无权操作，已打回`,
      }
    }
    const updated: SegmentRing = {
      ...current,
      管片型号: String(draft.管片型号 ?? current.管片型号).trim(),
      拼装点位: nextPoint,
      螺栓扭矩: String(draft.螺栓扭矩 ?? current.螺栓扭矩).trim(),
      错台量: String(draft.错台量 ?? current.错台量).trim(),
      拼装日期: String(draft.拼装日期 ?? current.拼装日期).trim(),
    }
    const nextRows = rows.map((row) => (Number(row.id) === id ? updated : row))
    const result = commit(nextRows, acceptances(), reworkOrders())
    return result.ok ? { ok: true, message: `管片环 ${current.管片环号} 的拼装记录已保存`, data: undefined } : result
  })
}

// 开始拼装：待拼装 → 拼装中，跳着改一律驳回并指明缺了哪一步。
export function startAssembly(id: number, operatorCrew: AssemblyCrew): DomainResult {
  ensureMigrated()
  return once(`start:${id}`, () => {
    const rows = rings()
    const current = findRing(rows, id)
    if (!current) {
      return { ok: false, message: `没有找到编号为 ${id} 的管片环` }
    }
    if (current.拼装班组 !== operatorCrew) {
      return { ok: false, message: `只有本拼装班组（${current.拼装班组}）能操作本环，当前班组「${operatorCrew}」已被打回` }
    }
    if (current.status === SEGMENT_STATUS.assembling) {
      return { ok: false, message: `管片环 ${current.管片环号} 已在拼装中，无需重复开始` }
    }
    if (current.status === SEGMENT_STATUS.accepted) {
      return { ok: false, message: `管片环 ${current.管片环号} 已验收，不能再开始拼装` }
    }
    const updated: SegmentRing = { ...current, status: SEGMENT_STATUS.assembling, pending: true }
    const result = commit(rows.map((row) => (Number(row.id) === id ? updated : row)), acceptances(), reworkOrders())
    return result.ok ? { ok: true, message: `管片环 ${current.管片环号} 已开始拼装`, data: undefined } : result
  })
}

// 提交验收：拼装中 → 已验收。同一环同一轮次重复提交只落一条验收记录。
export function submitAcceptance(id: number, operatorCrew: AssemblyCrew, opinion: string): DomainResult {
  ensureMigrated()
  return once(`accept:${id}`, () => {
    const rows = rings()
    const current = findRing(rows, id)
    if (!current) {
      return { ok: false, message: `没有找到编号为 ${id} 的管片环` }
    }
    if (current.拼装班组 !== operatorCrew) {
      return { ok: false, message: `只有本拼装班组（${current.拼装班组}）能提交本环验收，当前班组「${operatorCrew}」已被打回` }
    }
    // 说明缺了哪一步。
    if (current.status === SEGMENT_STATUS.waiting) {
      return { ok: false, message: `管片环 ${current.管片环号} 还在待拼装，缺了「开始拼装（拼装中）」这一步，不能提交验收` }
    }
    if (current.status === SEGMENT_STATUS.accepted) {
      return { ok: false, message: `管片环 ${current.管片环号} 本的验收记录已存在，重复提交不再落第二条` }
    }
    const missing = [
      nonEmpty(current.螺栓扭矩, '螺栓扭矩'),
      nonEmpty(current.错台量, '错台量'),
    ].filter((item): item is string => item !== null)
    if (missing.length) {
      return { ok: false, message: `${missing.join('、')}还没保存落库，整笔未提交；请先补齐再验收` }
    }
    if (nonEmpty(opinion, '复核意见')) {
      return { ok: false, message: '复核意见未填写，验收整笔未提交' }
    }

    const acceptanceList = acceptances()
    const reworkList = reworkOrders()
    // 每轮验收只一条：轮次 = 该环已有验收条数 + 1（返工后重新验收进入下一轮）。
    const round = acceptanceList.filter((item) => Number(item.ringId) === id).length + 1
    const recordId = acceptanceList.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
    const record: AcceptanceRecord = {
      id: recordId,
      status: SEGMENT_STATUS.accepted,
      pending: false,
      abnormal: false,
      ringId: id,
      round,
      管片环号: current.管片环号,
      复核意见: opinion.trim(),
      验收人: operatorCrew,
      验收日期: today(),
    }
    // 验收通过即关闭这一轮挂着的返工单，待返工环数随之下降。
    const nextRework = reworkList.map((order) =>
      Number(order.ringId) === id && !order.closed ? { ...order, closed: true, status: '已闭环', pending: false, abnormal: false } : order,
    )
    const updated: SegmentRing = {
      ...current,
      status: SEGMENT_STATUS.accepted,
      pending: false,
      abnormal: false,
      复核意见: opinion.trim(),
    }
    const result = commit(
      rows.map((row) => (Number(row.id) === id ? updated : row)),
      [...acceptanceList, record],
      nextRework,
    )
    return result.ok
      ? { ok: true, message: `管片环 ${current.管片环号} 第 ${round} 轮验收已落库（只此一条）`, data: undefined }
      : result
  })
}

// 登记返工：已验收 → 待拼装。清掉验收时的中间复核结论，只开一张返工单。
export function registerRework(id: number, operatorCrew: AssemblyCrew, conclusion: string): DomainResult {
  ensureMigrated()
  return once(`rework:${id}`, () => {
    const rows = rings()
    const current = findRing(rows, id)
    if (!current) {
      return { ok: false, message: `没有找到编号为 ${id} 的管片环` }
    }
    if (current.拼装班组 !== operatorCrew) {
      return { ok: false, message: `只有本拼装班组（${current.拼装班组}）能登记本环返工，当前班组「${operatorCrew}」已被打回` }
    }
    if (current.status === SEGMENT_STATUS.waiting) {
      return { ok: false, message: `管片环 ${current.管片环号} 还在待拼装，缺了「开始拼装」「提交验收」两步，不能登记返工` }
    }
    if (current.status === SEGMENT_STATUS.assembling) {
      return { ok: false, message: `管片环 ${current.管片环号} 还在拼装中，缺了「提交验收（已验收）」这一步，不能登记返工` }
    }
    const reworkList = reworkOrders()
    if (reworkList.some((order) => Number(order.ringId) === id && !order.closed)) {
      return { ok: false, message: `管片环 ${current.管片环号} 的返工单已开出且未闭环，重复登记不会再出第二张` }
    }
    if (nonEmpty(conclusion, '返工结论')) {
      return { ok: false, message: '返工结论未填写，返工单整笔未登记' }
    }

    const acceptanceList = acceptances()
    // 返工单跟随最近一轮验收。
    const round = acceptanceList.filter((item) => Number(item.ringId) === id).length
    if (round === 0) {
      return { ok: false, message: `管片环 ${current.管片环号} 没有验收记录，无法登记返工` }
    }
    const orderId = reworkList.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
    const order: ReworkOrder = {
      id: orderId,
      status: '待返工',
      pending: true,
      abnormal: true,
      ringId: id,
      round,
      管片环号: current.管片环号,
      返工结论: conclusion.trim(),
      登记班组: operatorCrew,
      登记日期: today(),
      closed: false,
    }
    const updated: SegmentRing = {
      ...current,
      status: SEGMENT_STATUS.waiting,
      pending: true,
      abnormal: true,
      // 验收时的中间结论必须清掉，页面不再挂着旧意见。
      复核意见: '',
    }
    const result = commit(
      rows.map((row) => (Number(row.id) === id ? updated : row)),
      acceptanceList,
      [...reworkList, order],
    )
    return result.ok
      ? { ok: true, message: `管片环 ${current.管片环号} 已退回待拼装，返工结论已回写管片生产出厂待办`, data: undefined }
      : result
  })
}

// 回到示例数据：环、验收、返工三张表一起回，不留半截派生数据。
export function resetSegmentAssembly(): void {
  commitRows({
    ...allRows(),
    [RING_KEY]: JSON.parse(JSON.stringify(SEED_ROWS[RING_KEY] ?? [])) as EntryRow[],
    [ACCEPTANCE_KEY]: JSON.parse(JSON.stringify(SEED_ROWS[ACCEPTANCE_KEY] ?? [])) as EntryRow[],
    [REWORK_KEY]: JSON.parse(JSON.stringify(SEED_ROWS[REWORK_KEY] ?? [])) as EntryRow[],
  })
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(VERSION_KEY, SCHEMA_VERSION)
  }
}

// ---- 存量迁移：旧记录按拼装日期重新过一遍，重建同一份派生数据 ----

// 始终以版本键为准：外部（刷新、清版本重放等）重置存储后，再次进入能重新迁移。
export function ensureMigrated(): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  // 先读一次全量数据：空库时这一步会完成种子播种并写好当前版本号，
  // 必须在版本判断之前，否则会把种子当存量重放，覆盖种子自带的验收/返工表。
  allRows()
  if (window.localStorage.getItem(VERSION_KEY) === SCHEMA_VERSION) {
    return
  }

  // 旧版状态口径里有「已返工」，新版三态里没有，统一退回待拼装并补开返工单。
  const legacyStatus: Record<string, string> = { 已返工: SEGMENT_STATUS.waiting }
  const sourceRings = rings() as SegmentRing[]
  const replayedRings: SegmentRing[] = []
  const replayedAcceptance: AcceptanceRecord[] = []
  const replayedRework: ReworkOrder[] = []

  // 按拼装日期重新过一遍（日期相同按原编号，保持稳定顺序）。
  const ordered = [...sourceRings].sort((a, b) => {
    const da = String(a.拼装日期 ?? '')
    const db = String(b.拼装日期 ?? '')
    return da === db ? Number(a.id) - Number(b.id) : da < db ? -1 : 1
  })

  for (const ring of ordered) {
    const crew = (ASSEMBLY_CREWS as readonly string[]).includes(String(ring.拼装班组))
      ? (ring.拼装班组 as AssemblyCrew)
      : DEFAULT_ASSEMBLY_CREW
    const wasReworked = String(ring.status) === '已返工'
    const normalizedStatus =
      String(ring.status) === SEGMENT_STATUS.assembling || String(ring.status) === SEGMENT_STATUS.accepted
        ? (String(ring.status) as SegmentRing['status'])
        : (legacyStatus[String(ring.status)] as SegmentRing['status'] | undefined) ?? SEGMENT_STATUS.waiting

    const normalized: SegmentRing = {
      ...ring,
      status: normalizedStatus,
      拼装班组: crew,
      // 中间复核意见只在验收通过期间保留，重放时非已验收一律清空。
      复核意见: normalizedStatus === SEGMENT_STATUS.accepted ? String(ring.复核意见 ?? '') : '',
      pending: normalizedStatus !== SEGMENT_STATUS.accepted,
      abnormal: wasReworked,
    }
    replayedRings.push(normalized)

    if (normalizedStatus === SEGMENT_STATUS.accepted) {
      replayedAcceptance.push({
        id: replayedAcceptance.length + 1,
        status: SEGMENT_STATUS.accepted,
        pending: false,
        abnormal: false,
        ringId: Number(ring.id),
        round: 1,
        管片环号: String(ring.管片环号 ?? ''),
        复核意见: String(ring.复核意见 ?? '存量数据补录验收合格'),
        验收人: crew,
        验收日期: String(ring.拼装日期 ?? today()),
      })
    }
    if (wasReworked) {
      replayedRework.push({
        id: replayedRework.length + 1,
        status: '待返工',
        pending: true,
        abnormal: true,
        ringId: Number(ring.id),
        round: 1,
        管片环号: String(ring.管片环号 ?? ''),
        返工结论: '存量数据迁移：原「已返工」环退回待拼装，待重新处理',
        登记班组: crew,
        登记日期: String(ring.拼装日期 ?? today()),
        closed: false,
      })
    }
  }

  try {
    commitRows({
      ...allRows(),
      [RING_KEY]: replayedRings as EntryRow[],
      [ACCEPTANCE_KEY]: replayedAcceptance as EntryRow[],
      [REWORK_KEY]: replayedRework as EntryRow[],
    })
    if (window.localStorage) {
      window.localStorage.setItem(VERSION_KEY, SCHEMA_VERSION)
    }
  } catch {
    // 写库失败：内存与库都保持旧内容，下次进入再重放，绝不半迁移。
  }
}
