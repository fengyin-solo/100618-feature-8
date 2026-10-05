<template>
  <section class="page" data-module="segment">
    <header class="page-head">
      <div>
        <h2>管片拼装管理</h2>
        <p class="page-desc">{{ meta.desc }}</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记管片环</button>
        <button class="btn" type="button" @click="exportRows">导出管片拼装清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <div class="crew-bar">
      <label class="filter-item">
        <span>当前拼装班组</span>
        <select v-model="crew">
          <option v-for="option in crewOptions" :key="option" :value="option">{{ option }}</option>
        </select>
      </label>
      <span class="crew-hint">只有本拼装班组能改拼装点位，跨班组操作一律打回</span>
    </div>

    <form v-if="editing" class="edit-panel" @submit.prevent="saveDraft">
      <label v-for="field in editableFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="draft[field]" :placeholder="`填写${field}`" />
      </label>
      <div class="edit-actions">
        <button class="btn primary" type="submit">保存</button>
        <button class="btn ghost" type="button" @click="cancelEdit">取消</button>
      </div>
      <p class="edit-hint">保存成功才写进清单并回显；写库失败整笔退回，不会只落一半。</p>
    </form>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] || '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" :disabled="busy" @click="openEdit(row)">填报</button>
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              :disabled="busy"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无管片拼装数据，可先登记管片环</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条管片拼装记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="noticeMessage" class="notice-text">{{ noticeMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  moduleStats,
  runSegmentAction,
  saveSegmentEntry,
} from '@/api/local-service'
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

// 行列、动作、状态都从模块元数据取，和数据层是同一份，不再各抄一份。
const meta = moduleMeta('segment')
const columns = meta.fields
const actions = meta.actions
const statuses = meta.statuses
const editableFields = ["管片环号", "管片型号", "拼装点位", "螺栓扭矩", "错台量", "拼装日期", "复核意见", "返工结论"]

const session = useSessionStore()
const crew = computed({
  get: () => session.crew,
  set: (value: string) => session.setCrew(value),
})

const rows = ref<EntryRow[]>([])
const total = ref(0)
const stats = ref<{ label: string; value: number }[]>([])
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const busy = ref(false)

const editing = ref(false)
const draftId = ref<number | null>(null)
const draft = ref<Record<string, string>>({})

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const crewOptions = computed(() => {
  const owners = rows.value.map((row) => String(row['拼装班组'] ?? '')).filter((name) => name !== '')
  return [...new Set([session.crew, ...owners])]
})

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function blankDraft(): Record<string, string> {
  const values: Record<string, string> = {}
  for (const field of editableFields) {
    values[field] = ''
  }
  values['拼装日期'] = new Date().toISOString().slice(0, 10)
  return values
}

function openCreate() {
  errorMessage.value = ''
  noticeMessage.value = ''
  draftId.value = null
  draft.value = blankDraft()
  editing.value = true
}

function openEdit(row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  draftId.value = Number(row.id)
  const values: Record<string, string> = {}
  for (const field of editableFields) {
    values[field] = String(row[field] ?? '')
  }
  draft.value = values
  editing.value = true
}

function cancelEdit() {
  editing.value = false
  draftId.value = null
  draft.value = {}
}

function saveDraft() {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = saveSegmentEntry({
    id: draftId.value ?? undefined,
    crew: session.crew,
    ...draft.value,
  })
  if (!result.ok) {
    // 整笔退回：表单草稿留着，清单还是落库那份，不回显未保存的值。
    errorMessage.value = result.message
    return
  }
  cancelEdit()
  noticeMessage.value = result.message
  reload()
}

function runAction(action: string, row: EntryRow) {
  if (busy.value) {
    return
  }
  busy.value = true
  errorMessage.value = ''
  noticeMessage.value = ''
  try {
    const result = runSegmentAction(Number(row.id), action, { crew: session.crew })
    if (!result.ok) {
      errorMessage.value = result.message
      return
    }
    noticeMessage.value = result.message
  } finally {
    busy.value = false
    reload()
  }
}

function reload() {
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    stats.value = moduleStats(meta.key)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '管片拼装列表读取失败'
  }
}

onMounted(reload)
</script>
