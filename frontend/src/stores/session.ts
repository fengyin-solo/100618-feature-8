import { defineStore } from 'pinia'

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    shiftLabel: '白班 08:00-20:00',
    scope: '盾构隧道掘进施工管理平台',
    // 当前值班的拼装班组：拼装记录的填报与流转都按这个班组校验。
    crew: '拼装一班',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setCrew(crew: string) {
      this.crew = crew
    },
  },
})
