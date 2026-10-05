/* 服务层行为冒烟测试：拼装记录的读写一致、状态机、权限、幂等、回写与迁移。 */
type Row = Record<string, unknown> & { id: number; status: string }

function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`ok  - ${msg}`)
  } else {
    console.error(`FAIL- ${msg}`)
    process.exitCode = 1
  }
}

async function main() {
  // localStorage 垫片：failWrites 打开时 setItem 抛错，模拟写库失败。
  const data = new Map<string, string>()
  let failWrites = false
  ;(globalThis as Record<string, unknown>).window = {
    localStorage: {
      getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
      setItem: (k: string, v: string) => {
        if (failWrites) throw new Error('QuotaExceededError: 存储已满')
        data.set(k, String(v))
      },
      removeItem: (k: string) => data.delete(k),
    },
  }

  const svc = await import('@/api/local-service')
  const store = await import('@/data/local-store')

  const seg = () => store.listRows('segment') as Row[]
  const prod = () => store.listRows('segmentprod') as Row[]
  const byRing = (ring: string) => seg().find((r) => r['管片环号'] === ring)!
  const idOf = (ring: string) => Number(byRing(ring).id)

  // A. 种子与迁移后的初始状态
  assert(seg().length === 3, 'A1 种子管片环 3 条')
  assert(
    seg().map((r) => r['拼装日期']).join(',') === '2026-09-01,2026-09-02,2026-09-03',
    'A2 存量按拼装日期排序',
  )
  assert(svc.segmentReworkCount() === 0, 'A3 初始待返工环数为 0')
  const prodStats = svc.moduleStats('segmentprod')
  assert(prodStats.find((s) => s.label === '待返工环数')!.value === 0, 'A4 管片生产页待返工环数同源为 0')

  // B. 保存原子性：成功才回显，失败整笔退回
  const save1 = svc.saveSegmentEntry({
    crew: '拼装一班',
    管片环号: 'R-1021',
    管片型号: 'Φ6.2m标准环',
    拼装点位: 'K3·9点位',
    螺栓扭矩: '3100N·m',
    错台量: '4mm',
    拼装日期: '2026-09-04',
  })
  assert(save1.ok, 'B1 新环保存成功')
  assert(byRing('R-1021')['螺栓扭矩'] === '3100N·m', 'B2 保存后读到的就是落库那份')
  assert(byRing('R-1021').status === '待拼装' && byRing('R-1021')['拼装班组'] === '拼装一班', 'B3 新环待拼装且归属当前班组')

  failWrites = true
  const saveFail = svc.saveSegmentEntry({ crew: '拼装一班', 管片环号: 'R-1022', 拼装日期: '2026-09-05' })
  failWrites = false
  assert(!saveFail.ok && saveFail.message.includes('整笔已退回'), 'B4 写库失败报整笔退回')
  assert(!seg().some((r) => r['管片环号'] === 'R-1022'), 'B5 写库失败不落半笔，清单读不到该环')

  const dup = svc.saveSegmentEntry({ crew: '拼装一班', 管片环号: 'R-1021', 拼装日期: '2026-09-06' })
  assert(!dup.ok && dup.message.includes('只落一条'), 'B6 同环号重复登记被驳回')
  assert(seg().filter((r) => r['管片环号'] === 'R-1021').length === 1, 'B7 反复提交也只入一条')

  // C. 班组权限
  const crossSave = svc.saveSegmentEntry({ id: idOf('R-1019'), crew: '拼装一班', 拼装点位: 'K9·9点位' })
  assert(!crossSave.ok && crossSave.message.includes('跨班组'), 'C1 跨班组改拼装点位被打回')
  assert(byRing('R-1019')['拼装点位'] === 'K5·3点位', 'C2 被打回后点位没动')
  const crossAction = svc.runSegmentAction(idOf('R-1019'), '开始拼装', { crew: '拼装一班' })
  assert(!crossAction.ok && crossAction.message.includes('跨班组'), 'C3 跨班组动作同样打回')
  const ownSave = svc.saveSegmentEntry({ id: idOf('R-1019'), crew: '拼装二班', 拼装点位: 'K5·5点位' })
  assert(ownSave.ok && byRing('R-1019')['拼装点位'] === 'K5·5点位', 'C4 本班组可改拼装点位')

  // D. 状态机顺序
  const jumpAccept = svc.runSegmentAction(idOf('R-1018'), '提交验收', { crew: '拼装一班' })
  assert(!jumpAccept.ok && jumpAccept.message.includes('缺「开始拼装」'), 'D1 待拼装直接验收被驳回并说明缺步')
  const jumpRework = svc.runSegmentAction(idOf('R-1018'), '登记返工', { crew: '拼装一班' })
  assert(!jumpRework.ok && jumpRework.message.includes('缺「开始拼装」') && jumpRework.message.includes('「提交验收」'), 'D2 待拼装直接返工被驳回并列出缺的两步')
  assert(svc.runSegmentAction(idOf('R-1018'), '开始拼装', { crew: '拼装一班' }).ok, 'D3 开始拼装放行')
  assert(byRing('R-1018').status === '拼装中' && byRing('R-1018')['拼装状态'] === '拼装中', 'D4 状态列与当前状态同一份')
  const accept = svc.runSegmentAction(idOf('R-1018'), '提交验收', { crew: '拼装一班', 复核意见: '复测合格' })
  assert(accept.ok && byRing('R-1018').status === '已验收' && byRing('R-1018')['复核意见'] === '复测合格', 'D5 提交验收落复核意见')
  const acceptAgain = svc.runSegmentAction(idOf('R-1018'), '提交验收', { crew: '拼装一班', 复核意见: '改成别的' })
  assert(acceptAgain.ok && acceptAgain.message.includes('只算一条'), 'D6 重复提交验收幂等放行')
  assert(seg().filter((r) => r['管片环号'] === 'R-1018').length === 1 && byRing('R-1018')['复核意见'] === '复测合格', 'D7 重复验收不多落记录、不改结论')
  const restart = svc.runSegmentAction(idOf('R-1018'), '开始拼装', { crew: '拼装一班' })
  assert(!restart.ok && restart.message.includes('登记返工'), 'D8 已验收不能直接重拼')

  // E. 登记返工：清中间结论、退回待拼装、回写出厂待办
  assert(byRing('R-1020')['复核意见'] !== '', 'E0 前置：R-1020 挂着验收复核意见')
  const rework = svc.runSegmentAction(idOf('R-1020'), '登记返工', { crew: '拼装一班', 返工结论: '错台量超限，退回重拼' })
  assert(rework.ok, 'E1 已验收环登记返工放行')
  const r1020 = byRing('R-1020')
  assert(r1020.status === '待拼装' && r1020['复核意见'] === '', 'E2 返工退回待拼装且中间复核意见清空')
  assert(r1020['返工结论'] === '错台量超限，退回重拼' && r1020.abnormal === true, 'E3 返工结论落库并标异常')
  const segm3 = prod().find((r) => r['管片编号'] === 'SEGM-0003')!
  assert(segm3.status === '待出厂' && segm3['返工结论'] === '错台量超限，退回重拼', 'E4 返工结论回写到管片生产出厂待办')
  assert(svc.segmentReworkCount() === 1, 'E5 待返工环数为 1')
  assert(
    svc.moduleStats('segmentprod').find((s) => s.label === '待返工环数')!.value === 1 &&
      svc.moduleStats('segment').find((s) => s.label === '返工环数')!.value === 1,
    'E6 两个页面读到的待返工环数是同一个数',
  )
  const reworkTwice = svc.runSegmentAction(idOf('R-1020'), '登记返工', { crew: '拼装一班' })
  assert(!reworkTwice.ok, 'E7 连点两次返工，第二次被驳回')
  assert(svc.segmentReworkCount() === 1 && prod().filter((r) => String(r['返工结论'] ?? '') !== '').length === 1, 'E8 不多出返工单')

  // E9. 返工后重新验收：回写摘掉
  svc.runSegmentAction(idOf('R-1020'), '开始拼装', { crew: '拼装一班' })
  const reaccept = svc.runSegmentAction(idOf('R-1020'), '提交验收', { crew: '拼装一班' })
  assert(reaccept.ok && byRing('R-1020')['返工结论'] === '', 'E9 重新验收后返工结论清空')
  const segm3After = prod().find((r) => r['管片编号'] === 'SEGM-0003')!
  assert(segm3After.status === '已出厂' && segm3After['返工结论'] === '', 'E10 出厂待办同步摘掉')
  assert(svc.segmentReworkCount() === 0, 'E11 待返工环数归零')

  // F. 动作写库失败就地撤销
  failWrites = true
  const failAccept = svc.runSegmentAction(idOf('R-1019'), '提交验收', { crew: '拼装二班' })
  failWrites = false
  assert(!failAccept.ok && failAccept.message.includes('就地撤销'), 'F1 动作写库失败报就地撤销')
  assert(byRing('R-1019').status === '拼装中', 'F2 失败后状态没动，读到的还是落库那份')

  // G. 读写同一份：内存里看到的必须等于 localStorage 里那份
  const persisted = JSON.parse(data.get('shield-tunnel-construction:entries')!) as { segment: Row[] }
  assert(JSON.stringify(persisted.segment) === JSON.stringify(seg()), 'G1 清单与落库字节级一致')

  // H. 存量迁移：乱序、重复环号、旧状态、挂着的复核意见
  const legacy: Row[] = [
    { id: 91, status: '已验收', pending: false, abnormal: false, 管片环号: 'R-2003', 管片型号: 'Φ6.2m标准环', 拼装点位: '', 螺栓扭矩: '', 错台量: '', 拼装班组: '拼装一班', 拼装日期: '2026-08-03', 复核意见: '合格', 返工结论: '', 拼装状态: '已验收' },
    { id: 90, status: '已返工', pending: true, abnormal: true, 管片环号: 'R-2001', 管片型号: 'Φ6.2m标准环', 拼装点位: '', 螺栓扭矩: '', 错台量: '', 拼装班组: '拼装一班', 拼装日期: '2026-08-01', 复核意见: '遗留意见', 返工结论: '', 拼装状态: '已返工' },
    { id: 92, status: '已验收', pending: false, abnormal: false, 管片环号: 'R-2001', 管片型号: 'Φ6.2m标准环', 拼装点位: '', 螺栓扭矩: '', 错台量: '', 拼装班组: '拼装一班', 拼装日期: '2026-08-02', 复核意见: '重复落的验收', 返工结论: '', 拼装状态: '已验收' },
    { id: 93, status: '拼装中', pending: true, abnormal: false, 管片环号: 'R-2002', 管片型号: 'Φ6.2m邻接块', 拼装点位: '', 螺栓扭矩: '', 错台量: '', 拼装班组: '拼装二班', 拼装日期: '2026-08-02', 复核意见: '没验收就挂了意见', 返工结论: '', 拼装状态: '拼装中' },
  ]
  store.saveAll({ ...store.allRows(), segment: legacy })
  svc.migrateSegmentRows()
  const migrated = seg()
  assert(migrated.length === 3, 'H1 重复环号只留一条')
  assert(migrated.map((r) => r['管片环号']).join(',') === 'R-2001,R-2002,R-2003', 'H2 存量按拼装日期重排')
  const m2001 = migrated.find((r) => r['管片环号'] === 'R-2001')!
  assert(m2001.status === '待拼装' && m2001['复核意见'] === '' && String(m2001['返工结论']).includes('历史返工'), 'H3 旧「已返工」退回待拼装、补返工结论、清复核意见')
  const m2002 = migrated.find((r) => r['管片环号'] === 'R-2002')!
  assert(m2002['复核意见'] === '' && m2002['拼装状态'] === '拼装中', 'H4 未验收环的中间结论清掉、状态列同步')
  assert(svc.segmentReworkCount() === 1, 'H5 迁移后待返工环数只算有结论的环')

  console.log(process.exitCode ? '\n有断言失败' : '\n全部通过')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
