import type { EntryRow } from './types'

// 管片拼装领域类型。所有读写都围绕同一份落库数据：
// 环、验收记录、返工单都收在既有 localStorage 键（见 local-store），
// 拼装页与管片生产页共用本文件的取数函数，差异口径只有一份。

// 拼装进度只在三态之间走：待拼装 → 拼装中 → 已验收；登记返工退回待拼装。
export const SEGMENT_STATUS = {
  waiting: '待拼装',
  assembling: '拼装中',
  accepted: '已验收',
} as const

export type SegmentStatus = (typeof SEGMENT_STATUS)[keyof typeof SEGMENT_STATUS]

// 拼装点位是安装位置概念，跨班组不许改；这里同时是会话里的可切换班组清单。
export const ASSEMBLY_CREWS = ['拼装一班', '拼装二班', '拼装三班'] as const
export type AssemblyCrew = (typeof ASSEMBLY_CREWS)[number]
export const DEFAULT_ASSEMBLY_CREW: AssemblyCrew = ASSEMBLY_CREWS[0]

// 环行：拼装状态字段就是通用 status；复核意见只在验收通过期间挂着，
// 一旦登记返工就清空，避免「中间结论还挂在页面上没清掉」。
export type SegmentRing = EntryRow & {
  status: SegmentStatus
  管片环号: string
  管片型号: string
  拼装点位: string
  螺栓扭矩: string
  错台量: string
  拼装班组: string
  拼装日期: string
  复核意见?: string
}

// 同一管片环重复提交验收只落一条：以「环 + 验收轮次」为天然幂等键，
// 每次返工后重新验收才开启下一轮。
export type AcceptanceRecord = EntryRow & {
  ringId: number
  round: number
  管片环号: string
  复核意见: string
  验收人: string
  验收日期: string
}

// 返工单：连续点两次「登记返工」也只出一张。
// closed 由下一次验收通过时翻成 true；返工单未关闭且环未验收，才算待返工。
export type ReworkOrder = EntryRow & {
  ringId: number
  round: number
  管片环号: string
  返工结论: string
  登记班组: string
  登记日期: string
  closed: boolean
}

export type SegmentDraft = {
  管片环号: string
  管片型号: string
  拼装点位: string
  螺栓扭矩: string
  错台量: string
  拼装班组: string
  拼装日期: string
}
