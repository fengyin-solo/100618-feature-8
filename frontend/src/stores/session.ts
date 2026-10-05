import { defineStore } from 'pinia'

import { ASSEMBLY_CREWS, DEFAULT_ASSEMBLY_CREW, type AssemblyCrew } from '@/data/segment-assembly'

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    shiftLabel: '白班 08:00-20:00',
    scope: '盾构隧道掘进施工管理平台',
    // 当前登录的拼装班组：拼装点位只允许本环班组修改，跨班组操作一律打回。
    crew: DEFAULT_ASSEMBLY_CREW as AssemblyCrew,
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
    crewOptions: () => ASSEMBLY_CREWS as readonly AssemblyCrew[],
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setCrew(crew: AssemblyCrew) {
      this.crew = crew
    },
  },
})
