// 领域规则验证脚本：node scripts/verify-segment.mjs
// 用内存版 localStorage 驱动真实的拼装领域服务，逐条验证需求。
import { build } from 'vite'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'node_modules', '.verify-build')

await build({
  root,
  logLevel: 'silent',
  configFile: false,
  resolve: {
    alias: { '@': path.join(root, 'src') },
  },
  build: {
    outDir,
    emptyOutDir: true,
    lib: { entry: path.join(root, 'verify-entry.ts'), formats: ['es'], fileName: 'verify' },
    rollupOptions: { external: ['vue', 'vue-router', 'pinia'] },
  },
})

const store = new Map()
globalThis.window = {
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => void store.set(k, String(v)),
    removeItem: (k) => void store.delete(k),
  },
}

const mod = await import(path.join(outDir, 'verify.js'))
const {
  listSegmentRings,
  segmentStats,
  pendingReworkRings,
  createRing,
  saveRingProfile,
  startAssembly,
  submitAcceptance,
  registerRework,
  listAcceptanceRecords,
  listReworkOrders,
  resetSegmentAssembly,
  reloadStorage,
} = mod

let pass = 0
let fail = 0
function check(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`  ✔ ${name}`)
  } else {
    fail++
    console.log(`  �  ${name}${detail ? ` —— ${detail}` : ''}`)
  }
}
function byNo(no) {
  return listSegmentRings().find((r) => r.管片环号 === no)
}

// 全新库：首次读取应播种新种子（4 环）
let rings = listSegmentRings()
check('种子播种 4 个管片环', rings.length === 4, `实际 ${rings.length}`)
const stats0 = segmentStats()
const waiting = stats0.find((s) => s.label === '待拼装环数')?.value
const assembling = stats0.find((s) => s.label === '拼装中环数')?.value
const accepted = stats0.find((s) => s.label === '已验收环数')?.value
const rework = stats0.find((s) => s.label === '待返工环数')?.value
check('初始 待拼装=2', waiting === 2, `实际 ${waiting}`)
check('初始 拼装中=1', assembling === 1, `实际 ${assembling}`)
check('初始 已验收=1', accepted === 1, `实际 ${accepted}`)
check('初始 待返工=1（R-0104 挂单未验收）', rework === 1, `实际 ${rework}`)
check('待返工清单只去重出 R-0104', JSON.stringify(pendingReworkRings().map((r) => r.管片环号)) === '["R-0104"]')

// 保存前不回显：create 失败（缺字段）后列表不新增
const before = listSegmentRings().length
const bad = createRing({ 管片环号: 'R-9999', 管片型号: '', 拼装点位: '', 螺栓扭矩: '', 错台量: '', 拼装班组: '拼装一班', 拼装日期: '2026-10-01' })
check('缺字段登记失败', bad.ok === false, bad.message)
check('失败整笔退回、列表无新增', listSegmentRings().length === before)
const dup = createRing({ 管片环号: 'R-0101', 管片型号: 'X', 拼装点位: '1点位', 螺栓扭矩: '', 错台量: '', 拼装班组: '拼装一班', 拼装日期: '2026-10-01' })
check('重复管片环号被拒', dup.ok === false)

// 成功登记后才落库
const created = createRing({ 管片环号: 'R-0105', 管片型号: '标准环 B2', 拼装点位: '2点位', 螺栓扭矩: '', 错台量: '', 拼装班组: '拼装一班', 拼装日期: '2026-10-05' })
check('合法登记成功', created.ok === true, created.message)
const r0105 = byNo('R-0105')
check('新环落库为待拼装', !!r0105 && r0105.status === '待拼装')

// 跳着改驳回：待拼装直接提交验收
const skip = submitAcceptance(r0105.id, '拼装一班', '直接验收')
check('跳过开始拼装被驳回且说明缺步', skip.ok === false && skip.message.includes('开始拼装'), skip.message)
// 已验收环不能开始拼装
const r0103 = byNo('R-0103')
check('已验收不能再开始拼装', startAssembly(r0103.id, '拼装二班').ok === false)

// 跨班组：拼装二班改拼装一班的环
const cross = saveRingProfile(r0105.id, '拼装二班', { 拼装点位: '8点位' })
check('跨班组改拼装点位打回', cross.ok === false && cross.message.includes('无权'), cross.message)
check('打回后点位仍是旧值', byNo('R-0105').拼装点位 === '2点位')
// 本班组改点位成功
const ownEdit = saveRingProfile(r0105.id, '拼装一班', { 拼装点位: '6点位' })
check('本班组改点位成功', ownEdit.ok === true, ownEdit.message)
check('成功后点位已是新值', byNo('R-0105').拼装点位 === '6点位')

// 完整流转：开始拼装 → 缺扭矩/错台验收被拒 → 补齐 → 验收落一条
check('开始拼装成功', startAssembly(r0105.id, '拼装一班').ok === true)
check('重复开始拼装被友好拒绝', startAssembly(r0105.id, '拼装一班').ok === false)
const noTorque = submitAcceptance(r0105.id, '拼装一班', '合格')
check('螺栓扭矩/错台量未保存时验收驳回', noTorque.ok === false && noTorque.message.includes('螺栓扭矩'), noTorque.message)
saveRingProfile(r0105.id, '拼装一班', { 螺栓扭矩: '3.0', 错台量: '2' })
const a1 = submitAcceptance(r0105.id, '拼装一班', '复核合格')
check('第一次验收成功', a1.ok === true, a1.message)
const a2 = submitAcceptance(r0105.id, '拼装一班', '再点一次')
check('同一轮重复验收不落第二条', a2.ok === false, a2.message)
const accFor105 = listAcceptanceRecords().filter((x) => x.ringId === r0105.id)
check('验收记录只有 1 条', accFor105.length === 1, `实际 ${accFor105.length}`)
check('复核意见已挂到环上', byNo('R-0105').复核意见 === '复核合格')

// 登记返工：清空复核意见、退回待拼装、只出一张单
const w1 = registerRework(r0105.id, '拼装一班', '局部错台超差，重做')
check('登记返工成功', w1.ok === true, w1.message)
const afterRework = byNo('R-0105')
check('返工后退回待拼装', afterRework.status === '待拼装')
check('验收时中间复核意见已清空', afterRework.复核意见 === '')
const w2 = registerRework(r0105.id, '拼装一班', '又点一次')
check('连续第二次登记返工被挡', w2.ok === false, w2.message)
const ordersFor105 = listReworkOrders().filter((x) => x.ringId === r0105.id)
check('返工单只有 1 张', ordersFor105.length === 1, `实际 ${ordersFor105.length}`)
check('返工结论回写后，待返工清单包含 R-0105', pendingReworkRings().some((r) => r.管片环号 === 'R-0105'))

// 跨班组不能登记别人环的返工
check('跨班组登记返工打回', registerRework(r0105.id, '拼装三班', 'x').ok === false)

// 重新拼装并验收：第二轮验收一条，旧返工单关闭，待返工数回落
startAssembly(r0105.id, '拼装一班')
const a3 = submitAcceptance(r0105.id, '拼装一班', '返工整改后复验合格')
check('返工后重新验收成功（第二轮）', a3.ok === true, a3.message)
const accFor105b = listAcceptanceRecords().filter((x) => x.ringId === r0105.id)
check('第二轮验收累计 2 条、不重不丢', accFor105b.length === 2, `实际 ${accFor105b.length}`)
const closedOrders = listReworkOrders().filter((x) => x.ringId === r0105.id && x.closed)
check('返工单被新验收关闭', closedOrders.length === 1)
check('闭环后待返工清单不再含 R-0105', !pendingReworkRings().some((r) => r.管片环号 === 'R-0105'))

// 拼装中直接登记返工被驳回（缺验收）
const r0102 = byNo('R-0102')
check('拼装中登记返工被驳回且说明缺步', registerRework(r0102.id, '拼装一班', 'x').ok === false)

// ---- 同一份：刷新/重进（清模块内存 cache，保留 localStorage）后仍读到落库那份 ----
const persisted = JSON.parse(store.get('shield-tunnel-construction:entries'))
const p105 = persisted.segment.find((r) => r.管片环号 === 'R-0105')
check('localStorage 里 R-0105 为已验收', p105.status === '已验收' && p105.复核意见 === '返工整改后复验合格')
check('localStorage 里验收记录共 4 条（种子2+新增2）', persisted.segment_acceptance.length === 4, `实际 ${persisted.segment_acceptance.length}`)
check('localStorage 里返工单共 2 条（种子1+新增1）', persisted.segment_rework.length === 2, `实际 ${persisted.segment_rework.length}`)
// ---- 存量迁移：塞一版旧结构（无版本号 + 旧「已返工」态），按拼装日期重放 ----
resetSegmentAssembly()
store.delete('shield-tunnel-construction:segment-version')
const legacy = JSON.parse(store.get('shield-tunnel-construction:entries'))
legacy.segment = [
  { id: 1, status: '拼装中', pending: true, abnormal: false, 管片环号: 'L-02', 拼装点位: '1', 螺栓扭矩: '2.6', 错台量: '4', 拼装班组: '拼装二班', 拼装日期: '2026-09-02' },
  { id: 2, status: '已返工', pending: true, abnormal: true, 管片环号: 'L-01', 拼装点位: '2', 螺栓扭矩: '2.1', 错台量: '8', 拼装班组: '拼装二班', 拼装日期: '2026-09-01' },
  { id: 3, status: '已验收', pending: false, abnormal: false, 管片环号: 'L-03', 拼装点位: '3', 螺栓扭矩: '3.0', 错台量: '1', 拼装班组: '拼装二班', 拼装日期: '2026-09-03', 复核意见: '合格' },
]
delete legacy.segment_acceptance
delete legacy.segment_rework
store.set('shield-tunnel-construction:entries', JSON.stringify(legacy))

// 模拟「退出页面重新进入」：丢掉内存视图，强制从库重新装载后再触发迁移。
reloadStorage()
const migratedRings = listSegmentRings()
check('存量环数量不变（3）', migratedRings.length === 3)
check('旧「已返工」环退回待拼装', migratedRings.find((r) => r.管片环号 === 'L-01')?.status === '待拼装')
check('已验收环保留复核意见', migratedRings.find((r) => r.管片环号 === 'L-03')?.复核意见 === '合格')
check('已验收环补 1 条验收记录', listAcceptanceRecords().length === 1)
const legacyOrders = listReworkOrders()
check('旧已返工环补 1 张未闭环返工单', legacyOrders.length === 1 && legacyOrders[0].closed === false && legacyOrders[0].管片环号 === 'L-01')
check('迁移后待返工环数=1', segmentStats().find((s) => s.label === '待返工环数')?.value === 1)
check('版本号已写入', store.get('shield-tunnel-construction:segment-version') === '2')
// 按拼装日期重放顺序
check('按拼装日期升序重放', migratedRings.map((r) => r.管片环号).join(',') === 'L-01,L-02,L-03', migratedRings.map((r) => r.管片环号).join(','))

// ---- 写库失败就地撤销 ----
resetSegmentAssembly()
reloadStorage()
const goodWindow = globalThis.window
const idleTarget = listSegmentRings().find((r) => r.管片环号 === 'R-0101')
globalThis.window = {
  localStorage: {
    getItem: goodWindow.localStorage.getItem,
    setItem: (k, v) => {
      if (k === 'shield-tunnel-construction:entries') throw new Error('disk full')
      store.set(k, String(v))
    },
    removeItem: goodWindow.localStorage.removeItem,
  },
}
const failWrite = startAssembly(idleTarget.id, '拼装一班')
globalThis.window = goodWindow
check('写库失败返回失败', failWrite.ok === false && failWrite.message.includes('撤销'), failWrite.message)
check('写库失败后内存状态不变（仍待拼装）', byNo('R-0101').status === '待拼装')

console.log(`\n结果：${pass} 通过，${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
